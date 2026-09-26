import { mergeLayers } from './merge';
import { packLayers, type InstalledPack, type PackManifest } from './packs';
import { pickText } from './i18n';
import {
  emptyLayer,
  normalizeLayer,
  type ConfigLayer,
  type EntityPatch,
  type TenantConfig,
} from './types';

/**
 * Installing, upgrading and removing packs in a company's draft configuration. Pure
 * functions: config-service applies them to the draft, and they are tested on their own.
 */

/** Lists of a layer whose items are identified by one key. */
const LISTS = [
  ['picklists', 'key'],
  ['forms', 'entity'],
  ['listViews', 'entity'],
  ['numbering', 'key'],
  ['workflows', 'entity'],
  ['rules', 'key'],
  ['automations', 'key'],
  ['templates', 'key'],
  ['printTemplates', 'key'],
  ['reports', 'key'],
  ['dashboards', 'key'],
  ['identifierTypes', 'key'],
] as const;

/** Every item of a layer by a path (`entities.student.fields.name`, `reports.fees`), with its JSON. */
function itemsOf(layer: ConfigLayer): Map<string, { json: string; label: string }> {
  const l = normalizeLayer(layer);
  const out = new Map<string, { json: string; label: string }>();
  for (const e of l.entities) {
    const { fields, ...props } = e;
    out.set(`entities.${e.key}`, {
      json: JSON.stringify(props),
      label: pickText(e.label, 'en') || e.key,
    });
    for (const f of fields)
      out.set(`entities.${e.key}.fields.${f.key}`, {
        json: JSON.stringify(f),
        label: `${pickText(e.label, 'en') || e.key} › ${pickText(f.label, 'en') || f.key}`,
      });
  }
  for (const [list, key] of LISTS) {
    for (const item of l[list] as unknown as Record<string, unknown>[]) {
      const k = String(item[key]);
      const label = item.label ? pickText(item.label as Record<string, string>, 'en') : k;
      out.set(`${list}.${k}`, { json: JSON.stringify(item), label });
    }
  }
  if (l.taxes) out.set('taxes', { json: JSON.stringify(l.taxes), label: 'Taxes' });
  if (l.calendar)
    out.set('calendar', { json: JSON.stringify(l.calendar), label: 'Working calendar' });
  return out;
}

export interface PackConflict {
  /** e.g. `forms.admission` or `entities.student.fields.name` */
  path: string;
  label: string;
}

export interface PackPreview {
  action: 'install' | 'upgrade' | 'reinstall';
  from?: string;
  to: string;
  /** What the pack adds, changes or drops (compared with the installed version). */
  added: string[];
  changed: string[];
  removed: string[];
  /** Items both the new version and the company changed. */
  conflicts: PackConflict[];
}

const layerOf = (m: PackManifest) => normalizeLayer(m.layer as ConfigLayer);

/** What installing (or upgrading to) `manifest` would do to the draft. */
export function previewPack(config: TenantConfig, manifest: PackManifest): PackPreview {
  const current = config.packs?.find((p) => p.id === manifest.id);
  const before = current
    ? itemsOf(layerOf(current.manifest))
    : new Map<string, { json: string; label: string }>();
  const after = itemsOf(layerOf(manifest));
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const touched = new Set<string>();
  for (const [path, item] of after) {
    const old = before.get(path);
    if (!old) added.push(item.label);
    else if (old.json !== item.json) changed.push(item.label);
    else continue;
    touched.add(path);
  }
  for (const [path, item] of before) {
    if (!after.has(path)) {
      removed.push(item.label);
      touched.add(path);
    }
  }
  // The company's own versions of items the pack now changes (only meaningful on upgrade).
  const mine = itemsOf(config.company);
  const conflicts = current
    ? [...touched]
        .filter((p) => mine.has(p) && before.has(p))
        .map((path) => ({ path, label: mine.get(path)!.label }))
    : [];
  return {
    action: !current ? 'install' : current.version === manifest.version ? 'reinstall' : 'upgrade',
    from: current?.version,
    to: manifest.version,
    added,
    changed,
    removed,
    conflicts,
  };
}

/** Removes the company's version of an item, so the pack's applies. */
function dropFromCompany(company: ConfigLayer, path: string): void {
  const parts = path.split('.');
  if (parts[0] === 'entities') {
    const e = company.entities.find((x) => x.key === parts[1]);
    if (!e) return;
    if (parts[2] === 'fields') e.fields = e.fields.filter((f) => f.key !== parts[3]);
    else {
      // Keep only the key and fields: the pack's name, icon and settings apply again.
      const keep: EntityPatch = { key: e.key, fields: e.fields };
      company.entities[company.entities.indexOf(e)] = keep;
    }
    return;
  }
  if (parts[0] === 'taxes') delete company.taxes;
  else if (parts[0] === 'calendar') delete company.calendar;
  else {
    const def = LISTS.find(([list]) => list === parts[0]);
    if (!def) return;
    const [list, key] = def;
    (company as unknown as Record<string, Record<string, unknown>[]>)[list] = (
      company[list] as unknown as Record<string, unknown>[]
    ).filter((i) => String(i[key]) !== parts[1]);
  }
}

/**
 * Fields and entities that were published but that the packs no longer define, archived
 * into `retired` so their data stays reachable.
 */
function retire(next: TenantConfig, published: TenantConfig | undefined): void {
  if (!published) return;
  const packsOf = (c: TenantConfig) =>
    mergeLayers([...packLayers(c.packs), ...(c.retired ? [c.retired] : [])]).entities;
  const before = packsOf(published);
  const now = new Map(packsOf(next).map((e) => [e.key, e]));
  const retired = normalizeLayer(next.retired ?? emptyLayer());
  for (const e of before) {
    const still = now.get(e.key);
    const missing = e.fields.filter((f) => !still?.fields.some((x) => x.key === f.key));
    if (!missing.length && still) continue;
    let target = retired.entities.find((x) => x.key === e.key);
    if (!target) {
      target = still ? { key: e.key, fields: [] } : { ...e, archived: true, fields: [] };
      retired.entities.push(target);
    }
    for (const f of missing)
      if (!target.fields.some((x) => x.key === f.key)) target.fields.push({ ...f, archived: true });
    // Option lists and number series that archived fields still use.
    for (const kind of ['picklists', 'numbering'] as const) {
      const src = mergeLayers(packLayers(published.packs))[kind] as { key: string }[];
      for (const f of missing) {
        const ref = kind === 'picklists' ? f.picklist : f.numbering;
        const item = ref && src.find((i) => i.key === ref);
        if (item && !(retired[kind] as { key: string }[]).some((i) => i.key === ref))
          (retired[kind] as unknown[]).push(item);
      }
    }
  }
  const hasContent =
    retired.entities.length || retired.picklists.length || retired.numbering.length;
  next.retired = hasContent ? retired : undefined;
}

/**
 * The draft with `manifest` installed or upgraded. `resolutions` says, per conflict path,
 * whether the pack's version replaces the company's (`pack`) or not (`mine`, the default).
 */
export function installPack(
  config: TenantConfig,
  manifest: PackManifest,
  opts: { published?: TenantConfig; resolutions?: Record<string, 'mine' | 'pack'>; now?: Date },
): TenantConfig {
  const next: TenantConfig = structuredClone(config);
  const entry: InstalledPack = {
    id: manifest.id,
    version: manifest.version,
    installedAt: (opts.now ?? new Date()).toISOString(),
    manifest,
  };
  const packs = next.packs ?? [];
  const i = packs.findIndex((p) => p.id === manifest.id);
  if (i >= 0) packs[i] = entry;
  else packs.push(entry);
  next.packs = packs;
  next.company = normalizeLayer(next.company);
  for (const [path, choice] of Object.entries(opts.resolutions ?? {}))
    if (choice === 'pack') dropFromCompany(next.company, path);
  retire(next, opts.published);
  return next;
}

/** The draft without the pack. Published fields it defined are archived, never lost. */
export function removePack(
  config: TenantConfig,
  id: string,
  opts: { published?: TenantConfig },
): TenantConfig {
  const next: TenantConfig = structuredClone(config);
  next.packs = (next.packs ?? []).filter((p) => p.id !== id);
  if (!next.packs.length) delete next.packs;
  retire(next, opts.published);
  return next;
}
