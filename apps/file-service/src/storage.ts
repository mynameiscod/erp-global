import { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/** Where file bytes live. Metadata stays in MongoDB. */
export interface FileStorage {
  init(): Promise<void>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}

export const FILE_STORAGE = Symbol('FILE_STORAGE');

/** For tests and single-process development. */
export class MemoryStorage implements FileStorage {
  private readonly objects = new Map<string, Buffer>();
  async init(): Promise<void> {}
  async put(key: string, body: Buffer): Promise<void> {
    this.objects.set(key, body);
  }
  async get(key: string): Promise<Readable> {
    const b = this.objects.get(key);
    if (!b) throw new Error('not found');
    return Readable.from(b);
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

/** S3-compatible storage: MinIO on the VPS, or AWS S3 / Cloudflare R2 by changing the endpoint. */
export class S3Storage implements FileStorage {
  private readonly s3: S3Client;

  constructor(
    private readonly bucket: string,
    opts: { endpoint?: string; region: string; accessKeyId: string; secretAccessKey: string },
  ) {
    this.s3 = new S3Client({
      region: opts.region,
      endpoint: opts.endpoint,
      forcePathStyle: !!opts.endpoint,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }

  async init(): Promise<void> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<Readable> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body as Readable;
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
