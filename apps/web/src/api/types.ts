import type { AclEntry, PermissionKey } from '@erp/contracts';

export interface UserDto {
  id: string;
  email: string;
  name: string;
  status: 'invited' | 'active' | 'deactivated';
  language: string;
  timezone: string;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface SessionResponse {
  accessToken: string;
  expiresIn: number;
  user: UserDto & { tenantId: string };
  mfaSetupRequired: boolean;
}

export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
}

export interface TenantDto {
  id: string;
  slug: string | null;
  name: string;
  countryCode: string;
  industryCode: string;
  defaultLanguage: string;
  timezone: string;
  currency: string;
  locale: string;
  status: 'provisioning' | 'active' | 'suspended' | 'failed';
  placement: 'shared' | 'dedicated';
  settings: { requireMfa: boolean };
  createdAt: string;
}

export interface OrgUnitDto {
  id: string;
  name: string;
  code: string | null;
  type: string;
  parentId: string | null;
  path: string;
  depth: number;
  status: 'active' | 'inactive';
}

export interface RoleDto {
  id: string;
  name: string;
  description: string | null;
  permissions: PermissionKey[];
  system: boolean;
  key: string | null;
  assignmentCount?: number;
}

export interface AssignmentDto {
  id: string;
  userId: string;
  roleId: string;
  roleName: string | null;
  orgUnitId: string;
  orgUnitPath: string;
  createdAt: string;
}

export interface PermissionDefDto {
  key: PermissionKey;
  module: string;
  scope: 'tenant' | 'platform';
  description: string;
}

export interface AuditRecordDto {
  seq: number;
  eventId: string;
  type: string;
  source: string;
  actor: { type: string; id: string };
  occurredAt: string;
  recordedAt: string;
  correlationId: string | null;
  payload: unknown;
  hash: string;
}

export interface VerifyResult {
  valid: boolean;
  records: number;
  headSeq: number;
  brokenAt?: { seq: number; reason: string };
}

export interface MeDto extends UserDto {
  tenantId: string;
  acl: AclEntry[];
  platformPermissions: PermissionKey[];
}
