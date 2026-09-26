import { z } from 'zod';
import { keySchema, localizedTextSchema, objectId } from './schema-base';
import type { LocalizedText } from './types';

/**
 * Reports: a checked description of a query over one entity's records. It never
 * holds database commands; records-service compiles it and always applies the
 * viewer's own access.
 */

/**
 * A column of the report's entity (`amount`), a system column (`createdAt`, `orgUnitId`),
 * or a field of a linked record, up to two hops (`student.class.name`).
 */
export type ReportPath = string;

export const DATE_BUCKETS = ['day', 'week', 'month', 'quarter', 'year', 'fiscal_year'] as const;
export type DateBucket = (typeof DATE_BUCKETS)[number];

export interface ReportGroup {
  path: ReportPath;
  /** For date fields: group by day, week, month, (fiscal) quarter, year or fiscal year. */
  bucket?: DateBucket;
}

export const AGGREGATE_FNS = ['count', 'sum', 'avg', 'min', 'max', 'count_distinct'] as const;
export type AggregateFn = (typeof AGGREGATE_FNS)[number];

export interface ReportAggregate {
  fn: AggregateFn;
  /** Not needed for `count`. */
  path?: ReportPath;
  label?: LocalizedText;
}

export const FILTER_OPS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'contains',
  'empty',
  'not_empty',
  'between',
  'relative',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const RELATIVE_DATES = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'this_quarter',
  'last_quarter',
  'this_fiscal_year',
  'last_fiscal_year',
  'last_n_days',
  'next_n_days',
] as const;
export type RelativeDate = (typeof RELATIVE_DATES)[number];

export type FilterValue = string | number | boolean | null;

export interface ReportFilter {
  path: ReportPath;
  op: FilterOp;
  /** `in`: a list; `between`: [from, to]; `relative`: a period (and `n` for last/next n days). */
  value?: FilterValue | FilterValue[];
  relative?: { period: RelativeDate; n?: number };
  /** The viewer can change this filter when running the report. */
  prompt?: boolean;
  label?: LocalizedText;
}

export const CHART_TYPES = ['bar', 'line', 'area', 'pie', 'donut', 'stacked_bar'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export interface ReportDef {
  key: string;
  label: LocalizedText;
  description?: LocalizedText;
  entity: string;
  /** Rows of records: the columns shown. Grouped and pivot reports show their groups instead. */
  columns: { path: ReportPath; label?: LocalizedText }[];
  filters: ReportFilter[];
  sort?: { path: ReportPath; dir: 'asc' | 'desc' }[];
  /** Up to three levels, with subtotals. */
  groupBy?: ReportGroup[];
  aggregates?: ReportAggregate[];
  /** Rows × one column group, e.g. branch × month. */
  pivot?: { rows: ReportGroup[]; column: ReportGroup; values: ReportAggregate[] };
  /** Chart of the first group level (the second for stacked bars) and the first aggregate. */
  chart?: { type: ChartType };
  /** The date field dashboards filter on (e.g. `paid_on`); default `createdAt`. */
  dateField?: ReportPath;
  /** Company reports: roles that see the report. Empty: everyone who can read the entity. */
  roleIds?: string[];
}

// ---- schema ----

const pathSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,2}$/, 'Invalid column');
const group = z.object({ path: pathSchema, bucket: z.enum(DATE_BUCKETS).optional() }).strict();
const aggregate = z
  .object({
    fn: z.enum(AGGREGATE_FNS),
    path: pathSchema.optional(),
    label: localizedTextSchema.optional(),
  })
  .strict();
const scalar = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);

export const reportFilterSchema = z
  .object({
    path: pathSchema,
    op: z.enum(FILTER_OPS),
    value: z.union([scalar, z.array(scalar).max(200)]).optional(),
    relative: z
      .object({
        period: z.enum(RELATIVE_DATES),
        n: z.number().int().min(1).max(3660).optional(),
      })
      .strict()
      .optional(),
    prompt: z.boolean().optional(),
    label: localizedTextSchema.optional(),
  })
  .strict();

export const reportSchema = z
  .object({
    key: keySchema,
    label: localizedTextSchema,
    description: localizedTextSchema.optional(),
    entity: keySchema,
    columns: z
      .array(z.object({ path: pathSchema, label: localizedTextSchema.optional() }).strict())
      .max(50),
    filters: z.array(reportFilterSchema).max(30),
    sort: z
      .array(z.object({ path: pathSchema, dir: z.enum(['asc', 'desc']) }).strict())
      .max(5)
      .optional(),
    groupBy: z.array(group).max(3).optional(),
    aggregates: z.array(aggregate).max(10).optional(),
    pivot: z
      .object({
        rows: z.array(group).min(1).max(2),
        column: group,
        values: z.array(aggregate).min(1).max(3),
      })
      .strict()
      .optional(),
    chart: z
      .object({ type: z.enum(CHART_TYPES) })
      .strict()
      .optional(),
    dateField: pathSchema.optional(),
    roleIds: z.array(objectId).max(50).optional(),
  })
  .strict();

/** What the viewer sends when running a report. */
export const reportRunParamsSchema = z
  .object({
    /** New values for `prompt` filters, by their position in `filters`. */
    filters: z.record(z.string().regex(/^\d{1,2}$/), reportFilterSchema.partial()).optional(),
    /** Dashboard filters: a date range on `dateField`, and an org unit. */
    dateRange: z.object({ from: z.string().date(), to: z.string().date() }).strict().optional(),
    orgUnitId: objectId.optional(),
    /** Drill-down: rows of one group (values as returned in the group keys). */
    drill: z
      .array(z.object({ path: pathSchema, bucket: z.enum(DATE_BUCKETS).optional(), value: scalar }))
      .max(4)
      .optional(),
    page: z.number().int().min(1).max(10_000).optional(),
    pageSize: z.number().int().min(1).max(5_000).optional(),
  })
  .strict();
export type ReportRunParams = z.infer<typeof reportRunParamsSchema>;

/** The shape of a report run, whatever its kind. */
export type ReportResult =
  | {
      kind: 'rows';
      columns: ResultColumn[];
      rows: Record<string, unknown>[];
      total: number;
      page: number;
      pageSize: number;
    }
  | {
      kind: 'groups';
      /** Group columns, then aggregate columns. */
      columns: ResultColumn[];
      /** Leaf groups, in order. `level` is 0 for the deepest level. */
      rows: GroupRow[];
      /** Subtotals per upper level, keyed like `rows`, and the grand total. */
      subtotals: GroupRow[];
      grandTotal: Record<string, unknown>;
      truncated: boolean;
    }
  | {
      kind: 'pivot';
      rowColumns: ResultColumn[];
      /** Distinct values of the column group, in order. */
      columnKeys: { key: string; label: string }[];
      values: ResultColumn[];
      /** `cells[columnKey][valueKey]`, plus row totals under `__total`. */
      rows: {
        keys: Record<string, unknown>;
        labels: Record<string, string>;
        cells: Record<string, Record<string, unknown>>;
      }[];
      columnTotals: Record<string, Record<string, unknown>>;
      grandTotal: Record<string, unknown>;
      truncated: boolean;
    };

export interface ResultColumn {
  key: string;
  label: string;
  /** Field type of the value, for formatting: text, number, currency, date, datetime… */
  type: string;
  currency?: string;
}

export interface GroupRow {
  level: number;
  /** Raw group values by group key (`g0`, `g1`…), usable for drill-down. */
  keys: Record<string, unknown>;
  /** Display text of each group value. */
  labels: Record<string, string>;
  /** Aggregates by key (`a0`, `a1`…). */
  values: Record<string, unknown>;
}
