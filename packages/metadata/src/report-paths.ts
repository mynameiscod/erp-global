import { pickText } from './i18n';
import type { EntityDef, FieldDef, LocalizedText, SystemColumn } from './types';
import { SYSTEM_COLUMNS } from './types';

/** Types of the columns every record has. */
export const SYSTEM_COLUMN_TYPES: Record<SystemColumn, string> = {
  number: 'text',
  status: 'status',
  createdAt: 'datetime',
  updatedAt: 'datetime',
  createdBy: 'user',
  updatedBy: 'user',
  orgUnitId: 'org_unit',
};

/** Names of the system columns, for reports and printed documents. */
export const SYSTEM_LABELS: Record<SystemColumn, LocalizedText> = {
  number: { en: 'Number', hi: 'संख्या', te: 'సంఖ్య', ar: 'الرقم' },
  status: { en: 'Status', hi: 'स्थिति', te: 'స్థితి', ar: 'الحالة' },
  createdAt: { en: 'Created', hi: 'बनाया गया', te: 'సృష్టించబడింది', ar: 'تاريخ الإنشاء' },
  updatedAt: { en: 'Updated' },
  createdBy: { en: 'Created by' },
  updatedBy: { en: 'Updated by' },
  orgUnitId: { en: 'Organization unit' },
};

/** Report paths may follow at most this many links (`student.class.name` is two). */
export const MAX_REPORT_HOPS = 2;

export interface ResolvedPath {
  path: string;
  /** Set when the path reads a line item column (line-item reports). */
  line?: string;
  /** Links followed from the report's entity; each is a lookup to a custom entity. */
  hops: { field: FieldDef; target: string }[];
  /** The entity the final column belongs to. */
  entity: string;
  /** The final field, or undefined for a system column. */
  field?: FieldDef;
  system?: SystemColumn;
  /**
   * Field type of the value (`currency`, `date`…), `status`, `user` or `org_unit`.
   * Formula fields report their result type (`number`, `text`, `boolean`, `date`).
   */
  type: string;
  /** Labels of each step, for "Student › Class › Name". */
  labels: LocalizedText[];
}

const NUMERIC = new Set(['integer', 'decimal', 'currency', 'percent', 'number']);
const DATES = new Set(['date', 'datetime']);

export const isNumericType = (type: string) => NUMERIC.has(type);
export const isDateType = (type: string) => DATES.has(type);

/**
 * Resolves a report column path against the configuration. Returns an error message
 * when the path does not exist or cannot be used.
 */
export function resolveReportPath(
  entities: Pick<EntityDef, 'key' | 'kind' | 'fields' | 'label'>[],
  entityKey: string,
  path: string,
  lines?: string,
): ResolvedPath | string {
  const byKey = new Map(entities.map((e) => [e.key, e]));
  const segments = path.split('.');
  // Line-item reports: `lines.column` is a column of the line.
  if (lines && segments[0] === lines) {
    const table = byKey.get(entityKey)?.fields.find((f) => f.key === lines && f.type === 'table');
    if (!table) return `"${lines}" is not a table field`;
    const column = table.columns?.find((c) => c.key === segments[1]);
    if (!column || segments.length !== 2) return `Unknown column "${path}"`;
    const type = column.type === 'formula' ? (column.resultType ?? 'text') : column.type;
    return {
      path,
      line: lines,
      hops: [],
      entity: entityKey,
      field: column,
      type,
      labels: [table.label, column.label],
    };
  }
  if (segments.length > MAX_REPORT_HOPS + 1) return `"${path}" follows too many links`;
  let entity = byKey.get(entityKey);
  if (!entity) return `Unknown entity "${entityKey}"`;
  const hops: ResolvedPath['hops'] = [];
  const labels: LocalizedText[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const last = i === segments.length - 1;
    if (last && (SYSTEM_COLUMNS as readonly string[]).includes(seg)) {
      const system = seg as SystemColumn;
      labels.push(SYSTEM_LABELS[system]);
      return { path, hops, entity: entity.key, system, type: SYSTEM_COLUMN_TYPES[system], labels };
    }
    const field = entity.fields.find((f) => f.key === seg);
    if (!field) return `Unknown field "${seg}" in "${path}"`;
    labels.push(field.label);
    if (last) {
      if (field.type === 'table')
        return `"${path}" is a table; choose one of its columns in the table's own report`;
      const type = field.type === 'formula' ? (field.resultType ?? 'text') : field.type;
      return { path, hops, entity: entity.key, field, type, labels };
    }
    if (field.type !== 'lookup' || !field.target) return `"${seg}" is not a link to another record`;
    const target = byKey.get(field.target);
    if (!target || target.kind !== 'custom') {
      return `Fields of "${field.target}" cannot be used in reports yet; show "${seg}" itself`;
    }
    hops.push({ field, target: target.key });
    entity = target;
  }
  return `Invalid column "${path}"`;
}

/** "Student › Class › Name" in the reader's language. */
export function reportPathLabel(resolved: ResolvedPath, lang: string): string {
  return resolved.labels.map((l) => pickText(l, lang)).join(' › ');
}
