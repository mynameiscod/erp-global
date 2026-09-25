import { pickText } from './i18n';
import { emptyLayer, normalizeLayer, type ConfigLayer, type TenantConfig } from './types';

type Keyed = { key?: string; entity?: string; label?: Record<string, string> };

function keyOf(item: Keyed): string {
  return item.key ?? item.entity ?? '';
}

function diffList(kind: string, prev: Keyed[], next: Keyed[], out: string[], prefix: string): void {
  const p = new Map(prev.map((i) => [keyOf(i), i]));
  const n = new Map(next.map((i) => [keyOf(i), i]));
  for (const [k, item] of n) {
    const name = item.label ? `${pickText(item.label, 'en')} (${k})` : k;
    if (!p.has(k)) out.push(`${prefix}Added ${kind} ${name}`);
    else if (JSON.stringify(p.get(k)) !== JSON.stringify(item))
      out.push(`${prefix}Changed ${kind} ${name}`);
  }
  for (const k of p.keys()) if (!n.has(k)) out.push(`${prefix}Removed ${kind} ${k}`);
}

function diffLayer(prev: ConfigLayer, next: ConfigLayer, out: string[], prefix: string): void {
  const pe = new Map(prev.entities.map((e) => [e.key, e]));
  for (const e of next.entities) {
    const before = pe.get(e.key);
    if (!before) {
      out.push(`${prefix}Added entity ${e.label ? pickText(e.label, 'en') : e.key} (${e.key})`);
      continue;
    }
    const { fields: bf, ...bprops } = before;
    const { fields: nf, ...nprops } = e;
    if (JSON.stringify(bprops) !== JSON.stringify(nprops))
      out.push(`${prefix}Changed entity ${e.key}`);
    diffList('field', bf, nf, out, `${prefix}${e.key}: `);
  }
  for (const k of pe.keys())
    if (!next.entities.some((e) => e.key === k)) out.push(`${prefix}Removed entity ${k}`);
  diffList('option list', prev.picklists, next.picklists, out, prefix);
  diffList('form', prev.forms, next.forms, out, prefix);
  diffList('list view', prev.listViews, next.listViews, out, prefix);
  diffList('number series', prev.numbering, next.numbering, out, prefix);
  const p = normalizeLayer(prev);
  const n = normalizeLayer(next);
  diffList('workflow', p.workflows, n.workflows, out, prefix);
  diffList('rule', p.rules, n.rules, out, prefix);
  diffList('automation', p.automations, n.automations, out, prefix);
  diffList('message template', p.templates, n.templates, out, prefix);
  if (JSON.stringify(prev.settings ?? {}) !== JSON.stringify(next.settings ?? {}))
    out.push(`${prefix}Changed settings`);
}

const EMPTY: ConfigLayer = emptyLayer();

/** Human-readable list of what changed between two configurations. */
export function diffConfigs(prev: TenantConfig, next: TenantConfig): string[] {
  const out: string[] = [];
  diffLayer(prev.company, next.company, out, '');
  const ids = new Set([...Object.keys(prev.orgUnits), ...Object.keys(next.orgUnits)]);
  for (const id of ids) {
    const p = prev.orgUnits[id];
    const n = next.orgUnits[id];
    const label = `[${n?.name ?? p?.name ?? id}] `;
    if (!p) out.push(`${label}Added override`);
    if (!n) {
      out.push(`${label}Removed override`);
      continue;
    }
    diffLayer(p ?? EMPTY, n, out, label);
  }
  return out;
}

/**
 * For rollback: the target configuration, plus any entity or field that exists
 * now but not in the target, kept as archived so no data becomes orphaned.
 */
export function withArchivedLeftovers(target: TenantConfig, current: TenantConfig): TenantConfig {
  const result: TenantConfig = structuredClone(target);
  // Entities the target still defines company-wide (or built-ins): an override that only
  // added fields to them must keep the entity alive and archive just those fields.
  const stillDefined = new Set([...result.company.entities.map((e) => e.key), 'user', 'org_unit']);
  const keep = (to: ConfigLayer, from: ConfigLayer) => {
    for (const ce of from.entities) {
      let te = to.entities.find((e) => e.key === ce.key);
      if (!te) {
        const fields = ce.fields.map((f) => ({ ...f, archived: true }));
        te = stillDefined.has(ce.key) ? { key: ce.key, fields } : { ...ce, archived: true, fields };
        to.entities.push(te);
        continue;
      }
      for (const cf of ce.fields) {
        if (!te.fields.some((f) => f.key === cf.key)) te.fields.push({ ...cf, archived: true });
      }
    }
    for (const kind of ['picklists', 'numbering'] as const) {
      for (const item of from[kind]) {
        // Archived fields may still reference these.
        if (!(to[kind] as { key: string }[]).some((i) => i.key === item.key))
          (to[kind] as unknown[]).push(item);
      }
    }
  };
  keep(result.company, current.company);
  for (const [id, layer] of Object.entries(current.orgUnits)) {
    if (!result.orgUnits[id])
      result.orgUnits[id] = { ...emptyLayer(), path: layer.path, name: layer.name };
    keep(result.orgUnits[id], layer);
  }
  return result;
}

export function emptyTenantConfig(): TenantConfig {
  return {
    company: emptyLayer(),
    orgUnits: {},
  };
}
