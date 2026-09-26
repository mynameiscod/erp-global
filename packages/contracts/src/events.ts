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
  TenantLoginPolicyUpdated: 'tenant.login_policy.updated',

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
  UserUpdated: 'identity.user.updated',
  UserAutoJoined: 'identity.user.auto_joined',
  OtpRequested: 'identity.otp.requested',
  OtpFailed: 'identity.otp.failed',
  PhoneVerified: 'identity.phone.verified',
  PhoneRemoved: 'identity.phone.removed',
  SsoLinked: 'identity.sso.linked',
  SsoUnlinked: 'identity.sso.unlinked',
  SsoRefused: 'identity.sso.refused',

  ConfigPublished: 'config.published',
  ConfigRolledBack: 'config.rolled_back',

  RecordCreated: 'records.record.created',
  RecordUpdated: 'records.record.updated',
  RecordDeleted: 'records.record.deleted',
  RecordStatusChanged: 'records.record.status_changed',

  WorkflowActionTaken: 'workflow.action.taken',
  ApprovalTaskCreated: 'workflow.task.created',
  ApprovalTaskDecided: 'workflow.task.decided',
  ApprovalTaskReminded: 'workflow.task.reminded',
  ApprovalTaskEscalated: 'workflow.task.escalated',
  AutomationFailed: 'workflow.automation.failed',
  WebhookCalled: 'workflow.webhook.called',

  DelegationSet: 'identity.delegation.set',
  DelegationCleared: 'identity.delegation.cleared',

  FileUploaded: 'files.file.uploaded',

  DocumentPrinted: 'documents.document.printed',
  DocumentEmailed: 'documents.document.emailed',
  DocumentAttached: 'documents.document.attached',

  ReportExported: 'reports.report.exported',
  ReportScheduleSent: 'reports.schedule.sent',
  ReportShared: 'reports.report.shared',
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
  WhatsappRequested: 'notify.whatsapp.requested',
  /** A notification for users of the company, delivered on the channels they allow. */
  UserNotify: 'notify.user.requested',
  /** An email with attachments to any address (documents, scheduled reports). */
  MailSend: 'notify.mail.send',
} as const;

export function subjectFor(type: string): string {
  return type.startsWith(NOTIFY_SUBJECT_PREFIX) ? type : `${EVENTS_SUBJECT_PREFIX}${type}`;
}

export type EmailTemplate = 'user.invite' | 'password.reset' | 'otp.code';

export interface EmailRequestedPayload {
  to: string;
  template: EmailTemplate;
  locale: string;
  vars: Record<string, string>;
}

/** A one-time code sent on WhatsApp with the approved authentication template. */
export interface WhatsappRequestedPayload {
  /** E.164, e.g. +919876543210 */
  to: string;
  template: 'otp';
  locale: string;
  code: string;
}

export type NotifyChannel = 'inapp' | 'email' | 'whatsapp' | 'push';

export interface UserNotifyPayload {
  userIds: string[];
  /** Message template key: a built-in (`approval.requested`…) or one from the company config. */
  template: string;
  channels: NotifyChannel[];
  /** Values for `{{…}}` placeholders. */
  vars: Record<string, unknown>;
  /** Path in the web app the notification opens, e.g. `/r/purchase/<id>`. */
  link?: string;
  /** Where the template is looked up (org unit overrides). */
  orgPath?: string;
  /** Approval requests always stay in the in-app inbox, whatever the user's preferences. */
  essential?: boolean;
}

/** A composed email; attachments are files in file-service, fetched when the mail is sent. */
export interface MailSendPayload {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  attachments: { fileId: string; name: string }[];
}

/** Record events carry this so automations triggered by automations can be cut off. */
export interface RecordEventPayload {
  entity: string;
  recordId: string;
  number: string | null;
  orgUnitId: string | null;
  orgPath?: string;
  changes?: Record<string, { from?: unknown; to?: unknown }>;
  /** 0 for user changes; +1 for each automation in the chain that caused this one. */
  depth?: number;
}

export interface RecordStatusChangedPayload extends RecordEventPayload {
  from: string | null;
  to: string;
  action: string | null;
}

export interface OrgUnitMovedPayload {
  unitId: string;
  oldPath: string;
  newPath: string;
}

export interface ConfigPublishedPayload {
  version: number;
  note: string | null;
  rolledBackFrom: number | null;
  changes: number;
  summary: string[];
}
