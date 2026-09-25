import type { LocalizedText } from './types';

/**
 * Workflows, business rules, automations and message templates. They live in the
 * same configuration layers as entities, so they are drafted, published, versioned
 * and overridden per org unit exactly like the rest of the config.
 */

export interface WorkflowState {
  key: string;
  label: LocalizedText;
  /** Badge colour, e.g. #198754. */
  color?: string;
  /** Records in this state cannot be edited or deleted, except `editableFields`. */
  locked?: boolean;
  editableFields?: string[];
}

/** Who approves. Roles are found at the record's org unit or the nearest unit above it. */
export type ApproverSpec =
  | { type: 'role'; roleId: string }
  /** The requester's manager ("Reports to"). */
  | { type: 'manager' }
  /** The head of the record's org unit, or of the nearest unit above that has one. */
  | { type: 'unit_head' }
  | { type: 'users'; userIds: string[] }
  /** A user lookup field on the record. */
  | { type: 'field'; field: string };

export interface ApprovalLevel {
  key: string;
  label: LocalizedText;
  /** The level applies only when this is true, e.g. `amount > 50000`. */
  condition?: string;
  approvers: ApproverSpec[];
  /** `all`: everyone must approve. `any`: the first approval completes the level. */
  mode: 'all' | 'any';
  remindAfterHours?: number;
  escalateAfterHours?: number;
  /** Who gets the task on escalation. Empty: the level is skipped and the next one starts. */
  escalateTo?: ApproverSpec[];
}

export interface ApprovalDef {
  levels: ApprovalLevel[];
  approvedState: string;
  /** Where a rejection goes: a final Rejected state, or back to Draft to "send back". */
  rejectedState: string;
}

export interface WorkflowAction {
  key: string;
  label: LocalizedText;
  /** States the action is available in. */
  from: string[];
  /** Target state; for an approval action, the "pending" state while approvals run. */
  to: string;
  /** Only holders of these roles (ids); empty means anyone who may edit the record. */
  roleIds?: string[];
  /** Only the person who created the record, e.g. Submit or Cancel. */
  requesterOnly?: boolean;
  condition?: string;
  commentRequired?: boolean;
  approval?: ApprovalDef;
}

export interface WorkflowDef {
  /** One workflow per entity; the entity key identifies it. */
  entity: string;
  initialState: string;
  states: WorkflowState[];
  actions: WorkflowAction[];
  active?: boolean;
}

export const RULE_EFFECTS = ['block', 'set', 'require', 'hide', 'readonly'] as const;
export type RuleEffect = (typeof RULE_EFFECTS)[number];

export interface RuleDef {
  key: string;
  entity: string;
  label?: LocalizedText;
  on: 'create' | 'update' | 'save';
  /** Empty: always. */
  condition?: string;
  effect: RuleEffect;
  /** The field to set / require / hide / make read-only. */
  field?: string;
  /** For `set`: a formula giving the new value. */
  value?: string;
  /** For `block`: the message shown to the user. */
  message?: LocalizedText;
  active?: boolean;
}

export type AutomationTrigger =
  | { type: 'created' }
  | { type: 'updated' }
  | { type: 'deleted' }
  | { type: 'field_changed'; field: string }
  | { type: 'status_changed'; to?: string }
  /** Checks every record of the entity on a schedule, in the company's time zone. */
  | { type: 'schedule'; every: 'day' | 'hour' | '15min'; at?: string };

export type Recipient =
  | { type: 'creator' }
  | { type: 'manager' }
  | { type: 'field'; field: string }
  | { type: 'role'; roleId: string }
  | { type: 'users'; userIds: string[] };

export const CHANNELS = ['inapp', 'email', 'whatsapp', 'push'] as const;
export type Channel = (typeof CHANNELS)[number];

export interface FieldAssignment {
  field: string;
  /** A formula; plain text needs quotes, e.g. `"Approved"`. */
  value: string;
}

export type AutomationAction =
  | { type: 'notify'; template: string; recipients: Recipient[]; channels: Channel[] }
  | { type: 'update'; set: FieldAssignment[] }
  | { type: 'create'; entity: string; orgUnit?: 'same' | 'none'; set: FieldAssignment[] }
  | { type: 'webhook'; url: string }
  /** Runs a workflow action (e.g. submit) as the system. */
  | { type: 'workflow_action'; action: string };

export interface AutomationDef {
  key: string;
  entity: string;
  label: LocalizedText;
  trigger: AutomationTrigger;
  condition?: string;
  actions: AutomationAction[];
  active?: boolean;
}

/**
 * Text of a notification in each language. Placeholders: `{{record.<field>}}`,
 * `{{record.number}}`, `{{record.title}}`, `{{entity}}`, `{{actor.name}}`, `{{link}}`,
 * and for approvals `{{state}}` and `{{comment}}`.
 */
export interface MessageTemplate {
  key: string;
  label: LocalizedText;
  title: LocalizedText;
  body: LocalizedText;
  /** A Meta-approved WhatsApp template and the placeholders for its parameters, in order. */
  whatsapp?: { template: string; params: string[] };
}
