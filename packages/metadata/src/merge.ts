import { normalizeLayer } from './types';
import type {
  ConfigLayer,
  ConfigSettings,
  EffectiveConfig,
  EntityDef,
  EntityPatch,
  FieldDef,
  TenantConfig,
} from './types';

function byKey<T>(items: T[], key: (t: T) => string): Map<string, T> {
  return new Map(items.map((i) => [key(i), i]));
}

function mergeEntity(prev: EntityPatch | undefined, patch: EntityPatch): EntityPatch {
  if (!prev) return { ...patch, fields: [...patch.fields] };
  const fields = byKey(prev.fields, (f) => f.key);
  for (const f of patch.fields) fields.set(f.key, f);
  const { fields: _ignored, ...props } = patch;
  return { ...prev, ...props, fields: [...fields.values()] };
}

/**
 * Merges layers in order. Later layers add items or replace them by key;
 * entities merge field by field, so an override can add one field without
 * repeating the whole entity.
 */
export function mergeLayers(layers: ConfigLayer[]): ConfigLayer {
  const entities = new Map<string, EntityPatch>();
  const picklists = new Map<string, ConfigLayer['picklists'][number]>();
  const forms = new Map<string, ConfigLayer['forms'][number]>();
  const listViews = new Map<string, ConfigLayer['listViews'][number]>();
  const numbering = new Map<string, ConfigLayer['numbering'][number]>();
  const workflows = new Map<string, ConfigLayer['workflows'][number]>();
  const rules = new Map<string, ConfigLayer['rules'][number]>();
  const automations = new Map<string, ConfigLayer['automations'][number]>();
  const templates = new Map<string, ConfigLayer['templates'][number]>();
  const printTemplates = new Map<string, ConfigLayer['printTemplates'][number]>();
  const reports = new Map<string, ConfigLayer['reports'][number]>();
  const dashboards = new Map<string, ConfigLayer['dashboards'][number]>();
  let settings: ConfigSettings = {};
  for (const raw of layers) {
    const layer = normalizeLayer(raw);
    for (const e of layer.entities) entities.set(e.key, mergeEntity(entities.get(e.key), e));
    for (const p of layer.picklists) picklists.set(p.key, p);
    for (const f of layer.forms) forms.set(f.entity, f);
    for (const l of layer.listViews) listViews.set(l.entity, l);
    for (const n of layer.numbering) numbering.set(n.key, n);
    // A branch override replaces the whole workflow of an entity (e.g. its own approval chain).
    for (const w of layer.workflows) workflows.set(w.entity, w);
    for (const r of layer.rules) rules.set(r.key, r);
    for (const a of layer.automations) automations.set(a.key, a);
    for (const t of layer.templates) templates.set(t.key, t);
    // A branch can replace a print template (its own letterhead), a report or a dashboard.
    for (const p of layer.printTemplates) printTemplates.set(p.key, p);
    for (const r of layer.reports) reports.set(r.key, r);
    for (const d of layer.dashboards) dashboards.set(d.key, d);
    settings = { ...settings, ...(layer.settings ?? {}) };
  }
  return {
    entities: [...entities.values()],
    picklists: [...picklists.values()],
    forms: [...forms.values()],
    listViews: [...listViews.values()],
    numbering: [...numbering.values()],
    workflows: [...workflows.values()],
    rules: [...rules.values()],
    automations: [...automations.values()],
    templates: [...templates.values()],
    printTemplates: [...printTemplates.values()],
    reports: [...reports.values()],
    dashboards: [...dashboards.values()],
    settings,
  };
}

/** Org unit ids on a materialized path, from the top: `/a/b/c/` gives `[a, b, c]`. */
export function pathIds(path: string | undefined): string[] {
  return (path ?? '').split('/').filter(Boolean);
}

/**
 * The layers that apply at `orgPath`: platform and packs, the company, then every
 * override on the path from the top of the org tree down to the unit itself.
 * Using ids from the path (not stored paths) keeps this correct after units move.
 */
export function layersFor(
  base: ConfigLayer[],
  config: TenantConfig,
  orgPath?: string,
): ConfigLayer[] {
  const overrides = pathIds(orgPath)
    .map((id) => config.orgUnits[id])
    .filter((l): l is NonNullable<typeof l> => !!l);
  return [...base, config.company, ...overrides];
}

function isComplete(e: EntityPatch): e is EntityDef {
  return !!e.kind && !!e.label && !!e.pluralLabel;
}

export function resolveEffective(
  base: ConfigLayer[],
  config: TenantConfig,
  opts: { version: number; orgPath?: string; defaultFiscalYearStart: number },
): EffectiveConfig {
  const merged = mergeLayers(layersFor(base, config, opts.orgPath));
  return {
    ...merged,
    // Incomplete entities are rejected at publish; drop any defensively.
    entities: merged.entities.filter(isComplete),
    version: opts.version,
    settings: {
      ...merged.settings,
      fiscalYearStartMonth: merged.settings?.fiscalYearStartMonth ?? opts.defaultFiscalYearStart,
    },
  };
}

export function findEntity(
  cfg: Pick<EffectiveConfig, 'entities'>,
  key: string,
): EntityDef | undefined {
  return cfg.entities.find((e) => e.key === key);
}

export function activeFields(entity: EntityDef): FieldDef[] {
  return entity.fields.filter((f) => !f.archived);
}
