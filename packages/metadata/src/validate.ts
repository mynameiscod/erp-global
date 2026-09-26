import { compileFormula, FormulaError, formulaFieldKeys, unknownFormulaNames } from './formula';
import { layersFor, mergeLayers } from './merge';
import { packLayers } from './packs';
import { TAX_LINE_FIELDS, TAX_RECORD_FIELDS, withTaxFields, type TaxSetup } from './tax';
import { validateNumberingPattern } from './numbering';
import { configLayerSchema } from './schemas';
import { checkAutomationItems } from './validate-automation';
import { checkOutputItems } from './validate-outputs';
import { NATIVE_FIELDS, RESERVED_FIELD_KEYS, SYSTEM_ENTITY_KEYS } from './system';
import {
  SYSTEM_COLUMNS,
  TABLE_COLUMN_TYPES,
  type ConfigLayer,
  type EntityPatch,
  type FieldDef,
  type FieldType,
  type TenantConfig,
  normalizeLayer,
} from './types';

export interface ConfigIssue {
  /** `company` or an org unit id. */
  scope: string;
  path: string;
  message: string;
}

/** Custom fields on users and org units keep to simple values for now. */
const UNSUPPORTED_ON_SYSTEM = new Set<FieldType>([
  'lookup',
  'lookup_many',
  'file',
  'image',
  'autonumber',
  'table',
]);

/** Type changes that keep existing data valid. */
const COMPATIBLE_CHANGES: Partial<Record<FieldType, FieldType[]>> = {
  text: ['longtext', 'email', 'phone', 'url'],
  email: ['text', 'longtext'],
  phone: ['text', 'longtext'],
  url: ['text', 'longtext'],
  integer: ['decimal'],
  lookup: ['lookup_many'],
  select: ['multiselect'],
  image: ['file'],
};

function checkLayerShape(scope: string, layer: ConfigLayer, issues: ConfigIssue[]): boolean {
  const parsed = configLayerSchema.safeParse(layer);
  if (parsed.success) return true;
  for (const i of parsed.error.issues.slice(0, 50)) {
    issues.push({ scope, path: i.path.join('.'), message: i.message });
  }
  return false;
}

function checkDuplicates(scope: string, raw: ConfigLayer, issues: ConfigIssue[]): void {
  const layer = normalizeLayer(raw);
  const dup = (kind: string, keys: string[]) => {
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k))
        issues.push({ scope, path: `${kind}.${k}`, message: `Duplicate ${kind} "${k}"` });
      seen.add(k);
    }
  };
  dup(
    'entities',
    layer.entities.map((e) => e.key),
  );
  dup(
    'picklists',
    layer.picklists.map((p) => p.key),
  );
  dup(
    'forms',
    layer.forms.map((f) => f.entity),
  );
  dup(
    'listViews',
    layer.listViews.map((l) => l.entity),
  );
  dup(
    'numbering',
    layer.numbering.map((n) => n.key),
  );
  dup(
    'workflows',
    layer.workflows.map((w) => w.entity),
  );
  dup(
    'rules',
    layer.rules.map((r) => r.key),
  );
  dup(
    'automations',
    layer.automations.map((a) => a.key),
  );
  dup(
    'templates',
    layer.templates.map((t) => t.key),
  );
  dup(
    'printTemplates',
    layer.printTemplates.map((t) => t.key),
  );
  dup(
    'reports',
    layer.reports.map((r) => r.key),
  );
  dup(
    'dashboards',
    layer.dashboards.map((d) => d.key),
  );
  dup(
    'identifierTypes',
    layer.identifierTypes.map((i) => i.key),
  );
  for (const e of layer.entities) {
    dup(
      `entities.${e.key}.fields`,
      e.fields.map((f) => f.key),
    );
    for (const f of e.fields.filter((x) => x.columns))
      dup(
        `entities.${e.key}.fields.${f.key}.columns`,
        f.columns!.map((c) => c.key),
      );
  }
  for (const p of layer.picklists)
    dup(
      `picklists.${p.key}.options`,
      p.options.map((o) => o.value),
    );
}

/** Checks one merged configuration (base + company, or + an override) for broken references. */
function checkMerged(scope: string, raw: ConfigLayer, issues: ConfigIssue[]): void {
  const add = (path: string, message: string) => issues.push({ scope, path, message });
  // Entities with taxes have the fields the engine fills; templates and reports may use them.
  const merged: ConfigLayer = { ...raw, entities: raw.entities.map((e) => withTaxFields(e)) };
  const identifiers = new Set(merged.identifierTypes.map((i) => i.key));
  checkTaxSetup(merged.taxes, add);
  const entities = new Map(merged.entities.map((e) => [e.key, e]));
  const picklists = new Set(merged.picklists.map((p) => p.key));
  const numbering = new Set(merged.numbering.map((n) => n.key));

  for (const e of merged.entities) {
    const base = `entities.${e.key}`;
    if (!e.kind || !e.label || !e.pluralLabel) add(base, 'Entity needs a name and a plural name');
    const isSystem = (SYSTEM_ENTITY_KEYS as readonly string[]).includes(e.key);
    if (e.kind === 'custom' && isSystem) add(base, `"${e.key}" is a built-in entity`);
    if (e.kind === 'system' && !isSystem) add(base, 'Only built-in entities can be of kind system');

    const fieldKeys = new Set(e.fields.map((f) => f.key));
    if (e.titleField && !fieldKeys.has(e.titleField))
      add(`${base}.titleField`, `Unknown field "${e.titleField}"`);

    const formulaDeps = new Map<string, string[]>();
    for (const f of e.fields) {
      const p = `${base}.fields.${f.key}`;
      if (RESERVED_FIELD_KEYS.has(f.key) || NATIVE_FIELDS[e.key]?.includes(f.key)) {
        add(p, `"${f.key}" is reserved`);
      }
      checkField(f, p, add, {
        entities,
        picklists,
        numbering,
        fieldKeys,
        archived: e.archived || f.archived,
      });
      checkDefaultFrom(f, e.fields, entities, p, add);
      for (const c of f.type === 'table' ? (f.columns ?? []) : [])
        checkDefaultFrom(
          c,
          [...(f.columns ?? []), ...e.fields],
          entities,
          `${p}.columns.${c.key}`,
          add,
        );
      if (f.identifier) {
        if (!['text'].includes(f.type))
          add(p, 'Only text fields can be validated as an identifier');
        else if (!identifiers.has(f.identifier))
          add(p, `Unknown identifier type "${f.identifier}"`);
      }
      if (isSystem && (UNSUPPORTED_ON_SYSTEM.has(f.type) || f.unique)) {
        add(p, `${f.unique ? 'Unique' : f.type} fields are not available on built-in entities yet`);
      }
      if (f.type === 'formula' && f.formula) {
        try {
          const compiled = compileFormula(f.formula);
          for (const d of unknownFormulaNames(compiled.fields, e.fields))
            add(`${p}.formula`, `Unknown field "${d}" in formula`);
          if (compiled.context.length) {
            add(`${p}.formula`, `${compiled.context[0]} can only be used in rules and workflows`);
          }
          formulaDeps.set(f.key, formulaFieldKeys(compiled.fields));
        } catch (err) {
          add(`${p}.formula`, err instanceof FormulaError ? err.message : 'Invalid formula');
        }
      }
    }
    const cycle = findCycle(formulaDeps);
    if (cycle)
      add(`${base}.fields`, `Formulas refer to each other in a loop: ${cycle.join(' → ')}`);
    if (e.tax)
      checkEntityTax(
        e,
        raw.entities.find((x) => x.key === e.key)!,
        base,
        add,
      );
  }

  const columnOk = (entity: EntityPatch, col: string) =>
    (SYSTEM_COLUMNS as readonly string[]).includes(col) || entity.fields.some((f) => f.key === col);

  for (const form of merged.forms) {
    const e = entities.get(form.entity);
    const p = `forms.${form.entity}`;
    if (!e) {
      add(p, `Unknown entity "${form.entity}"`);
      continue;
    }
    const placed = new Set<string>();
    for (const s of form.sections) {
      for (const k of s.fields) {
        if (!e.fields.some((f) => f.key === k)) add(`${p}.${s.key}`, `Unknown field "${k}"`);
        if (placed.has(k)) add(`${p}.${s.key}`, `Field "${k}" is placed twice`);
        placed.add(k);
      }
    }
  }
  for (const view of merged.listViews) {
    const e = entities.get(view.entity);
    const p = `listViews.${view.entity}`;
    if (!e) {
      add(p, `Unknown entity "${view.entity}"`);
      continue;
    }
    for (const c of view.columns) if (!columnOk(e, c)) add(p, `Unknown column "${c}"`);
    if (view.sort && !columnOk(e, view.sort.field))
      add(p, `Unknown sort column "${view.sort.field}"`);
  }
  for (const n of merged.numbering) {
    for (const m of validateNumberingPattern(n.pattern)) add(`numbering.${n.key}.pattern`, m);
  }
  checkAutomationItems(normalizeLayer(merged), add);
  checkOutputItems(normalizeLayer(merged), add);
}

function checkField(
  f: FieldDef,
  p: string,
  add: (path: string, message: string) => void,
  refs: {
    entities: Map<string, EntityPatch>;
    picklists: Set<string>;
    numbering: Set<string>;
    fieldKeys: Set<string>;
    /** The field or its entity is archived: links to other archived entities are fine. */
    archived?: boolean;
  },
): void {
  switch (f.type) {
    case 'select':
    case 'multiselect':
      if (!f.picklist) add(p, 'Choose the list of options');
      else if (!refs.picklists.has(f.picklist)) add(p, `Unknown option list "${f.picklist}"`);
      break;
    case 'lookup':
    case 'lookup_many': {
      const target = f.target && refs.entities.get(f.target);
      if (!f.target) add(p, 'Choose which entity this field links to');
      else if (!target) add(p, `Unknown entity "${f.target}"`);
      else if (target.archived && !refs.archived && !f.archived)
        add(p, `Entity "${f.target}" is archived`);
      break;
    }
    case 'formula':
      if (!f.formula) add(p, 'Enter the formula');
      if (!f.resultType) add(p, 'Choose the result type of the formula');
      if (f.required || f.unique) add(p, 'Calculated fields cannot be required or unique');
      break;
    case 'autonumber':
      if (!f.numbering) add(p, 'Choose the number series');
      else if (!refs.numbering.has(f.numbering)) add(p, `Unknown number series "${f.numbering}"`);
      break;
    case 'table':
      checkTableColumns(f, p, add, refs);
      break;
    case 'text':
    case 'longtext':
      if (f.pattern) {
        try {
          new RegExp(f.pattern);
        } catch {
          add(p, 'Invalid pattern');
        }
      }
      if (f.minLength !== undefined && f.maxLength !== undefined && f.minLength > f.maxLength) {
        add(p, 'Minimum length is greater than maximum length');
      }
      break;
  }
  if (f.min !== undefined && f.max !== undefined && f.min > f.max)
    add(p, 'Minimum is greater than maximum');
  if (
    f.unique &&
    ['multiselect', 'lookup_many', 'file', 'image', 'longtext', 'boolean'].includes(f.type)
  ) {
    add(p, `A ${f.type} field cannot be unique`);
  }
}

/** Columns of a table field: simple field types, formulas over the same row only. */
function checkTableColumns(
  f: FieldDef,
  p: string,
  add: (path: string, message: string) => void,
  refs: Parameters<typeof checkField>[3],
): void {
  if (!f.columns?.length) {
    add(p, 'Add at least one column');
    return;
  }
  if (f.unique) add(p, 'A table field cannot be unique');
  const columnKeys = new Set(f.columns.map((c) => c.key));
  const deps = new Map<string, string[]>();
  for (const c of f.columns) {
    const cp = `${p}.columns.${c.key}`;
    if (!TABLE_COLUMN_TYPES.includes(c.type)) add(cp, `A table column cannot be of type ${c.type}`);
    if (c.unique) add(cp, 'Table columns cannot be unique');
    if (c.type === 'formula' && c.formula) {
      try {
        const compiled = compileFormula(c.formula);
        for (const d of compiled.fields)
          if (!columnKeys.has(d)) add(`${cp}.formula`, `Unknown column "${d}" in formula`);
        if (compiled.context.length)
          add(`${cp}.formula`, `${compiled.context[0]} cannot be used in a column`);
        deps.set(c.key, compiled.fields);
      } catch (err) {
        add(`${cp}.formula`, err instanceof FormulaError ? err.message : 'Invalid formula');
      }
    }
    if (c.type !== 'table') checkField(c, cp, add, { ...refs, fieldKeys: columnKeys });
  }
  const cycle = findCycle(deps);
  if (cycle) add(`${p}.columns`, `Formulas refer to each other in a loop: ${cycle.join(' → ')}`);
}

/**
 * Statutory fields a pack marks `locked` (e.g. GSTIN) can be relabelled or left off forms,
 * but the company and its branches cannot retype or archive them.
 */
function checkLockedFields(config: TenantConfig, issues: ConfigIssue[]): void {
  const packs = mergeLayers(packLayers(config.packs));
  const locked = new Map<string, FieldDef>();
  for (const e of packs.entities)
    for (const f of e.fields) if (f.locked) locked.set(`${e.key}.${f.key}`, f);
  if (!locked.size) return;
  const layers: [string, ConfigLayer][] = [
    ['company', config.company],
    ...Object.entries(config.orgUnits),
  ];
  for (const [scope, layer] of layers) {
    for (const e of layer.entities) {
      for (const f of e.fields) {
        const pack = locked.get(`${e.key}.${f.key}`);
        if (pack && (f.type !== pack.type || f.archived))
          issues.push({
            scope,
            path: `entities.${e.key}.fields.${f.key}`,
            message:
              'This field is required by a Country Pack; it can be relabelled but not retyped or archived',
          });
      }
    }
  }
}

/** `lookup.field`: a lookup among the siblings, and a field of the entity it links to. */
function checkDefaultFrom(
  f: FieldDef,
  siblings: FieldDef[],
  entities: Map<string, EntityPatch>,
  p: string,
  add: (path: string, message: string) => void,
): void {
  if (!f.defaultFrom) return;
  const [lk, fk] = f.defaultFrom.split('.');
  const lookup = siblings.find((x) => x.key === lk);
  if (!lookup || lookup.type !== 'lookup' || !lookup.target) {
    add(p, `"${lk}" in "${f.defaultFrom}" must be a lookup`);
    return;
  }
  const target = entities.get(lookup.target);
  if (!target?.fields.some((x) => x.key === fk)) add(p, `"${lookup.target}" has no field "${fk}"`);
}

/** Tax settings of an entity: the line items and the columns they read. */
function checkEntityTax(
  e: EntityPatch,
  raw: EntityPatch,
  base: string,
  add: (path: string, message: string) => void,
): void {
  const t = e.tax!;
  const p = `${base}.tax`;
  if (!t.lines || !t.amount) {
    add(p, 'Choose the line items table and its amount column');
    return;
  }
  const lines = raw.fields.find((f) => f.key === t.lines);
  if (!lines || lines.type !== 'table') {
    add(p, `"${t.lines}" must be a table field (the line items)`);
    return;
  }
  const cols = new Map((lines.columns ?? []).map((c) => [c.key, c]));
  const amount = cols.get(t.amount);
  const numeric = (c?: FieldDef) =>
    !!c &&
    (['integer', 'decimal', 'currency'].includes(c.type) ||
      (c.type === 'formula' && c.resultType === 'number'));
  if (!numeric(amount)) add(p, `"${t.amount}" must be a number or amount column of ${t.lines}`);
  if (t.category && !cols.has(t.category)) add(p, `Unknown column "${t.category}" in ${t.lines}`);
  if (t.code && !cols.has(t.code)) add(p, `Unknown column "${t.code}" in ${t.lines}`);
  for (const k of TAX_LINE_FIELDS)
    if (cols.has(k)) add(p, `"${k}" is filled by the tax engine; rename that column`);
  for (const k of TAX_RECORD_FIELDS)
    if (raw.fields.some((f) => f.key === k))
      add(p, `"${k}" is filled by the tax engine; rename that field`);
  const fieldKeys = new Set(raw.fields.map((f) => f.key));
  for (const source of [
    t.sellerRegion,
    t.buyerRegion,
    t.buyerCountry,
    t.buyerRegistered,
    t.reverseCharge,
  ]) {
    if (!source) continue;
    const [first] = source.split('.');
    if (first !== 'unit' && !fieldKeys.has(first))
      add(p, `Unknown field "${first}" in "${source}"`);
  }
}

/** Tax data: rules and categories must name existing components. */
function checkTaxSetup(t: TaxSetup | undefined, add: (path: string, message: string) => void) {
  if (!t) return;
  const components = new Set(t.components.map((c) => c.key));
  for (const c of t.categories)
    for (const x of c.extra ?? [])
      if (!components.has(x.component))
        add(`taxes.categories.${c.key}`, `Unknown tax "${x.component}"`);
  for (const r of t.rules) {
    for (const s of r.split)
      if (!components.has(s.component)) add(`taxes.rules.${r.key}`, `Unknown tax "${s.component}"`);
    if (r.condition) {
      try {
        const known = new Set([
          'seller_region',
          'buyer_region',
          'buyer_country',
          'company_country',
          'buyer_registered',
          'reverse_charge',
        ]);
        for (const d of compileFormula(r.condition).fields)
          if (!known.has(d)) add(`taxes.rules.${r.key}`, `Unknown name "${d}" in the condition`);
      } catch (err) {
        add(
          `taxes.rules.${r.key}`,
          err instanceof FormulaError ? err.message : 'Invalid condition',
        );
      }
    }
  }
  if (t.defaultCategory && !t.categories.some((c) => c.key === t.defaultCategory))
    add('taxes.defaultCategory', `Unknown category "${t.defaultCategory}"`);
}

function findCycle(deps: Map<string, string[]>): string[] | undefined {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (k: string): string[] | undefined => {
    if (state.get(k) === 'done') return undefined;
    if (state.get(k) === 'visiting') return [...stack.slice(stack.indexOf(k)), k];
    state.set(k, 'visiting');
    stack.push(k);
    for (const d of deps.get(k) ?? []) {
      if (deps.has(d)) {
        const c = visit(d);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(k, 'done');
    return undefined;
  };
  for (const k of deps.keys()) {
    const c = visit(k);
    if (c) return c;
  }
  return undefined;
}

/** Published entities and fields can be archived but not removed, and only retyped compatibly. */
function checkBreakingChanges(
  scope: string,
  prev: ConfigLayer,
  next: ConfigLayer,
  issues: ConfigIssue[],
): void {
  const add = (path: string, message: string) => issues.push({ scope, path, message });
  const nextEntities = new Map(next.entities.map((e) => [e.key, e]));
  for (const pe of prev.entities) {
    const ne = nextEntities.get(pe.key);
    if (!ne) {
      add(`entities.${pe.key}`, 'A published entity cannot be deleted. Archive it instead.');
      continue;
    }
    const nextFields = new Map(ne.fields.map((f) => [f.key, f]));
    for (const pf of pe.fields) {
      const nf = nextFields.get(pf.key);
      const p = `entities.${pe.key}.fields.${pf.key}`;
      if (!nf) {
        add(p, 'A published field cannot be deleted. Archive it instead, so its data is kept.');
      } else if (nf.type !== pf.type && !COMPATIBLE_CHANGES[pf.type]?.includes(nf.type)) {
        add(p, `Changing the type from ${pf.type} to ${nf.type} would break existing data`);
      } else if (pf.locked && scope !== 'packs' && (nf.type !== pf.type || nf.archived)) {
        // (Packs themselves may retire what they locked, e.g. when a pack is removed.)
        add(p, 'This field comes from a pack and cannot be changed');
      }
    }
  }
}

/**
 * Everything checked before a publish. Returns an empty list when the
 * configuration is safe to publish.
 */
export function validateTenantConfig(
  config: TenantConfig,
  opts: { base: ConfigLayer[]; previous?: TenantConfig },
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const layers: [string, ConfigLayer][] = [
    ['company', config.company],
    ...Object.entries(config.orgUnits),
  ];
  let shapesOk = true;
  for (const [scope, layer] of layers) {
    if (!checkLayerShape(scope, layer, issues)) shapesOk = false;
    else checkDuplicates(scope, layer, issues);
  }
  // Pack content, with the patches applied to the company's entities.
  for (const layer of packLayers(config.packs, config.company))
    if (!checkLayerShape('packs', layer, issues)) shapesOk = false;
  if (!shapesOk) return issues;

  checkMerged('company', mergeLayers(layersFor(opts.base, config)), issues);
  for (const [id, layer] of Object.entries(config.orgUnits)) {
    // The unit's path ends with its own id, so this includes the override itself.
    checkMerged(id, mergeLayers(layersFor(opts.base, config, layer.path)), issues);
  }

  checkLockedFields(config, issues);

  if (opts.previous) {
    // Packs may drop fields between versions only by retiring them (archived, data kept).
    const packsOf = (c: TenantConfig) =>
      mergeLayers([...packLayers(c.packs), ...(c.retired ? [c.retired] : [])]);
    checkBreakingChanges('packs', packsOf(opts.previous), packsOf(config), issues);
    checkBreakingChanges('company', opts.previous.company, config.company, issues);
    for (const [id, prevLayer] of Object.entries(opts.previous.orgUnits)) {
      const nextLayer = config.orgUnits[id];
      if (nextLayer) checkBreakingChanges(id, prevLayer, nextLayer, issues);
      else if (prevLayer.entities.some((e) => e.fields.length)) {
        // Removing a whole override would drop published fields.
        checkBreakingChanges(id, prevLayer, { ...prevLayer, entities: [] }, issues);
      }
    }
  }
  return issues;
}
