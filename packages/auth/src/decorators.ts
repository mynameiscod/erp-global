import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@erp/contracts';

export const IS_PUBLIC = 'erp:isPublic';
export const IS_INTERNAL = 'erp:isInternal';
export const REQUIRED_PERMISSIONS = 'erp:requiredPermissions';

/** No authentication. Use for sign-up, login, reference data and health. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Service-to-service only: needs a valid service token and is never routed by the gateway. */
export const Internal = () => SetMetadata(IS_INTERNAL, true);

/**
 * Caller must hold every listed permission somewhere in their scope.
 * Checks against a specific org unit are done in the service with `hasPermission(..., path)`.
 */
export const RequirePermissions = (...perms: PermissionKey[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, perms);
