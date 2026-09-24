import { findEntity, validateRecord, type RecordData } from '@erp/metadata';
import type { ConfigClient } from './config-client';
import { AppError } from './errors';

/**
 * Validates custom field values for a built-in entity (user, org_unit) against
 * the published configuration that applies at `orgPath`. Returns the full,
 * normalized set of values, or throws a 400 with one message per field.
 */
export async function validateCustomFields(
  config: ConfigClient,
  entityKey: 'user' | 'org_unit',
  input: Record<string, unknown> | undefined,
  existing: RecordData | undefined,
  orgPath?: string,
): Promise<RecordData> {
  const cfg = await config.effective(orgPath);
  const entity = findEntity(cfg, entityKey);
  if (!entity) return existing ?? {};
  const { data, issues } = validateRecord(
    entity,
    input ?? {},
    { cfg, companyCurrency: cfg.tenant.currency },
    existing,
  );
  if (issues.length) {
    throw AppError.badRequest(
      'Please correct the highlighted fields',
      issues.map((i) => ({ path: `custom.${i.field}`, message: i.message })),
    );
  }
  return data;
}
