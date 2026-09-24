import { createContext, useContext } from 'react';
import { emptyLayer, type ConfigLayer } from '@erp/metadata';
import type { DraftResponse } from '../config/hooks';

export interface StudioState {
  /** `company` or an org unit id (a branch override). */
  scope: string;
  draft: DraftResponse;
  /** The draft layer being edited: the company layer or the override for `scope`. */
  layer: ConfigLayer;
  /** Company layer, for reading what an override builds on. */
  company: ConfigLayer;
}

export const StudioContext = createContext<StudioState | null>(null);

export function useStudio(): StudioState {
  const ctx = useContext(StudioContext);
  if (!ctx) throw new Error('useStudio outside the studio');
  return ctx;
}

export function layerFor(draft: DraftResponse, scope: string): ConfigLayer {
  return scope === 'company'
    ? draft.config.company
    : (draft.config.orgUnits[scope] ?? emptyLayer());
}
