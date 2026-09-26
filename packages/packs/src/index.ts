import type { PackManifest } from '@erp/metadata';
import { INDIA } from './country-in';
import { EDUCATION } from './industry-education';
import { HEALTHCARE } from './industry-healthcare';
import { RETAIL } from './industry-retail';
import { SERVICES } from './industry-services';

export { ROLES } from './conventions';
export { IN_STATES } from './country-in';

/**
 * The packs shipped with this release. Installing one copies the manifest into the
 * company's configuration, so a later release changes nothing until the admin upgrades.
 */
export const CATALOG: PackManifest[] = [INDIA, EDUCATION, RETAIL, SERVICES, HEALTHCARE];

export function findPack(id: string): PackManifest | undefined {
  return CATALOG.find((p) => p.id === id);
}
