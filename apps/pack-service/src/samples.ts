import { AppError } from '@erp/service-kit';

/**
 * Replaces sample references at any depth (table rows included): `@unit` becomes the
 * company's top unit, `@<ref>` the id of an earlier sample.
 */
export function resolveSampleRefs(
  value: unknown,
  ids: ReadonlyMap<string, string>,
  unitId: string,
): unknown {
  const resolve = (v: unknown): unknown => {
    if (typeof v === 'string' && v.startsWith('@')) {
      if (v === '@unit') return unitId;
      const found = ids.get(v.slice(1));
      if (!found) throw AppError.badRequest(`Sample reference ${v} is not defined earlier`);
      return found;
    }
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
    return v;
  };
  return resolve(value);
}
