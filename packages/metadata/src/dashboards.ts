import { z } from 'zod';
import { keySchema, localizedTextSchema, longLocalized, objectId } from './schema-base';
import type { ChartType } from './reports';
import { CHART_TYPES } from './reports';
import type { LocalizedText } from './types';

/** Dashboards: a grid of widgets, most of them fed by a report. */

export const WIDGET_TYPES = [
  'kpi',
  'chart',
  'list',
  'approvals',
  'notifications',
  'text',
  'links',
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export interface DashboardWidget {
  id: string;
  type: WidgetType;
  title?: LocalizedText;
  /** Position on a 12-column grid. */
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * The report behind a kpi, chart or list: a company report key, or `my:<id>` for
   * a personal report.
   */
  report?: string;
  /** KPI: which aggregate of the report (default the first), and compare with the period before. */
  kpi?: { aggregate?: number; compare?: boolean };
  /** Chart: overrides the report's chart type. */
  chart?: { type: ChartType };
  /** List: how many rows. */
  limit?: number;
  text?: LocalizedText;
  links?: { label: LocalizedText; href: string }[];
}

export interface DashboardDef {
  key: string;
  label: LocalizedText;
  /** Roles the dashboard is for. Empty: everyone. */
  roleIds?: string[];
  /** The same, by role key (used by packs). */
  roleKeys?: string[];
  /** The home dashboard of these roles. */
  home?: boolean;
  /** Filters that apply to every widget. */
  filters?: { dateRange?: boolean; orgUnit?: boolean };
  widgets: DashboardWidget[];
}

const reportRef = z.string().regex(/^([a-z][a-z0-9_]{1,39}|my:[a-f0-9]{24})$/, 'Choose a report');

export const dashboardWidgetSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    type: z.enum(WIDGET_TYPES),
    title: localizedTextSchema.optional(),
    x: z.number().int().min(0).max(11),
    y: z.number().int().min(0).max(200),
    w: z.number().int().min(1).max(12),
    h: z.number().int().min(1).max(12),
    report: reportRef.optional(),
    kpi: z
      .object({
        aggregate: z.number().int().min(0).max(9).optional(),
        compare: z.boolean().optional(),
      })
      .strict()
      .optional(),
    chart: z
      .object({ type: z.enum(CHART_TYPES) })
      .strict()
      .optional(),
    limit: z.number().int().min(1).max(50).optional(),
    text: longLocalized.optional(),
    links: z
      .array(
        z
          .object({
            label: localizedTextSchema,
            // Paths inside the app only, e.g. /r/admission/new
            href: z.string().regex(/^\/[A-Za-z0-9_\-/?=&.]{0,200}$/, 'Use a path in the app'),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict()
  .superRefine((w, ctx) => {
    if (['kpi', 'chart', 'list'].includes(w.type) && !w.report) {
      ctx.addIssue({ code: 'custom', path: ['report'], message: 'Choose a report' });
    }
    if (w.x + w.w > 12) {
      ctx.addIssue({ code: 'custom', path: ['w'], message: 'The widget is wider than the grid' });
    }
  });

export const dashboardSchema = z
  .object({
    key: keySchema,
    label: localizedTextSchema,
    roleIds: z.array(objectId).max(50).optional(),
    roleKeys: z.array(keySchema).max(50).optional(),
    home: z.boolean().optional(),
    filters: z
      .object({ dateRange: z.boolean().optional(), orgUnit: z.boolean().optional() })
      .strict()
      .optional(),
    widgets: z.array(dashboardWidgetSchema).max(40),
  })
  .strict();
