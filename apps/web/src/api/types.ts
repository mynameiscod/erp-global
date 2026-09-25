import type { AclEntry, PermissionKey } from '@erp/contracts';

export interface UserDto {
  id: string;
  email: string;
  name: string;
  status: 'invited' | 'active' | 'deactivated';
  language: string;
  timezone: string;
  mfaEnabled: boolean;
  mfaMethod?: MfaMethod | null;
  phone?: string | null;
  hasPassword?: boolean;
  managerId?: string | null;
  custom?: Record<string, unknown>;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface SessionResponse {
  accessToken: string;
  expiresIn: number;
  user: UserDto & { tenantId: string };
  mfaSetupRequired: boolean;
}

export type MfaMethod = 'totp' | 'whatsapp' | 'email';
export type OtpChannel = 'whatsapp' | 'email';

export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
  mfaMethod?: MfaMethod;
  channel?: OtpChannel;
  sentTo?: string;
  codeSent?: boolean;
  resendAfter?: number;
}

export interface OtpSent {
  otpToken?: string;
  channel?: OtpChannel;
  sentTo?: string;
  expiresIn?: number;
  resendAfter?: number;
}

export interface LoginMethods {
  password: boolean;
  otp: boolean;
  google: boolean;
  microsoft: boolean;
}

export interface CompanyLookup {
  slug: string;
  name: string;
  defaultLanguage: string;
  status: string;
  loginMethods?: LoginMethods;
}

export interface LinkedAccountDto {
  id: string;
  provider: 'google' | 'microsoft';
  email: string | null;
  createdAt: string;
  lastUsedAt: string | null;
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
  custom?: Record<string, unknown>;
  headUserId?: string | null;
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

export interface WorkflowHistoryEntry {
  at: string;
  by: string;
  byName: string;
  onBehalfOf?: string;
  onBehalfOfName: string | null;
  action: string;
  from: string | null;
  to: string | null;
  comment?: string;
  level?: string;
}

export type WorkflowView =
  | { workflow: false }
  | {
      workflow: true;
      state: string;
      stateLabel: Record<string, string>;
      color: string | null;
      locked: boolean;
      states: { key: string; label: Record<string, string>; color: string | null }[];
      actions: { key: string; label: Record<string, string>; commentRequired: boolean }[];
      myTaskIds: string[];
      pending: {
        id: string;
        level: string;
        levelLabel: Record<string, string>;
        assigneeId: string;
        assigneeName: string;
      }[];
      history: WorkflowHistoryEntry[];
    };

export interface ApprovalTaskDto {
  id: string;
  entity: string;
  recordId: string;
  recordTitle: string;
  level: string;
  levelLabel: Record<string, string>;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'escalated';
  requesterName: string;
  onBehalfOf: string | null;
  remindAt: string | null;
  escalateAt: string | null;
  decidedAt: string | null;
  comment: string | null;
  createdAt: string;
}

export interface NotificationDto {
  id: string;
  template: string;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
