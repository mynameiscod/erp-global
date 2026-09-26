import type { DashboardDef } from './dashboards';
import { compileFormula, FormulaError, unknownFormulaNames } from './formula';
import {
  parseTemplate,
  templatePaths,
  TemplateError,
  unsafeHtmlReason,
  type PrintBlock,
  type PrintTemplateDef,
} from './print';
import { isDateType, isNumericType, resolveReportPath, type ResolvedPath } from './report-paths';
import type { ReportAggregate, ReportDef, ReportGroup } from './reports';
import {
  SYSTEM_COLUMNS,
  type ConfigLayer,
  type EntityDef,
  type EntityPatch,
  type FieldDef,
  type LocalizedText,
} from './types';

type Add = (path: string, message: string) => void;

/** Names a print template can use besides the record's own fields. */
export const PRINT_ROOTS = ['company', 'unit', 'today', 'copy', 'printedBy'] as const;

const complete = (e: EntityPatch): e is EntityDef => !!e.kind && !!e.label && !!e.pluralLabel;

/** A condition or value formula over one record: fields, table columns and STATUS(). */
function checkRecordFormula(src: string | undefined, fields: FieldDef[], path: string, add: Add) {
  if (!src?.trim()) return;
  try {
    const f = compileFormula(src);
    for (const d of unknownFormulaNames(f.fields, fields)) add(path, `Unknown field "${d}"`);
    const ctx = f.context.filter((c) => c !== 'STATUS()');
    if (ctx.length) add(path, `${ctx[0]} cannot be used in documents and reports`);
  } catch (e) {
    add(path, e instanceof FormulaError ? e.message : 'Invalid formula');
  }
}

/** Placeholders must name a field (optionally of a linked record), a system column or a print root. */
function checkTemplateText(
  text: string | LocalizedText | undefined,
  entity: EntityDef,
  entities: Map<string, EntityPatch>,
  path: string,
  add: Add,
): void {
  if (text === undefined) return;
  const sources = typeof text === 'string' ? [text] : Object.values(text);
  for (const src of sources) {
    try {
      for (const p of templatePaths(parseTemplate(src))) {
        const problem = placeholderProblem(p, entity, entities);
        if (problem) add(path, problem);
      }
    } catch (e) {
      add(path, e instanceof TemplateError ? e.message : 'Invalid placeholder');
    }
  }
}

function placeholderProblem(
  p: string,
  entity: EntityDef,
  entities: Map<string, EntityPatch>,
): string | undefined {
  const [first, ...rest] = p.split('.');
  if ((PRINT_ROOTS as readonly string[]).includes(first)) return undefined;
  if ((SYSTEM_COLUMNS as readonly string[]).includes(first)) return undefined;
  const f = entity.fields.find((x) => x.key === first);
  if (!f) return `Unknown field "${first}" in {{${p}}}`;
  if (!rest.length) return undefined;
  if (f.type === 'lookup' && f.target && entities.has(f.target)) {
    const target = entities.get(f.target)!;
    const next = rest[0];
    if (
      !(SYSTEM_COLUMNS as readonly string[]).includes(next) &&
      next !== 'name' &&
      !target.fields.some((x) => x.key === next)
    ) {
      return `Unknown field "${next}" in {{${p}}}`;
    }
    return undefined;
  }
  if (f.type === 'currency' && ['amount', 'currency'].includes(rest[0])) return undefined;
  return `"${first}" has no field "${rest[0]}"`;
}

function checkBlock(
  b: PrintBlock,
  entity: EntityDef,
  entities: Map<string, EntityPatch>,
  path: string,
  add: Add,
): void {
  checkRecordFormula(b.condition, entity.fields, `${path}.condition`, add);
  const text = (t: string | LocalizedText | undefined, p = path) =>
    checkTemplateText(t, entity, entities, p, add);
  switch (b.type) {
    case 'letterhead':
      b.lines.forEach((l) => text(l));
      break;
    case 'title':
    case 'text':
      text(b.text);
      break;
    case 'fields':
      for (const i of b.items) {
        const problem = placeholderProblem(i.path, entity, entities);
        if (problem) add(path, problem);
      }
      break;
    case 'table': {
      let columnFields: FieldDef[] | undefined;
      if (b.source.startsWith('related:')) {
        const [rel, field] = b.source.slice('related:'.length).split('.');
        const other = entities.get(rel);
        const link = other?.fields.find((f) => f.key === field);
        if (!other) add(path, `Unknown entity "${rel}"`);
        else if (!link || link.type !== 'lookup' || link.target !== entity.key) {
          add(path, `"${rel}.${field}" must be a field that links to ${entity.key}`);
        } else columnFields = other.fields;
      } else {
        const table = entity.fields.find((f) => f.key === b.source);
        if (!table || table.type !== 'table') add(path, `"${b.source}" is not a table field`);
        else columnFields = table.columns ?? [];
      }
      if (columnFields) {
        const keys = new Set([...columnFields.map((f) => f.key), ...SYSTEM_COLUMNS]);
        for (const c of b.columns) {
          if (!keys.has(c.path.split('.')[0])) add(path, `Unknown column "${c.path}"`);
        }
        for (const t of b.totals ?? []) {
          if (!b.columns.some((c) => c.path === t))
            add(path, `Total of "${t}", which is not shown`);
        }
      }
      break;
    }
    case 'totals':
      b.rows.forEach((r, i) =>
        checkRecordFormula(r.value, entity.fields, `${path}.rows.${i}`, add),
      );
      if (b.words) checkRecordFormula(b.words.value, entity.fields, `${path}.words`, add);
      break;
    case 'qr':
    case 'barcode':
      text(b.value);
      break;
  }
}

function checkPrintTemplate(
  t: PrintTemplateDef,
  entities: Map<string, EntityPatch>,
  add: Add,
): void {
  const p = `printTemplates.${t.key}`;
  const e = entities.get(t.entity);
  if (!e || !complete(e) || e.kind !== 'custom') {
    add(p, `Unknown entity "${t.entity}"`);
    return;
  }
  if (t.mode === 'blocks') {
    if (!t.blocks?.length) add(p, 'Add at least one block');
    const ids = new Set<string>();
    for (const b of t.blocks ?? []) {
      if (ids.has(b.id)) add(`${p}.blocks.${b.id}`, 'Duplicate block id');
      ids.add(b.id);
      checkBlock(b, e, entities, `${p}.blocks.${b.id}`, add);
    }
  } else {
    if (!t.html?.trim()) add(p, 'Enter the HTML of the template');
    const unsafe = unsafeHtmlReason(`${t.html ?? ''}\n${t.css ?? ''}`);
    if (unsafe) add(`${p}.html`, unsafe);
    checkTemplateText(t.html, e, entities, `${p}.html`, add);
  }
  for (const [i, w] of (t.watermarks ?? []).entries())
    checkRecordFormula(w.condition, e.fields, `${p}.watermarks.${i}`, add);
  checkTemplateText(t.footer?.text, e, entities, `${p}.footer`, add);
  checkTemplateText(t.fileName, e, entities, `${p}.fileName`, add);
}

// ---- reports ----

function resolved(
  all: EntityDef[],
  entity: string,
  path: string,
  where: string,
  add: Add,
): ResolvedPath | undefined {
  const r = resolveReportPath(all, entity, path);
  if (typeof r === 'string') {
    add(where, r);
    return undefined;
  }
  return r;
}

function checkGroup(all: EntityDef[], r: ReportDef, g: ReportGroup, where: string, add: Add) {
  const res = resolved(all, r.entity, g.path, where, add);
  if (!res) return;
  if (g.bucket && !isDateType(res.type)) add(where, `"${g.path}" is not a date`);
  if (['longtext', 'file', 'image', 'lookup_many', 'multiselect'].includes(res.type))
    add(where, `Records cannot be grouped by "${g.path}"`);
}

function checkAggregate(
  all: EntityDef[],
  r: ReportDef,
  a: ReportAggregate,
  where: string,
  add: Add,
) {
  if (a.fn === 'count') return;
  if (!a.path) {
    add(where, 'Choose the column to add up');
    return;
  }
  const res = resolved(all, r.entity, a.path, where, add);
  if (!res) return;
  if ((a.fn === 'sum' || a.fn === 'avg') && !isNumericType(res.type))
    add(where, `"${a.path}" is not a number`);
  if ((a.fn === 'min' || a.fn === 'max') && !isNumericType(res.type) && !isDateType(res.type))
    add(where, `"${a.path}" is not a number or date`);
}

function checkReport(r: ReportDef, all: EntityDef[], add: Add): void {
  const p = `reports.${r.key}`;
  const e = all.find((x) => x.key === r.entity);
  if (!e || e.kind !== 'custom') {
    add(p, `Unknown entity "${r.entity}"`);
    return;
  }
  r.columns.forEach((c, i) => resolved(all, r.entity, c.path, `${p}.columns.${i}`, add));
  for (const [i, f] of r.filters.entries()) {
    const where = `${p}.filters.${i}`;
    const res = resolved(all, r.entity, f.path, where, add);
    if (!res) continue;
    if (f.op === 'relative') {
      if (!isDateType(res.type)) add(where, `"${f.path}" is not a date`);
      if (!f.relative) add(where, 'Choose the period');
    }
    if (f.op === 'between' && !(Array.isArray(f.value) && f.value.length === 2))
      add(where, 'Enter a from and a to value');
    if (f.op === 'in' && !Array.isArray(f.value)) add(where, 'Choose one or more values');
  }
  (r.sort ?? []).forEach((s, i) => resolved(all, r.entity, s.path, `${p}.sort.${i}`, add));
  (r.groupBy ?? []).forEach((g, i) => checkGroup(all, r, g, `${p}.groupBy.${i}`, add));
  (r.aggregates ?? []).forEach((a, i) => checkAggregate(all, r, a, `${p}.aggregates.${i}`, add));
  if (r.pivot) {
    if (r.groupBy?.length) add(p, 'A report is either grouped or a pivot, not both');
    r.pivot.rows.forEach((g, i) => checkGroup(all, r, g, `${p}.pivot.rows.${i}`, add));
    checkGroup(all, r, r.pivot.column, `${p}.pivot.column`, add);
    r.pivot.values.forEach((a, i) => checkAggregate(all, r, a, `${p}.pivot.values.${i}`, add));
  }
  if (r.groupBy?.length && !r.aggregates?.length)
    add(p, 'A grouped report needs a total, e.g. Count');
  if (!r.groupBy?.length && !r.pivot && !r.columns.length && !r.aggregates?.length)
    add(p, 'Choose the columns to show');
  if (r.chart && !r.groupBy?.length && !r.pivot)
    add(`${p}.chart`, 'A chart needs a group, e.g. by month');
  if (r.chart?.type === 'stacked_bar' && (r.groupBy?.length ?? 0) < 2 && !r.pivot)
    add(`${p}.chart`, 'A stacked bar needs two groups');
  if (r.dateField) {
    const res = resolved(all, r.entity, r.dateField, `${p}.dateField`, add);
    if (res && !isDateType(res.type)) add(`${p}.dateField`, `"${r.dateField}" is not a date`);
  }
}

function checkDashboard(d: DashboardDef, reports: Set<string>, add: Add): void {
  const p = `dashboards.${d.key}`;
  const ids = new Set<string>();
  for (const w of d.widgets) {
    if (ids.has(w.id)) add(`${p}.widgets.${w.id}`, 'Duplicate widget id');
    ids.add(w.id);
    if (!w.report) continue;
    if (w.report.startsWith('my:'))
      add(`${p}.widgets.${w.id}`, 'Company dashboards can only show company reports');
    else if (!reports.has(w.report)) add(`${p}.widgets.${w.id}`, `Unknown report "${w.report}"`);
  }
}

/** Print templates, reports and dashboards of one merged configuration. */
export function checkOutputItems(merged: ConfigLayer, add: Add): void {
  const entities = new Map(merged.entities.map((e) => [e.key, e]));
  const all = merged.entities.filter(complete);
  for (const t of merged.printTemplates) checkPrintTemplate(t, entities, add);
  for (const r of merged.reports) checkReport(r, all, add);
  const reportKeys = new Set(merged.reports.map((r) => r.key));
  for (const d of merged.dashboards) checkDashboard(d, reportKeys, add);
}

/** Checks one personal report (reporting-service) against the published entities. */
export function checkPersonalReport(
  r: ReportDef,
  entities: EntityDef[],
): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  checkReport(r, entities, (path, message) => issues.push({ path, message }));
  return issues;
}
