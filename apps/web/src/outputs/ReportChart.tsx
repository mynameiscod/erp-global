import { useMemo } from 'react';
import { AllCommunityModule, ModuleRegistry, type AgChartOptions } from 'ag-charts-community';
import { AgCharts } from 'ag-charts-react';
import { useTranslation } from 'react-i18next';
import type { ChartType, ReportResult } from '@erp/metadata';
import { formatCell, type CellFormat } from './ReportView';

ModuleRegistry.registerModules([AllCommunityModule]);

/**
 * A chart of a grouped or pivot report: the first group along the axis, the first total
 * as the height. Stacked bars use the second group (or the pivot's columns) as series.
 */
export function ReportChart({
  result,
  type,
  format,
  height = 320,
  onDrill,
}: {
  result: ReportResult;
  type: ChartType;
  format: CellFormat;
  height?: number;
  onDrill?: (keys: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const dark =
    typeof document !== 'undefined' && document.documentElement.dataset.bsTheme === 'dark';
  const options = useMemo<AgChartOptions | null>(() => {
    const theme = dark ? 'ag-default-dark' : 'ag-default';
    let data: Record<string, unknown>[] = [];
    let series: AgChartOptions['series'] = [];
    let valueCol;
    if (result.kind === 'groups') {
      valueCol = result.columns.find((c) => c.key === 'a0');
      const depth = result.columns.filter((c) => /^g\d+$/.test(c.key)).length;
      if (type === 'stacked_bar' && depth >= 2) {
        // One bar per first-level group, stacked by the second level.
        const seriesKeys = [...new Set(result.rows.map((r) => r.labels.g1 || '—'))];
        const byX = new Map<string, Record<string, unknown>>();
        for (const r of result.rows) {
          const x = r.labels.g0 || '—';
          const row = byX.get(x) ?? { x, __keys: { g0: r.keys.g0 } };
          row[r.labels.g1 || '—'] = r.values.a0;
          byX.set(x, row);
        }
        data = [...byX.values()];
        series = seriesKeys.map((k) => ({
          type: 'bar',
          xKey: 'x',
          yKey: k,
          yName: k,
          stacked: true,
        }));
      } else {
        const leaves =
          depth > 1 ? result.subtotals.filter((s) => s.level === depth - 1) : result.rows;
        data = leaves.map((r) => ({ x: r.labels.g0 || '—', y: r.values.a0, __keys: r.keys }));
      }
    } else if (result.kind === 'pivot') {
      valueCol = result.values[0];
      data = result.rows.map((r) => {
        const row: Record<string, unknown> = { x: r.labels.g0 || '—', __keys: r.keys };
        for (const ck of result.columnKeys)
          row[ck.key] = r.cells[ck.key]?.[result.values[0].key] ?? null;
        row.y = r.cells.__total?.[result.values[0].key] ?? null;
        return row;
      });
      if (type !== 'pie' && type !== 'donut') {
        series = result.columnKeys.map((ck) => ({
          type: type === 'line' ? 'line' : type === 'area' ? 'area' : 'bar',
          xKey: 'x',
          yKey: ck.key,
          yName: ck.label,
          stacked: type === 'stacked_bar' || type === 'area',
        })) as AgChartOptions['series'];
      }
    } else {
      return null;
    }
    const label = (v: unknown) => formatCell(valueCol, v, format);
    const tooltip = {
      renderer: (p: { datum: Record<string, unknown>; yKey?: string; angleKey?: string }) => ({
        content: label(p.datum[p.yKey ?? p.angleKey ?? 'y']),
      }),
    };
    const click = onDrill
      ? {
          listeners: {
            nodeClick: (e: { datum: Record<string, unknown> }) =>
              onDrill(e.datum.__keys as Record<string, unknown>),
          },
        }
      : {};
    if (!series?.length) {
      if (type === 'pie' || type === 'donut') {
        series = [
          {
            type: type === 'donut' ? 'donut' : 'pie',
            angleKey: 'y',
            legendItemKey: 'x',
            calloutLabelKey: 'x',
            ...(type === 'donut' ? { innerRadiusRatio: 0.6 } : {}),
            tooltip,
            ...click,
          },
        ] as AgChartOptions['series'];
      } else {
        series = [
          {
            type: type === 'line' ? 'line' : type === 'area' ? 'area' : 'bar',
            xKey: 'x',
            yKey: 'y',
            yName: valueCol?.label ?? t('reports.value'),
            tooltip,
            ...click,
          },
        ] as AgChartOptions['series'];
      }
    }
    return {
      theme,
      data,
      series,
      height,
      background: { visible: false },
      legend: { enabled: (series?.length ?? 0) > 1 || type === 'pie' || type === 'donut' },
      axes:
        type === 'pie' || type === 'donut'
          ? undefined
          : [
              { type: 'category', position: 'bottom' },
              {
                type: 'number',
                position: 'left',
                label: { formatter: (p: { value: unknown }) => label(p.value) },
              },
            ],
    } as AgChartOptions;
  }, [result, type, format, height, dark, onDrill, t]);

  if (!options) return null;
  return <AgCharts options={options} />;
}
