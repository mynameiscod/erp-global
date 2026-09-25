import { Schema, type Types } from 'mongoose';
import { tenantPlugin, type ModelDef } from '@erp/tenancy';

/** An in-app notification: the bell and the Notifications page. */
export interface InboxItem {
  _id: Types.ObjectId;
  tenantId: string;
  userId: string;
  /** `<event id>:<user>`; a redelivered request does not add a second copy. */
  dedupeKey: string;
  template: string;
  title: string;
  body: string;
  link?: string;
  readAt?: Date | null;
  createdAt: Date;
}

const inboxSchema = new Schema<InboxItem>(
  {
    userId: { type: String, required: true },
    dedupeKey: { type: String, required: true },
    template: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    link: String,
    readAt: { type: Date, default: null },
  },
  { collection: 'inbox', timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
inboxSchema.plugin(tenantPlugin);
inboxSchema.index({ tenantId: 1, userId: 1, createdAt: -1 });
inboxSchema.index({ tenantId: 1, userId: 1, readAt: 1 });
inboxSchema.index({ tenantId: 1, dedupeKey: 1 }, { unique: true });
// Keep a year of notifications.
inboxSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 86_400 });

export const InboxModel: ModelDef<InboxItem> = { name: 'InboxItem', schema: inboxSchema };

export interface Preference {
  tenantId: string;
  userId: string;
  /** `kind:channel` pairs turned off, e.g. `approval.requested:email`. */
  disabled: string[];
  digest: boolean;
}

const prefSchema = new Schema<Preference>(
  {
    userId: { type: String, required: true },
    disabled: { type: [String], default: [] },
    digest: { type: Boolean, default: false },
  },
  { collection: 'preferences', versionKey: false },
);
prefSchema.plugin(tenantPlugin);
prefSchema.index({ tenantId: 1, userId: 1 }, { unique: true });

export const PreferenceModel: ModelDef<Preference> = { name: 'Preference', schema: prefSchema };

export interface PushSubscriptionDoc {
  _id: Types.ObjectId;
  tenantId: string;
  userId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
  createdAt: Date;
}

const pushSchema = new Schema<PushSubscriptionDoc>(
  {
    userId: { type: String, required: true },
    endpoint: { type: String, required: true },
    keys: { p256dh: { type: String, required: true }, auth: { type: String, required: true } },
    userAgent: String,
  },
  {
    collection: 'push_subscriptions',
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  },
);
pushSchema.plugin(tenantPlugin);
pushSchema.index({ tenantId: 1, endpoint: 1 }, { unique: true });
pushSchema.index({ tenantId: 1, userId: 1 });

export const PushModel: ModelDef<PushSubscriptionDoc> = {
  name: 'PushSubscription',
  schema: pushSchema,
};

/** One external delivery (email, WhatsApp, push) of one request to one user. */
export interface SentMark {
  tenantId: string;
  key: string;
  createdAt: Date;
}

const sentSchema = new Schema<SentMark>(
  { key: { type: String, required: true }, createdAt: { type: Date, default: () => new Date() } },
  { collection: 'sent_marks', versionKey: false },
);
sentSchema.plugin(tenantPlugin);
sentSchema.index({ tenantId: 1, key: 1 }, { unique: true });
sentSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 86_400 });

export const SentModel: ModelDef<SentMark> = { name: 'SentMark', schema: sentSchema };
