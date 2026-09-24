export type ActorType = 'user' | 'service' | 'system';

export interface EventActor {
  type: ActorType;
  id: string;
}

/** Every event on the bus uses this envelope. */
export interface EventEnvelope<T = unknown> {
  eventId: string;
  type: string;
  version: number;
  tenantId: string;
  actor: EventActor;
  occurredAt: string;
  correlationId?: string;
  /** Emitting service, e.g. `org-service`. */
  source: string;
  payload: T;
}

export const EventTypes = {
  TenantCreated: 'tenant.created',
  TenantActivated: 'tenant.activated',
  TenantSignupFailed: 'tenant.signup.failed',
  TenantSettingsUpdated: 'tenant.settings.updated',
  TenantStatusChanged: 'tenant.status.changed',

  OrgUnitCreated: 'org.unit.created',
  OrgUnitUpdated: 'org.unit.updated',
  OrgUnitMoved: 'org.unit.moved',
  OrgUnitDeactivated: 'org.unit.deactivated',

  RoleCreated: 'access.role.created',
  RoleUpdated: 'access.role.updated',
  RoleDeleted: 'access.role.deleted',
  AssignmentCreated: 'access.assignment.created',
  AssignmentRemoved: 'access.assignment.removed',

  UserCreated: 'identity.user.created',
  UserInvited: 'identity.user.invited',
  UserActivated: 'identity.user.activated',
  UserDeactivated: 'identity.user.deactivated',
  UserReactivated: 'identity.user.reactivated',
  LoginSucceeded: 'identity.login.succeeded',
  LoginFailed: 'identity.login.failed',
  MfaEnabled: 'identity.mfa.enabled',
  MfaDisabled: 'identity.mfa.disabled',
  PasswordChanged: 'identity.password.changed',
  PasswordResetRequested: 'identity.password.reset_requested',
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];

/** Business and security events: stream `ERP_EVENTS`, subjects `erp.>`, recorded by audit-service. */
export const EVENTS_STREAM = 'ERP_EVENTS';
export const EVENTS_SUBJECT_PREFIX = 'erp.';

/**
 * Notification requests: stream `ERP_NOTIFY`, subjects `notify.>`, short retention.
 * Kept apart from `erp.>` because payloads can hold one-time links that must not reach the audit log.
 */
export const NOTIFY_STREAM = 'ERP_NOTIFY';
export const NOTIFY_SUBJECT_PREFIX = 'notify.';
export const NotifyTypes = {
  EmailRequested: 'notify.email.requested',
} as const;

export function subjectFor(type: string): string {
  return type.startsWith(NOTIFY_SUBJECT_PREFIX) ? type : `${EVENTS_SUBJECT_PREFIX}${type}`;
}

export type EmailTemplate = 'user.invite' | 'password.reset';

export interface EmailRequestedPayload {
  to: string;
  template: EmailTemplate;
  locale: string;
  vars: Record<string, string>;
}

export interface OrgUnitMovedPayload {
  unitId: string;
  oldPath: string;
  newPath: string;
}
