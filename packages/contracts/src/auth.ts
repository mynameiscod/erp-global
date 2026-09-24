import { permissionMatches, type Permission, type PermissionKey } from './permissions';

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
  p: Permission[];
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
  perm: Permission,
  targetPath?: string,
): boolean {
  if (claims.plat?.includes(perm as PermissionKey)) return true;
  return claims.acl.some(
    (e) => grants(e.p, perm) && (targetPath === undefined || targetPath.startsWith(e.path)),
  );
}

function grants(granted: Permission[], perm: Permission): boolean {
  return granted.some((g) => permissionMatches(g, perm));
}

/** Org paths at which `perm` is granted. A target is in scope if its path starts with one of them. */
export function scopePathsFor(claims: Pick<AccessTokenClaims, 'acl'>, perm: Permission): string[] {
  return claims.acl.filter((e) => grants(e.p, perm)).map((e) => e.path);
}

export function isPathInScope(targetPath: string, scopePaths: string[]): boolean {
  return scopePaths.some((p) => targetPath.startsWith(p));
}
