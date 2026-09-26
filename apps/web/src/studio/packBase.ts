import { useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  mergeLayers,
  packLayers,
  platformBaseLayer,
  type ConfigLayer,
  type IdentifierType,
  type TaxSetup,
  type WorkCalendar,
} from '@erp/metadata';
import { api } from '../api/client';
import type { DraftResponse } from '../config/hooks';
import { useStudio } from './StudioContext';

/**
 * What the layer being edited builds on, in the draft: the installed packs (merged, with
 * their role patches applied) and, for a branch override, the company layer too.
 */
export function useInherited(): { packs: ConfigLayer; below: ConfigLayer } {
  const { draft, company, scope } = useStudio();
  return useMemo(() => {
    const packs = packLayers(draft.config.packs, company);
    return {
      packs: mergeLayers(packs),
      below: mergeLayers([
        platformBaseLayer(),
        ...packs,
        ...(scope === 'company' ? [] : [company]),
      ]),
    };
  }, [draft.config.packs, company, scope]);
}

/** Draft writes the shared config hooks do not cover (Step 6 parts). */
export function useStep6Actions() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['config'] });
  const putTaxes = useMutation({
    // An empty object clears the company's tax data (the packs' stays).
    mutationFn: (taxes: TaxSetup | Record<string, never>) =>
      api<DraftResponse>('/config/draft/taxes', { method: 'PUT', body: taxes }),
    onSuccess: refresh,
  });
  const putCalendar = useMutation({
    mutationFn: (calendar: WorkCalendar) =>
      api<DraftResponse>('/config/draft/calendar', { method: 'PUT', body: calendar }),
    onSuccess: refresh,
  });
  const putIdentifier = useMutation({
    mutationFn: (v: IdentifierType) =>
      api<DraftResponse>(`/config/draft/identifier-types/${encodeURIComponent(v.key)}`, {
        method: 'PUT',
        body: v,
      }),
    onSuccess: refresh,
  });
  const deleteIdentifier = useMutation({
    mutationFn: (key: string) =>
      api<DraftResponse>(`/config/draft/identifier-types/${encodeURIComponent(key)}`, {
        method: 'DELETE',
      }),
    onSuccess: refresh,
  });
  return { putTaxes, putCalendar, putIdentifier, deleteIdentifier };
}

/** A small "from a pack" badge class set, shared by the Step 6 screens. */
export const PACK_BADGE = { bg: 'info-subtle', text: 'info-emphasis' } as const;
