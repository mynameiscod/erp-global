import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DashboardDef,
  ReportDef,
  ReportResult,
  ReportRunParams,
  ResultColumn,
} from '@erp/metadata';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';

export type ReportKind = 'company' | 'mine' | 'shared';

export interface ReportEntry {
  ref: string;
  kind: ReportKind;
  label: string;
  entity: string;
  def: ReportDef;
  sharedRoleIds: string[];
}

export interface DashboardEntry {
  ref: string;
  kind: ReportKind;
  label: string;
  home: boolean;
  def: DashboardDef;
  sharedRoleIds: string[];
}

export type WidgetData =
  | { kind: 'kpi'; value: unknown; previous?: unknown; column?: ResultColumn }
  | { kind: 'report'; result: ReportResult }
  | { kind: 'error'; message: string };

export interface ExportJob {
  id: string;
  ref: string;
  title: string;
  format: 'xlsx' | 'csv' | 'pdf';
  status: 'queued' | 'running' | 'done' | 'failed';
  fileId: string | null;
  fileName: string | null;
  rows: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ScheduleDto {
  id: string;
  ref: string;
  label: string;
  ownerId: string;
  frequency: 'daily' | 'weekly' | 'monthly';
  at: string;
  weekday: number | null;
  monthDay: number | null;
  formats: ('xlsx' | 'csv' | 'pdf')[];
  recipients: { userIds: string[]; roleIds: string[] };
  skipEmpty: boolean;
  subject: string | null;
  active: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastResult: string | null;
}

export type ScheduleInput = Omit<
  ScheduleDto,
  | 'id'
  | 'label'
  | 'ownerId'
  | 'nextRunAt'
  | 'lastRunAt'
  | 'lastResult'
  | 'weekday'
  | 'monthDay'
  | 'subject'
> & { weekday?: number; monthDay?: number; subject?: string };

const enc = encodeURIComponent;

export function useReports() {
  const { status, isPlatform } = useAuth();
  return useQuery({
    queryKey: ['reports'],
    queryFn: () => api<ReportEntry[]>('/reports'),
    enabled: status === 'authenticated' && !isPlatform,
    staleTime: 30_000,
  });
}

export function useReport(ref: string | undefined) {
  return useQuery({
    queryKey: ['reports', ref],
    enabled: !!ref,
    queryFn: () => api<ReportEntry>(`/reports/${enc(ref!)}`),
  });
}

export function runReport(ref: string, params: ReportRunParams) {
  return api<ReportResult>(`/reports/${enc(ref)}/run`, { method: 'POST', body: { params } });
}

export function previewReport(report: Partial<ReportDef>, params: ReportRunParams = {}) {
  return api<ReportResult>('/reports/preview', { method: 'POST', body: { report, params } });
}

export function useReportActions() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['reports'] });
  return {
    save: useMutation({
      mutationFn: (v: { id?: string; def: Partial<ReportDef> }) =>
        api<ReportEntry>(v.id ? `/reports/my/${v.id}` : '/reports/my', {
          method: v.id ? 'PUT' : 'POST',
          body: v.def,
        }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(`/reports/my/${id}`, { method: 'DELETE' }),
      onSuccess: refresh,
    }),
    share: useMutation({
      mutationFn: (v: { id: string; roleIds: string[] }) =>
        api<ReportEntry>(`/reports/my/${v.id}/share`, {
          method: 'PUT',
          body: { roleIds: v.roleIds },
        }),
      onSuccess: refresh,
    }),
    exportReport: useMutation({
      mutationFn: (v: { ref: string; format: ExportJob['format']; params: ReportRunParams }) =>
        api<ExportJob>(`/reports/${enc(v.ref)}/export`, {
          method: 'POST',
          body: { format: v.format, params: v.params },
        }),
      onSuccess: () => qc.invalidateQueries({ queryKey: ['exports'] }),
    }),
  };
}

export function useExports() {
  return useQuery({
    queryKey: ['exports'],
    queryFn: () => api<ExportJob[]>('/reports/exports'),
    // Keep checking while something is still being made.
    refetchInterval: (q) =>
      (q.state.data ?? []).some((j) => j.status === 'queued' || j.status === 'running')
        ? 3000
        : false,
  });
}

export function useSchedules() {
  return useQuery({
    queryKey: ['schedules'],
    queryFn: () => api<ScheduleDto[]>('/reports/schedules'),
  });
}

export function useScheduleActions() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['schedules'] });
  return {
    save: useMutation({
      mutationFn: (v: { id?: string; body: ScheduleInput }) =>
        api<ScheduleDto>(v.id ? `/reports/schedules/${v.id}` : '/reports/schedules', {
          method: v.id ? 'PUT' : 'POST',
          body: v.body,
        }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(`/reports/schedules/${id}`, { method: 'DELETE' }),
      onSuccess: refresh,
    }),
  };
}

export function useDashboards() {
  const { status, isPlatform } = useAuth();
  return useQuery({
    queryKey: ['dashboards'],
    queryFn: () => api<DashboardEntry[]>('/dashboards'),
    enabled: status === 'authenticated' && !isPlatform,
    staleTime: 30_000,
  });
}

export interface DashboardFilters {
  dateRange?: { from: string; to: string };
  orgUnitId?: string;
}

export function useDashboardData(ref: string | undefined, filters: DashboardFilters) {
  return useQuery({
    queryKey: ['dashboards', ref, 'data', filters],
    enabled: !!ref,
    queryFn: () =>
      api<{ data: Record<string, WidgetData>; loadedAt: string }>(`/dashboards/${enc(ref!)}/data`, {
        method: 'POST',
        body: filters,
      }),
    staleTime: 60_000,
  });
}

export function refreshDashboard(ref: string, filters: DashboardFilters) {
  return api<{ data: Record<string, WidgetData>; loadedAt: string }>(
    `/dashboards/${enc(ref)}/data`,
    {
      method: 'POST',
      body: { ...filters, refresh: true },
    },
  );
}

export function useDashboardActions() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['dashboards'] });
  return {
    save: useMutation({
      mutationFn: (v: { id?: string; def: Partial<DashboardDef> }) =>
        api<DashboardEntry>(v.id ? `/dashboards/my/${v.id}` : '/dashboards/my', {
          method: v.id ? 'PUT' : 'POST',
          body: v.def,
        }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(`/dashboards/my/${id}`, { method: 'DELETE' }),
      onSuccess: refresh,
    }),
    share: useMutation({
      mutationFn: (v: { id: string; roleIds: string[] }) =>
        api<DashboardEntry>(`/dashboards/my/${v.id}/share`, {
          method: 'PUT',
          body: { roleIds: v.roleIds },
        }),
      onSuccess: refresh,
    }),
  };
}

/** `my:<id>` → `<id>`. */
export const personalId = (ref: string) => (ref.startsWith('my:') ? ref.slice(3) : undefined);
