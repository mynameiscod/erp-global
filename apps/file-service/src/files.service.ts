import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { Schema, type Connection } from 'mongoose';
import { z } from 'zod';
import { EventTypes } from '@erp/contracts';
import { OutboxWriter } from '@erp/events';
import {
  AppError,
  baseEnvSchema,
  loadEnv,
  MONGO_CONNECTION,
  TENANT_DATABASES,
} from '@erp/service-kit';
import {
  requireContext,
  requireTenantId,
  runAsTenant,
  tenantPlugin,
  type ModelDef,
  type TenantDatabases,
} from '@erp/tenancy';
import { FILE_STORAGE, type FileStorage } from './storage';

export const fileEnvSchema = baseEnvSchema.extend({
  STORAGE_DRIVER: z.enum(['s3', 'memory']).default('s3'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('erp-files'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  MAX_UPLOAD_MB: z.coerce.number().min(1).max(100).default(25),
  /** Signs download links. Defaults to a key derived from INTERNAL_SECRET. */
  FILE_URL_SECRET: z.string().min(32).optional(),
});
export type FileEnv = z.infer<typeof fileEnvSchema>;
export const FILE_ENV = Symbol('FILE_ENV');
export const loadFileEnv = () => loadEnv(fileEnvSchema);

/** Accepted uploads. Anything else is refused. */
const ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
/** Only these may be shown in the browser; everything else downloads as an attachment. */
const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);
const LINK_TTL_SECONDS = 300;

export interface FileDoc {
  _id: string;
  tenantId: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
  storageKey: string;
  uploadedBy: string;
  createdAt: Date;
}

const fileSchema = new Schema<FileDoc>(
  {
    _id: { type: String },
    name: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    sha256: { type: String, required: true },
    storageKey: { type: String, required: true },
    uploadedBy: { type: String, required: true },
  },
  { collection: 'files', timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
fileSchema.plugin(tenantPlugin);
fileSchema.index({ tenantId: 1, createdAt: -1 });

const FileModel: ModelDef<FileDoc> = { name: 'File', schema: fileSchema };

/** Checks the first bytes so a renamed executable cannot pose as an image or PDF. */
function magicMatches(contentType: string, buf: Buffer): boolean {
  const starts = (...bytes: number[]) => bytes.every((b, i) => buf[i] === b);
  switch (contentType) {
    case 'image/png':
      return starts(0x89, 0x50, 0x4e, 0x47);
    case 'image/jpeg':
      return starts(0xff, 0xd8, 0xff);
    case 'image/gif':
      return starts(0x47, 0x49, 0x46, 0x38);
    case 'image/webp':
      return starts(0x52, 0x49, 0x46, 0x46) && buf.subarray(8, 12).toString() === 'WEBP';
    case 'application/pdf':
      return starts(0x25, 0x50, 0x44, 0x46);
    default:
      return true;
  }
}

function safeName(name: string): string {
  const cleaned = [...name]
    .map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? '_' : ch))
    .join('')
    .trim()
    .slice(0, 200);
  return cleaned || 'file';
}

@Injectable()
export class FilesService {
  constructor(
    @Inject(TENANT_DATABASES) private readonly dbs: TenantDatabases,
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(FILE_ENV) private readonly env: FileEnv,
    private readonly outbox: OutboxWriter,
  ) {}

  private files() {
    return this.dbs.model(FileModel);
  }

  private secret(): string {
    return (
      this.env.FILE_URL_SECRET ??
      createHmac('sha256', this.env.INTERNAL_SECRET).update('file-links').digest('hex')
    );
  }

  private sign(tenantId: string, id: string, exp: number): string {
    return createHmac('sha256', this.secret())
      .update(`${tenantId}.${id}.${exp}`)
      .digest('base64url');
  }

  private toDto(f: FileDoc) {
    return {
      id: f._id,
      name: f.name,
      contentType: f.contentType,
      size: f.size,
      createdAt: f.createdAt,
    };
  }

  async upload(
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer } | undefined,
  ) {
    if (!file) throw AppError.badRequest('Attach a file in the "file" field');
    if (file.size > this.env.MAX_UPLOAD_MB * 1024 * 1024) {
      throw new AppError(
        413,
        'FILE_TOO_LARGE',
        `Files can be at most ${this.env.MAX_UPLOAD_MB} MB`,
      );
    }
    const contentType = file.mimetype.toLowerCase();
    if (!ALLOWED_TYPES.has(contentType))
      throw AppError.badRequest(`Files of type ${contentType} are not allowed`);
    if (!magicMatches(contentType, file.buffer))
      throw AppError.badRequest('The file content does not match its type');
    const tenantId = requireTenantId();
    const id = randomUUID();
    const storageKey = `${tenantId}/${id}`;
    await this.storage.put(storageKey, file.buffer, contentType);
    const Files = await this.files();
    const doc = {
      _id: id,
      name: safeName(file.originalname),
      contentType,
      size: file.size,
      sha256: createHash('sha256').update(file.buffer).digest('hex'),
      storageKey,
      uploadedBy: requireContext().actor!.id,
    };
    await this.conn.transaction(async (session) => {
      await Files.create([doc], { session });
      await this.outbox.record(
        EventTypes.FileUploaded,
        { fileId: id, name: doc.name, contentType, size: doc.size, sha256: doc.sha256 },
        { session },
      );
    });
    return this.toDto((await Files.findById(id).lean<FileDoc>())!);
  }

  private async load(id: string): Promise<FileDoc> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw AppError.notFound('File');
    const f = await (await this.files()).findById(id).lean<FileDoc>();
    if (!f) throw AppError.notFound('File');
    return f;
  }

  async describe(id: string) {
    const f = await this.load(id);
    const exp = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
    const tenantId = requireTenantId();
    const url = `/api/v1/files/${f._id}/content?t=${tenantId}&exp=${exp}&sig=${this.sign(tenantId, f._id, exp)}`;
    return { ...this.toDto(f), url, urlExpiresAt: new Date(exp * 1000).toISOString() };
  }

  async internalGet(id: string) {
    return this.toDto(await this.load(id));
  }

  /** Streams a file for a valid, unexpired signed link. The link itself carries the tenant. */
  async open(
    id: string,
    q: { t?: string; exp?: string; sig?: string },
  ): Promise<{ file: FileDoc; body: Readable; inline: boolean }> {
    const exp = Number(q.exp);
    const tenantId = q.t ?? '';
    const expected = this.sign(tenantId, id, exp);
    const given = Buffer.from(q.sig ?? '');
    const valid =
      Number.isInteger(exp) &&
      exp >= Date.now() / 1000 &&
      given.length === expected.length &&
      timingSafeEqual(given, Buffer.from(expected));
    if (!valid) throw new AppError(403, 'LINK_EXPIRED', 'This link is invalid or has expired');
    return runAsTenant(tenantId, { type: 'system', id: 'file-service' }, async () => {
      const file = await this.load(id);
      return {
        file,
        body: await this.storage.get(file.storageKey),
        inline: INLINE_TYPES.has(file.contentType),
      };
    });
  }
}
