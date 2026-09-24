import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  pickText,
  type ConfigSettings,
  type EffectiveConfig,
  type EntityDef,
  type LocalizedText,
  type TenantConfig,
} from '@erp/metadata';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';

export type EffectiveConfigResponse = EffectiveConfig & {
  tenant: { countryCode: string; currency: string; locale: string; defaultLanguage: string };
};

export interface DraftResponse {
  config: TenantConfig;
  baseVersion: number;
  publishedVersion: number;
  changes: string[];
  updatedAt: string;
  updatedBy: string | null;
}

export interface VersionSummary {
  version: number;
  note: string | null;
  summary: string[];
  rolledBackFrom: number | null;
  publishedBy: string | null;
  publishedAt: string;
}

export interface ConfigIssue {
  scope: string;
  path: string;
  message: string;
}

/** Draft item kinds as the API names them. */
export type ConfigKind = 'entities' | 'picklists' | 'forms' | 'list-views' | 'numbering';

/** Published configuration for the current user, optionally at an org unit or as a draft preview. */
export function useEffectiveConfig(
  orgUnitId?: string,
  source: 'published' | 'draft' = 'published',
) {
  const { status, isPlatform } = useAuth();
  return useQuery({
    queryKey: ['config', 'effective', source, orgUnitId ?? 'company'],
    queryFn: () =>
      api<EffectiveConfigResponse>('/config/effective', {
        query: { orgUnitId, source: source === 'draft' ? 'draft' : undefined },
      }),
    enabled: status === 'authenticated' && !isPlatform,
    staleTime: 10_000,
  });
}

/** Text in the user's language, falling back sensibly. */
export function useLabel() {
  const { i18n } = useTranslation();
  return useCallback(
    (text: LocalizedText | undefined) => pickText(text, i18n.language),
    [i18n.language],
  );
}

export function customEntities(cfg: EffectiveConfig | undefined): EntityDef[] {
  return (cfg?.entities ?? []).filter((e) => e.kind === 'custom' && !e.archived);
}

export function useDraft() {
  const { can } = useAuth();
  return useQuery({
    queryKey: ['config', 'draft'],
    queryFn: () => api<DraftResponse>('/config/draft'),
    enabled: can('config.read'),
  });
}

export function useVersions() {
  return useQuery({
    queryKey: ['config', 'versions'],
    queryFn: () => api<VersionSummary[]>('/config/versions'),
  });
}

/** Studio write operations. Every change refreshes the draft and previews. */
export function useConfigActions() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['config'] });
  const scoped = (scope?: string) => (scope && scope !== 'company' ? { scope } : undefined);

  const putItem = useMutation({
    mutationFn: (v: { kind: ConfigKind; key: string; body: unknown; scope?: string }) =>
      api<DraftResponse>(`/config/draft/${v.kind}/${encodeURIComponent(v.key)}`, {
        method: 'PUT',
        body: v.body,
        query: scoped(v.scope),
      }),
    onSuccess: refresh,
  });
  const deleteItem = useMutation({
    mutationFn: (v: { kind: ConfigKind; key: string; scope?: string }) =>
      api<DraftResponse>(`/config/draft/${v.kind}/${encodeURIComponent(v.key)}`, {
        method: 'DELETE',
        query: scoped(v.scope),
      }),
    onSuccess: refresh,
  });
  const putSettings = useMutation({
    mutationFn: (settings: ConfigSettings) =>
      api<DraftResponse>('/config/draft/settings', { method: 'PUT', body: settings }),
    onSuccess: refresh,
  });
  const removeOverride = useMutation({
    mutationFn: (orgUnitId: string) =>
      api<DraftResponse>(`/config/draft/overrides/${orgUnitId}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const publish = useMutation({
    mutationFn: (note?: string) =>
      api<{ version: number; summary: string[] }>('/config/publish', {
        method: 'POST',
        body: { note },
      }),
    onSuccess: refresh,
  });
  const discard = useMutation({
    mutationFn: () => api<DraftResponse>('/config/draft/discard', { method: 'POST' }),
    onSuccess: refresh,
  });
  const rollback = useMutation({
    mutationFn: (version: number) =>
      api<{ version: number }>(`/config/versions/${version}/rollback`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: refresh,
  });
  return { putItem, deleteItem, putSettings, removeOverride, publish, discard, rollback };
}
