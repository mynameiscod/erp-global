import { Inject, Injectable } from '@nestjs/common';
import type { Connection } from 'mongoose';
import { PinoLogger } from 'nestjs-pino';
import { EventTypes } from '@erp/contracts';
import { OutboxWriter } from '@erp/events';
import {
  compareVersions,
  pickText,
  type InstalledPack,
  type PackManifest,
  type PackPreview,
} from '@erp/metadata';
import { CATALOG, findPack } from '@erp/packs';
import { AppError, MONGO_CONNECTION, TENANT_DATABASES } from '@erp/service-kit';
import { requireContext, type TenantDatabases } from '@erp/tenancy';
import { CLIENTS, type Clients } from './clients';
import { resolveSampleRefs } from './samples';
import { PackHistoryModel, PackSamplesModel, type PackHistory } from './models';

interface InstalledRef {
  id: string;
  version: string;
  installedAt: string;
}

/** A catalog pack as the Packs page shows it. */
export interface PackDto {
  id: string;
  type: PackManifest['type'];
  version: string;
  name: PackManifest['name'];
  description: PackManifest['description'];
  uses: string[];
  /** Fits the company's country or industry. */
  suggested: boolean;
  /** Version in the draft (installed, maybe not yet published). */
  draft: string | null;
  /** Version in the live configuration. */
  published: string | null;
  /** A newer version than the draft's is available. */
  upgrade: boolean;
  contents: {
    entities: { key: string; label: PackManifest['name'] }[];
    reports: number;
    dashboards: number;
    printTemplates: number;
    workflows: number;
    automations: number;
    patches: number;
    roles: { key: string; name: PackManifest['name'] }[];
    samples: number;
  };
  samples: { added: boolean; count: number; version: string | null };
  history: Pick<PackHistory, 'action' | 'version' | 'fromVersion' | 'by' | 'at'>[];
}

const MAX_SAMPLE_REFS = 500;

/**
 * Pack catalog and installations. Packs go into the draft configuration through
 * config-service, so the admin reviews and publishes them like any other change; once
 * live, their roles are created in access-service and, on request, their sample records
 * in records-service.
 */
@Injectable()
export class PacksService {
  constructor(
    @Inject(CLIENTS) private readonly clients: Clients,
    @Inject(TENANT_DATABASES) private readonly dbs: TenantDatabases,
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    private readonly outbox: OutboxWriter,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PacksService.name);
  }

  private history() {
    return this.dbs.model(PackHistoryModel);
  }

  private samplesState() {
    return this.dbs.model(PackSamplesModel);
  }

  private pack(id: string): PackManifest {
    const pack = findPack(id);
    if (!pack) throw AppError.notFound('Pack');
    return pack;
  }

  private installed() {
    return this.clients.config.get<{ draft: InstalledRef[]; published: InstalledRef[] }>(
      '/internal/config/packs',
    );
  }

  async list(): Promise<PackDto[]> {
    const tenantId = requireContext().tenantId!;
    const [tenant, installed, History, Samples] = await Promise.all([
      this.clients.tenants.get<{ countryCode: string; industryCode: string }>(
        `/internal/tenants/${tenantId}`,
      ),
      this.installed(),
      this.history(),
      this.samplesState(),
    ]);
    const [history, samples] = await Promise.all([
      History.find({}).sort({ at: -1 }).limit(200).lean(),
      Samples.find({}).lean(),
    ]);
    const fits = new Set([tenant.countryCode, tenant.industryCode]);
    return CATALOG.map((p) => {
      const draft = installed.draft.find((i) => i.id === p.id)?.version ?? null;
      const published = installed.published.find((i) => i.id === p.id)?.version ?? null;
      const added = samples.find((s) => s.packId === p.id);
      const layer = p.layer;
      return {
        id: p.id,
        type: p.type,
        version: p.version,
        name: p.name,
        description: p.description,
        uses: p.uses ?? [],
        suggested: (p.suggestFor ?? []).some((s) => fits.has(s)),
        draft,
        published,
        upgrade: !!draft && compareVersions(p.version, draft) > 0,
        contents: {
          entities: (layer.entities ?? []).flatMap((e) =>
            e.label ? [{ key: e.key, label: e.label }] : [],
          ),
          reports: (layer.reports ?? []).length,
          dashboards: (layer.dashboards ?? []).length,
          printTemplates: (layer.printTemplates ?? []).length,
          workflows: (layer.workflows ?? []).length,
          automations: (layer.automations ?? []).length,
          patches: (p.patches ?? []).length,
          roles: (p.roles ?? []).map((r) => ({ key: r.key, name: r.name })),
          samples: (p.samples ?? []).length,
        },
        samples: {
          added: !!added,
          count: added?.records.length ?? 0,
          version: added?.version ?? null,
        },
        history: history
          .filter((h) => h.packId === p.id)
          .slice(0, 20)
          .map((h) => ({
            action: h.action,
            version: h.version,
            fromVersion: h.fromVersion,
            by: h.by,
            at: h.at,
          })),
      };
    });
  }

  /** What installing or upgrading would change in the draft, with conflicts to resolve. */
  preview(id: string): Promise<PackPreview> {
    return this.clients.config.post<PackPreview>('/internal/config/packs/preview', this.pack(id));
  }

  /** Installs or upgrades a pack in the draft configuration. */
  async install(id: string, resolutions?: Record<string, 'mine' | 'pack'>) {
    const pack = this.pack(id);
    const before = (await this.installed()).draft.find((p) => p.id === id);
    if (before && compareVersions(pack.version, before.version) < 0)
      throw AppError.conflict('A newer version of this pack is installed');
    const result = await this.clients.config.request<{ changes: unknown[] }>(
      'PUT',
      '/internal/config/packs',
      { manifest: pack, resolutions },
    );
    const upgraded = !!before && before.version !== pack.version;
    await this.record(
      upgraded ? 'upgraded' : 'installed',
      upgraded ? EventTypes.PackUpgraded : EventTypes.PackInstalled,
      { packId: id, version: pack.version, fromVersion: before?.version },
    );
    return result;
  }

  /** Takes a pack out of the draft; data in its fields is kept (archived) when published. */
  async remove(id: string) {
    const before = (await this.installed()).draft.find((p) => p.id === id);
    if (!before) throw AppError.notFound('Installed pack');
    const result = await this.clients.config.delete<{ changes: unknown[] }>(
      `/internal/config/packs/${encodeURIComponent(id)}`,
    );
    await this.record('removed', EventTypes.PackRemoved, { packId: id, version: before.version });
    return result;
  }

  /** The live pack snapshot (what was published, not the catalog's newest version). */
  private async live(id: string): Promise<InstalledPack> {
    const packs = await this.clients.config.get<InstalledPack[]>(
      '/internal/config/packs/published',
    );
    const live = packs.find((p) => p.id === id);
    if (!live) throw AppError.conflict('Publish the configuration with this pack first');
    return live;
  }

  /**
   * Creates the pack's sample records, in order. `@ref` values (anywhere, table rows
   * included) become the ids of earlier samples, `@unit` the company's top unit.
   * Each record has the source key `pack:<id>:<ref>`, so adding twice creates nothing new.
   */
  async addSamples(id: string) {
    const live = await this.live(id);
    const samples = live.manifest.samples ?? [];
    if (!samples.length) throw AppError.badRequest('This pack has no sample data');
    const Samples = await this.samplesState();
    if (await Samples.exists({ packId: id }))
      throw AppError.conflict('The sample data is already added');
    const root = await this.clients.org.get<{ id: string }>('/internal/org/root');
    const ids = new Map<string, string>();
    const created: { ref: string; entity: string; id: string }[] = [];
    try {
      for (const s of samples.slice(0, MAX_SAMPLE_REFS)) {
        const record = await this.clients.records.post<{ id: string }>(
          `/internal/records/${s.entity}`,
          {
            orgUnitId: root.id,
            data: resolveSampleRefs(s.data, ids, root.id),
            sourceKey: `pack:${id}:${s.ref}`,
          },
        );
        ids.set(s.ref, record.id);
        created.push({ ref: s.ref, entity: s.entity, id: record.id });
      }
    } catch (e) {
      // All or nothing: take back what was created, then report the failure.
      await this.clients.records
        .post('/internal/outputs/samples/remove', { prefix: `pack:${id}:` })
        .catch((err: unknown) => this.logger.warn({ err, packId: id }, 'sample cleanup failed'));
      throw e;
    }
    await this.conn.transaction(async (session) => {
      await Samples.create(
        [{ packId: id, version: live.version, records: created, addedAt: new Date() }],
        { session },
      );
      await this.historyEntry('samples_added', { packId: id, version: live.version }, session);
      await this.outbox.record(
        EventTypes.PackSamplesAdded,
        { packId: id, version: live.version, count: created.length },
        { session },
      );
    });
    return { count: created.length };
  }

  /** Deletes the pack's sample records (soft, like any delete); the company's own data stays. */
  async removeSamples(id: string) {
    this.pack(id);
    const Samples = await this.samplesState();
    const state = await Samples.findOne({ packId: id }).lean();
    const res = await this.clients.records.post<{ deleted: number }>(
      '/internal/outputs/samples/remove',
      { prefix: `pack:${id}:` },
    );
    await this.conn.transaction(async (session) => {
      await Samples.deleteOne({ packId: id }, { session });
      await this.historyEntry(
        'samples_removed',
        { packId: id, version: state?.version ?? '0.0.0' },
        session,
      );
      await this.outbox.record(
        EventTypes.PackSamplesRemoved,
        { packId: id, count: res?.deleted ?? state?.records.length ?? 0 },
        { session },
      );
    });
    return res;
  }

  /**
   * After a publish or rollback: every live pack's roles exist (created once by key; an
   * admin's later edits to them are kept).
   */
  async syncRoles() {
    const packs = await this.clients.config.get<InstalledPack[]>(
      '/internal/config/packs/published',
    );
    for (const p of packs) {
      for (const role of p.manifest.roles ?? []) {
        try {
          await this.clients.access.request('PUT', `/internal/access/pack-roles/${role.key}`, {
            name: pickText(role.name, 'en'),
            description: role.description ? pickText(role.description, 'en') : undefined,
            permissions: role.permissions,
          });
        } catch (err) {
          this.logger.warn({ err, packId: p.id, role: role.key }, 'pack role not created');
        }
      }
    }
  }

  private async historyEntry(
    action: PackHistory['action'],
    e: { packId: string; version: string; fromVersion?: string },
    session: import('mongoose').ClientSession,
  ) {
    const History = await this.history();
    await History.create(
      [{ ...e, action, by: requireContext().actor?.id ?? 'system', at: new Date() }],
      { session },
    );
  }

  private async record(
    action: PackHistory['action'],
    type: string,
    e: { packId: string; version: string; fromVersion?: string },
  ) {
    await this.conn.transaction(async (session) => {
      await this.historyEntry(action, e, session);
      await this.outbox.record(type, e, { session });
    });
  }
}
