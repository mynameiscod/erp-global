import type { PermissionKey } from './permissions';

/** The tenant id used for platform (Super Admin) users and platform-level records. */
export const PLATFORM_TENANT_ID = 'platform';

/**
 * One role assignment, flattened into the token.
 * `path` is the materialized path of the org unit, e.g. `/a1/b2/`. It covers
 * every unit whose path starts with it.
 */
export interface AclEntry {
  ou: string;
  path: string;
  p: PermissionKey[];
}

export interface AccessTokenClaims {
  /** user id */
  sub: string;
  /** tenant id */
  tid: string;
  /** session id */
  sid: string;
  acl: AclEntry[];
  /** platform permissions, only for platform users */
  plat?: PermissionKey[];
}

export interface ServiceTokenClaims {
  /** calling service, e.g. `svc:tenant-service` */
  sub: string;
  /** tenant the call acts for, if any */
  tid?: string;
}

/** Does the principal hold `perm`, optionally at (or above) `targetPath`? */
export function hasPermission(
  claims: Pick<AccessTokenClaims, 'acl' | 'plat'>,
  perm: PermissionKey,
  targetPath?: string,
): boolean {
  if (claims.plat?.includes(perm)) return true;
  return claims.acl.some(
    (e) => e.p.includes(perm) && (targetPath === undefined || targetPath.startsWith(e.path)),
  );
}

/** Org paths at which `perm` is granted. A target is in scope if its path starts with one of them. */
export function scopePathsFor(
  claims: Pick<AccessTokenClaims, 'acl'>,
  perm: PermissionKey,
): string[] {
  return claims.acl.filter((e) => e.p.includes(perm)).map((e) => e.path);
}

export function isPathInScope(targetPath: string, scopePaths: string[]): boolean {
  return scopePaths.some((p) => targetPath.startsWith(p));
}
