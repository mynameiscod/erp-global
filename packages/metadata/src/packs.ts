import { z } from 'zod';
import type { PrintTemplateDef } from './print';
import type { ReportDef } from './reports';
import type { RuleDef } from './automation-types';
import { mergeLayers } from './merge';
import { keySchema, localizedTextSchema } from './schema-base';
import { configLayerSchema } from './schemas';
import type { EntityTaxSettings } from './tax';
import {
  normalizeLayer,
  type ConfigLayer,
  type EntityPatch,
  type FieldDef,
  type LocalizedText,
} from './types';

/**
 * Packs: versioned bundles of configuration and data (never code). A Country Pack
 * brings taxes, identifiers, holidays and statutory fields; an Industry Pack brings
 * entities, forms, workflows, documents, reports and dashboards.
 *
 * Packs do not name each other. A Country Pack reaches an Industry Pack's entities
 * through **roles** the entities declare (`customer`, `sales_invoice`…): its patches
 * add fields, tax settings, templates and reports to every entity with that role.
 */

export type PackType = 'country' | 'industry';

/** Added to every entity that declares `role`. `$entity` in templates and reports stands for its key. */
export interface PackPatch {
  role: string;
  fields?: FieldDef[];
  /** Columns added to the entity's line items (the table its tax settings name). */
  lineColumns?: FieldDef[];
  tax?: Partial<EntityTaxSettings>;
  printTemplates?: PrintTemplateDef[];
  reports?: ReportDef[];
  rules?: RuleDef[];
}

/** A role the pack creates (editable afterwards). */
export interface PackRole {
  key: string;
  name: LocalizedText;
  description?: LocalizedText;
  permissions: string[];
}

/** An example record. `@ref` values point at earlier samples; `@unit` is the company's top unit. */
export interface PackSample {
  ref: string;
  entity: string;
  data: Record<string, unknown>;
}

export interface PackManifest {
  /** e.g. `country.in`, `industry.education` */
  id: string;
  type: PackType;
  /** Semantic version, e.g. 1.2.0 */
  version: string;
  name: LocalizedText;
  description: LocalizedText;
  /** For suggestions on the Packs page: the country code or industry code it is for. */
  suggestFor?: string[];
  /** Capabilities used, e.g. `tax`; shown if missing, never a hard dependency on another pack. */
  uses?: string[];
  layer: Partial<ConfigLayer>;
  patches?: PackPatch[];
  roles?: PackRole[];
  samples?: PackSample[];
}

/** A pack installed in a company's configuration: a snapshot of the version installed. */
export interface InstalledPack {
  id: string;
  version: string;
  installedAt: string;
  manifest: PackManifest;
}

export const packManifestSchema = z
  .object({
    id: z.string().regex(/^(country|industry)\.[a-z][a-z0-9_]{1,39}$/),
    type: z.enum(['country', 'industry']),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    name: localizedTextSchema,
    description: z.record(z.string(), z.string().max(1000)),
    suggestFor: z.array(z.string().max(40)).max(50).optional(),
    uses: z.array(z.string().max(40)).max(20).optional(),
    layer: configLayerSchema.partial(),
    // Patches are templates ($entity, $lines); their result is checked with the layers.
    patches: z
      .array(z.object({ role: keySchema }).passthrough())
      .max(50)
      .optional(),
    roles: z
      .array(
        z
          .object({
            key: keySchema,
            name: localizedTextSchema,
            description: localizedTextSchema.optional(),
            permissions: z.array(z.string().max(120)).max(200),
          })
          .strict(),
      )
      .max(30)
      .optional(),
    samples: z
      .array(
        z
          .object({ ref: keySchema, entity: keySchema, data: z.record(z.string(), z.unknown()) })
          .strict(),
      )
      .max(500)
      .optional(),
  })
  .strict();

/** Compares semantic versions: negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** In labels, `$entity` becomes the entity's name in each language. */
const nameLabels = (v: unknown, names: LocalizedText | undefined, entity: string): unknown => {
  if (Array.isArray(v)) return v.map((x) => nameLabels(x, names, entity));
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => {
      const text =
        k === 'label' && x && typeof x === 'object' && !Array.isArray(x)
          ? Object.values(x).every((s) => typeof s === 'string')
          : false;
      if (!text) return [k, nameLabels(x, names, entity)];
      return [
        k,
        Object.fromEntries(
          Object.entries(x as Record<string, string>).map(([lang, s]) => [
            lang,
            s.replace(/\$entity/g, names?.[lang] ?? names?.en ?? entity),
          ]),
        ),
      ];
    }),
  );
};

/**
 * `$entity` stands for the entity's key (its name in labels), `$lines` for its line
 * items table.
 */
const substitute = <T>(item: T, entity: string, lines = 'lines', names?: LocalizedText): T =>
  JSON.parse(
    JSON.stringify(nameLabels(item, names, entity))
      .replace(/\$entity/g, entity)
      .replace(/\$lines/g, lines),
  ) as T;

/**
 * The configuration layers of the installed packs, in order (countries first), followed by
 * one layer with the patches applied to every entity that has the patch's role. `company`
 * is read only to find the company's own entities with roles.
 */
export function packLayers(
  packs: InstalledPack[] | undefined,
  company?: ConfigLayer,
): ConfigLayer[] {
  if (!packs?.length) return [];
  const ordered = [...packs].sort((a, b) =>
    a.manifest.type === b.manifest.type ? 0 : a.manifest.type === 'country' ? -1 : 1,
  );
  const layers = ordered.map((p) => normalizeLayer(p.manifest.layer as ConfigLayer));
  const patches = ordered.flatMap((p) => p.manifest.patches ?? []);
  if (!patches.length) return layers;

  // Entities and their roles, as the packs and the company define them.
  const roles = new Map<string, Set<string>>();
  for (const l of [...layers, ...(company ? [normalizeLayer(company)] : [])]) {
    for (const e of l.entities) {
      if (e.roles) roles.set(e.key, new Set([...(roles.get(e.key) ?? []), ...e.roles]));
    }
  }
  const out = normalizeLayer({});
  const many = (p: PackPatch) => [...roles].filter(([, r]) => r.has(p.role)).length > 1;
  // Entities as the packs and the company define them so far, to extend line item tables.
  const merged = new Map(
    mergeLayers([...layers, ...(company ? [company] : [])]).entities.map((e) => [e.key, e]),
  );
  for (const p of patches) {
    for (const [entity, r] of roles) {
      if (!r.has(p.role)) continue;
      const lines = merged.get(entity)?.tax?.lines ?? 'lines';
      const names = merged.get(entity)?.label;
      const suffix = (key: string) => (many(p) ? `${key}_${entity}`.slice(0, 40) : key);
      if (p.fields?.length || p.tax || p.lineColumns?.length) {
        const patch: EntityPatch = {
          key: entity,
          fields: substitute(p.fields ?? [], entity, lines),
        };
        if (p.tax) patch.tax = p.tax as EntityTaxSettings;
        const def = merged.get(entity);
        const linesKey = def?.tax?.lines;
        const table = def?.fields.find((f) => f.key === linesKey && f.type === 'table');
        if (p.lineColumns?.length && table) {
          const have = new Set((table.columns ?? []).map((c) => c.key));
          patch.fields.push({
            ...table,
            columns: [...(table.columns ?? []), ...p.lineColumns.filter((c) => !have.has(c.key))],
          });
        }
        out.entities.push(patch);
      }
      for (const t of p.printTemplates ?? [])
        out.printTemplates.push({ ...substitute(t, entity, lines, names), key: suffix(t.key) });
      for (const rep of p.reports ?? [])
        out.reports.push({ ...substitute(rep, entity, lines, names), key: suffix(rep.key) });
      for (const rule of p.rules ?? [])
        out.rules.push({ ...substitute(rule, entity, lines, names), key: suffix(rule.key) });
    }
  }
  return [...layers, out];
}
