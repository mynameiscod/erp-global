import { compileFormula, FormulaError, formulaFieldKeys, unknownFormulaNames } from './formula';
import { layersFor, mergeLayers } from './merge';
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
function checkMerged(scope: string, merged: ConfigLayer, issues: ConfigIssue[]): void {
  const add = (path: string, message: string) => issues.push({ scope, path, message });
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
      checkField(f, p, add, { entities, picklists, numbering, fieldKeys });
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
      else if (target.archived) add(p, `Entity "${f.target}" is archived`);
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
      } else if (pf.locked && (nf.type !== pf.type || nf.archived)) {
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
  if (!shapesOk) return issues;

  checkMerged('company', mergeLayers([...opts.base, config.company]), issues);
  for (const [id, layer] of Object.entries(config.orgUnits)) {
    // The unit's path ends with its own id, so this includes the override itself.
    checkMerged(id, mergeLayers(layersFor(opts.base, config, layer.path)), issues);
  }

  if (opts.previous) {
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
