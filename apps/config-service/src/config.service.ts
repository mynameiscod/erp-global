import { Inject, Injectable } from '@nestjs/common';
import type { Connection } from 'mongoose';
import { EventTypes, hasPermission, type Permission } from '@erp/contracts';
import { OutboxWriter } from '@erp/events';
import {
  dashboardSchema,
  diffConfigs,
  emptyLayer,
  emptyTenantConfig,
  entityPatchSchema,
  fiscalYearStartFor,
  formLayoutSchema,
  automationSchema,
  listViewSchema,
  messageTemplateSchema,
  normalizeTenantConfig,
  numberingPeriod,
  ruleSchema,
  workflowSchema,
  numberingSchema,
  pathIds,
  picklistSchema,
  platformBaseLayer,
  printTemplateSchema,
  renderNumber,
  reportSchema,
  resolveEffective,
  settingsSchema,
  validateTenantConfig,
  withArchivedLeftovers,
  type ConfigLayer,
  type ConfigSettings,
  type TenantConfig,
} from '@erp/metadata';
import {
  AppError,
  MONGO_CONNECTION,
  TENANT_DATABASES,
  UpstreamError,
  type EffectiveConfigResponse,
  type TenantProfile,
} from '@erp/service-kit';
import { requireContext, requireTenantId, type TenantDatabases } from '@erp/tenancy';
import type { ZodType } from 'zod';
import { CLIENTS, type Clients, type OrgUnitInfo } from './clients';
import { CounterModel, DraftModel, VersionModel, type Draft, type Version } from './models';

export type Scope = 'company' | string;

/** Draft item kinds, the layer array they live in, and the key that identifies an item. */
export const KINDS = {
  entities: { list: 'entities', key: 'key', schema: entityPatchSchema },
  picklists: { list: 'picklists', key: 'key', schema: picklistSchema },
  forms: { list: 'forms', key: 'entity', schema: formLayoutSchema },
  'list-views': { list: 'listViews', key: 'entity', schema: listViewSchema },
  numbering: { list: 'numbering', key: 'key', schema: numberingSchema },
  workflows: { list: 'workflows', key: 'entity', schema: workflowSchema },
  rules: { list: 'rules', key: 'key', schema: ruleSchema },
  automations: { list: 'automations', key: 'key', schema: automationSchema },
  templates: { list: 'templates', key: 'key', schema: messageTemplateSchema },
  'print-templates': { list: 'printTemplates', key: 'key', schema: printTemplateSchema },
  reports: { list: 'reports', key: 'key', schema: reportSchema },
  dashboards: { list: 'dashboards', key: 'key', schema: dashboardSchema },
} as const satisfies Record<string, { list: keyof ConfigLayer; key: string; schema: ZodType }>;
export type Kind = keyof typeof KINDS;

const BASE = () => [platformBaseLayer()];

@Injectable()
export class ConfigService {
  /** Latest published version per tenant; refreshed on publish and every second across replicas. */
  private readonly latestCache = new Map<
    string,
    { value: Promise<Version | null>; expires: number }
  >();
  private readonly profileCache = new Map<
    string,
    { value: Promise<TenantProfile>; expires: number }
  >();

  constructor(
    @Inject(TENANT_DATABASES) private readonly dbs: TenantDatabases,
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    @Inject(CLIENTS) private readonly clients: Clients,
    private readonly outbox: OutboxWriter,
  ) {}

  // ---- permissions ----

  private claims() {
    const ctx = requireContext();
    return { acl: ctx.acl ?? [], plat: ctx.plat };
  }

  /** Company-wide changes need the permission at the top of the org tree. */
  private assertCompany(perm: Permission): void {
    const ctx = requireContext();
    if (ctx.actor?.type === 'service') return;
    const atRoot = (ctx.acl ?? []).some(
      (e) => pathIds(e.path).length === 1 && hasPermission({ acl: [e] }, perm),
    );
    if (!atRoot) throw AppError.forbidden('This needs company-wide access');
  }

  private async assertScope(scope: Scope, perm: Permission): Promise<OrgUnitInfo | undefined> {
    if (scope === 'company') {
      this.assertCompany(perm);
      return undefined;
    }
    const unit = await this.orgUnit(scope);
    if (!hasPermission(this.claims(), perm, unit.path)) {
      throw AppError.forbidden('This organization unit is outside your access');
    }
    return unit;
  }

  private async orgUnit(id: string): Promise<OrgUnitInfo> {
    try {
      return await this.clients.org.get<OrgUnitInfo>(
        `/internal/org/units/${encodeURIComponent(id)}`,
      );
    } catch (e) {
      if (e instanceof UpstreamError && e.status === 404)
        throw AppError.notFound('Organization unit');
      throw e;
    }
  }

  // ---- published versions ----

  private async versions() {
    return this.dbs.model(VersionModel);
  }

  /** The live version number, read straight from the database (indexed, cheap). */
  async currentVersion(): Promise<number> {
    const V = await this.versions();
    const v = await V.findOne({}, { version: 1 }).sort({ version: -1 }).lean<{ version: number }>();
    return v?.version ?? 0;
  }

  latest(): Promise<Version | null> {
    const tenantId = requireTenantId();
    const hit = this.latestCache.get(tenantId);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = this.versions().then((V) =>
      V.findOne().sort({ version: -1 }).lean<Version>().exec(),
    );
    // Short-lived: other replicas may publish; this replica clears it on its own publishes.
    this.latestCache.set(tenantId, { value, expires: Date.now() + 1_000 });
    value.catch(() => this.latestCache.delete(tenantId));
    return value;
  }

  private profile(): Promise<TenantProfile> {
    const tenantId = requireTenantId();
    const hit = this.profileCache.get(tenantId);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = this.clients.tenant.get<TenantProfile>(`/internal/tenants/${tenantId}`, {
      tenantId,
    });
    this.profileCache.set(tenantId, { value, expires: Date.now() + 300_000 });
    value.catch(() => this.profileCache.delete(tenantId));
    return value;
  }

  async listVersions() {
    const V = await this.versions();
    const list = await V.find({}, { config: 0 }).sort({ version: -1 }).limit(200).lean();
    return list.map((v) => ({
      version: v.version,
      note: v.note ?? null,
      summary: v.summary,
      rolledBackFrom: v.rolledBackFrom ?? null,
      publishedBy: v.publishedBy ?? null,
      publishedAt: v.publishedAt,
    }));
  }

  async getVersion(version: number) {
    const v = await (await this.versions()).findOne({ version }).lean();
    if (!v) throw AppError.notFound('Version');
    return {
      version: v.version,
      note: v.note ?? null,
      summary: v.summary,
      publishedAt: v.publishedAt,
      config: v.config,
    };
  }

  // ---- effective configuration ----

  async effective(
    orgPath?: string,
    source: 'published' | 'draft' = 'published',
  ): Promise<EffectiveConfigResponse> {
    const profile = await this.profile();
    let config: TenantConfig;
    let version: number;
    if (source === 'draft') {
      config = (await this.loadDraft()).config;
      version = -1;
    } else {
      const latest = await this.latest();
      config = latest?.config ?? emptyTenantConfig();
      version = latest?.version ?? 0;
    }
    const effective = resolveEffective(BASE(), config, {
      version,
      orgPath,
      defaultFiscalYearStart: fiscalYearStartFor(profile.countryCode),
    });
    return {
      ...effective,
      tenant: {
        countryCode: profile.countryCode,
        currency: profile.currency,
        locale: profile.locale,
        defaultLanguage: profile.defaultLanguage,
        timezone: profile.timezone ?? 'UTC',
        name: profile.name,
      },
    };
  }

  async effectiveForUnit(orgUnitId: string | undefined, source: 'published' | 'draft') {
    if (source === 'draft') this.assertCompanyOrAny('config.read');
    const path = orgUnitId ? (await this.orgUnit(orgUnitId)).path : undefined;
    const cfg = await this.effective(path, source);
    // Automations (webhook addresses) are for the studio and the services, not every user.
    if (source === 'published' && !hasPermission(this.claims(), 'config.read')) {
      return { ...cfg, automations: [] };
    }
    return cfg;
  }

  private assertCompanyOrAny(perm: Permission): void {
    if (!hasPermission(this.claims(), perm)) throw AppError.forbidden();
  }

  /** Entity keys in any published layer; access-service uses them to check record permissions. */
  async publishedEntities(): Promise<{ key: string; kind: string }[]> {
    const latest = await this.latest();
    if (!latest) return BASE()[0].entities.map((e) => ({ key: e.key, kind: e.kind! }));
    const keys = new Map<string, string>();
    for (const layer of [
      ...BASE(),
      latest.config.company,
      ...Object.values(latest.config.orgUnits),
    ]) {
      for (const e of layer.entities)
        if (!keys.has(e.key) || e.kind) keys.set(e.key, e.kind ?? keys.get(e.key) ?? 'custom');
    }
    return [...keys].map(([key, kind]) => ({ key, kind }));
  }

  // ---- draft ----

  private async drafts() {
    return this.dbs.model(DraftModel);
  }

  async loadDraft(): Promise<Draft> {
    const D = await this.drafts();
    const existing = await D.findOne().lean<Draft>();
    if (existing) return existing;
    const latest = await this.latest();
    try {
      await D.create({
        config: latest?.config ?? emptyTenantConfig(),
        baseVersion: latest?.version ?? 0,
        rev: 0,
      });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
    }
    return (await D.findOne().lean<Draft>())!;
  }

  async getDraft() {
    this.assertCompanyOrAny('config.read');
    const draft = await this.loadDraft();
    const latest = await this.latest();
    const changes = diffConfigs(latest?.config ?? emptyTenantConfig(), draft.config);
    return {
      config: normalizeTenantConfig(draft.config),
      baseVersion: draft.baseVersion,
      publishedVersion: latest?.version ?? 0,
      changes,
      updatedAt: draft.updatedAt,
      updatedBy: draft.updatedBy ?? null,
    };
  }

  /** Applies `change` to one layer of the draft, retrying if someone else saved at the same moment. */
  private async mutate(scope: Scope, change: (layer: ConfigLayer) => void, unit?: OrgUnitInfo) {
    const D = await this.drafts();
    for (let attempt = 0; attempt < 5; attempt++) {
      const draft = await this.loadDraft();
      const config: TenantConfig = normalizeTenantConfig(structuredClone(draft.config));
      let layer: ConfigLayer;
      if (scope === 'company') layer = config.company;
      else {
        config.orgUnits[scope] ??= { ...emptyLayer(), path: unit!.path, name: unit!.name };
        config.orgUnits[scope].path = unit!.path;
        config.orgUnits[scope].name = unit!.name;
        layer = config.orgUnits[scope];
      }
      change(layer);
      const res = await D.updateOne(
        { rev: draft.rev },
        {
          $set: { config, updatedAt: new Date(), updatedBy: requireContext().actor?.id },
          $inc: { rev: 1 },
        },
      );
      if (res.modifiedCount === 1) return this.getDraft();
    }
    throw AppError.conflict('The draft is being edited by someone else. Please try again.');
  }

  async putItem(kind: Kind, key: string, body: unknown, scope: Scope) {
    const unit = await this.assertScope(scope, 'config.manage');
    const def = KINDS[kind];
    const parsed = def.schema.safeParse(body);
    if (!parsed.success) {
      throw AppError.badRequest(
        'Validation failed',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    const item = parsed.data as Record<string, unknown>;
    if (item[def.key] !== key)
      throw AppError.badRequest(`The ${def.key} in the body must be "${key}"`);
    return this.mutate(
      scope,
      (layer) => {
        const list = layer[def.list] as unknown as Record<string, unknown>[];
        const i = list.findIndex((x) => x[def.key] === key);
        if (i >= 0) list[i] = item;
        else list.push(item);
      },
      unit,
    );
  }

  async deleteItem(kind: Kind, key: string, scope: Scope) {
    const unit = await this.assertScope(scope, 'config.manage');
    const def = KINDS[kind];
    return this.mutate(
      scope,
      (layer) => {
        const list = layer[def.list] as unknown as Record<string, unknown>[];
        const i = list.findIndex((x) => x[def.key] === key);
        if (i < 0) throw AppError.notFound('Item');
        list.splice(i, 1);
      },
      unit,
    );
  }

  async putSettings(body: unknown) {
    this.assertCompany('config.manage');
    const parsed = settingsSchema.safeParse(body);
    if (!parsed.success) throw AppError.badRequest('Validation failed', parsed.error.issues);
    return this.mutate('company', (layer) => {
      layer.settings = parsed.data as ConfigSettings;
    });
  }

  async removeOverride(orgUnitId: string) {
    const unit = await this.assertScope(orgUnitId, 'config.manage');
    const D = await this.drafts();
    const draft = await this.loadDraft();
    if (!draft.config.orgUnits[orgUnitId]) throw AppError.notFound('Override');
    const config = structuredClone(draft.config);
    delete config.orgUnits[orgUnitId];
    const res = await D.updateOne(
      { rev: draft.rev },
      { $set: { config, updatedAt: new Date() }, $inc: { rev: 1 } },
    );
    if (res.modifiedCount !== 1) throw AppError.conflict('The draft changed. Please try again.');
    void unit;
    return this.getDraft();
  }

  async discardDraft() {
    this.assertCompany('config.manage');
    const latest = await this.latest();
    const D = await this.drafts();
    await this.loadDraft();
    await D.updateOne(
      {},
      {
        $set: {
          config: latest?.config ?? emptyTenantConfig(),
          baseVersion: latest?.version ?? 0,
          updatedAt: new Date(),
        },
        $inc: { rev: 1 },
      },
    );
    return this.getDraft();
  }

  async validateDraft() {
    this.assertCompanyOrAny('config.read');
    const draft = await this.loadDraft();
    const latest = await this.latest();
    return {
      issues: validateTenantConfig(draft.config, { base: BASE(), previous: latest?.config }),
    };
  }

  // ---- publish and rollback ----

  private async saveVersion(
    config: TenantConfig,
    previous: Version | null,
    meta: { note?: string; rolledBackFrom?: number },
  ) {
    const issues = validateTenantConfig(config, { base: BASE(), previous: previous?.config });
    if (issues.length)
      throw new AppError(422, 'CONFIG_INVALID', 'The configuration has problems', issues);
    const summary = diffConfigs(previous?.config ?? emptyTenantConfig(), config);
    if (!summary.length && meta.rolledBackFrom === undefined)
      throw AppError.conflict('There are no changes to publish');

    const version = (previous?.version ?? 0) + 1;
    const [V, D] = await Promise.all([this.versions(), this.drafts()]);
    const actor = requireContext().actor?.id;
    await this.conn.transaction(async (session) => {
      await V.create(
        [
          {
            version,
            config,
            note: meta.note,
            summary,
            rolledBackFrom: meta.rolledBackFrom,
            publishedBy: actor,
          },
        ],
        {
          session,
        },
      ).catch((e: { code?: number }) => {
        if (e.code === 11000)
          throw AppError.conflict('Someone else published at the same time. Please try again.');
        throw e;
      });
      await D.updateOne(
        {},
        { $set: { config, baseVersion: version, updatedAt: new Date() }, $inc: { rev: 1 } },
        { session },
      );
      await this.outbox.record(
        meta.rolledBackFrom === undefined
          ? EventTypes.ConfigPublished
          : EventTypes.ConfigRolledBack,
        {
          version,
          note: meta.note ?? null,
          rolledBackFrom: meta.rolledBackFrom ?? null,
          changes: summary.length,
          summary: summary.slice(0, 100),
        },
        { session },
      );
    });
    this.latestCache.delete(requireTenantId());
    return { version, summary };
  }

  async publish(note?: string) {
    this.assertCompany('config.publish');
    const draft = await this.loadDraft();
    return this.saveVersion(draft.config, await this.latest(), { note });
  }

  async rollback(target: number, note?: string) {
    this.assertCompany('config.publish');
    const latest = await this.latest();
    const v = await (await this.versions()).findOne({ version: target }).lean<Version>();
    if (!v) throw AppError.notFound('Version');
    if (latest && v.version === latest.version)
      throw AppError.conflict('This version is already live');
    const config = withArchivedLeftovers(v.config, latest?.config ?? emptyTenantConfig());
    return this.saveVersion(config, latest, {
      note: note ?? `Rollback to version ${target}`,
      rolledBackFrom: target,
    });
  }

  // ---- numbering ----

  async nextNumber(input: {
    series: string;
    orgUnitId?: string;
    orgPath?: string;
    orgCode?: string;
    date?: string;
  }) {
    const cfg = await this.effective(input.orgPath);
    const series = cfg.numbering.find((n) => n.key === input.series);
    if (!series) throw AppError.notFound('Number series');
    const latest = await this.latest();
    // The layer that defines the series, so an override's series gets its own counter.
    const ids = pathIds(input.orgPath);
    const definingLayer =
      [...ids]
        .reverse()
        .find((id) => latest?.config.orgUnits[id]?.numbering.some((n) => n.key === series.key)) ??
      'company';
    if (series.scope === 'org_unit' && !input.orgUnitId) {
      throw AppError.badRequest(
        'This number series counts per organization unit, but the record has none',
      );
    }
    const bucket = series.scope === 'org_unit' ? input.orgUnitId! : definingLayer;
    const date = input.date ? new Date(input.date) : new Date();
    const period = numberingPeriod(series, date, cfg.settings.fiscalYearStartMonth);

    const Counters = await this.dbs.model(CounterModel);
    let counter;
    for (let attempt = 0; attempt < 3 && !counter; attempt++) {
      try {
        counter = await Counters.findOneAndUpdate(
          { series: series.key, bucket, period },
          { $inc: { seq: 1 } },
          { upsert: true, new: true },
        ).lean();
      } catch (e) {
        // Two first-ever allocations can race on the upsert; the retry increments the winner's row.
        if ((e as { code?: number }).code !== 11000) throw e;
      }
    }
    if (!counter) throw AppError.conflict('Could not allocate a number. Please try again.');
    const number = renderNumber(series.pattern, {
      date,
      fyStartMonth: cfg.settings.fiscalYearStartMonth,
      seq: counter.seq,
      branchCode: input.orgCode ?? input.orgUnitId?.slice(-4).toUpperCase() ?? '',
    });
    return { number, seq: counter.seq, series: series.key, period };
  }
}
