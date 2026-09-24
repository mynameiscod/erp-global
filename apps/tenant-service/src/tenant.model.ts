import { Schema, type Connection, type Model, type Types } from 'mongoose';

export type TenantStatus = 'provisioning' | 'active' | 'suspended' | 'failed';
export type TenantPlacement = 'shared' | 'dedicated';

export interface Tenant {
  _id: Types.ObjectId;
  /** Unique company URL name. Released (unset) when sign-up fails. */
  slug?: string;
  requestedSlug: string;
  name: string;
  countryCode: string;
  industryCode: string;
  defaultLanguage: string;
  timezone: string;
  currency: string;
  locale: string;
  status: TenantStatus;
  placement: TenantPlacement;
  settings: { requireMfa: boolean };
  rootOrgUnitId?: string;
  adminUserId?: string;
  provisioning: { completed: string[]; error?: string };
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Tenants are platform-level records, so this schema is not tenant-plugged.
 * Code that serves a tenant user always filters by the tenant id from the
 * verified token.
 */
const tenantSchema = new Schema<Tenant>(
  {
    slug: { type: String },
    requestedSlug: { type: String, required: true },
    name: { type: String, required: true },
    countryCode: { type: String, required: true },
    industryCode: { type: String, required: true },
    defaultLanguage: { type: String, required: true },
    timezone: { type: String, required: true },
    currency: { type: String, required: true },
    locale: { type: String, required: true },
    status: {
      type: String,
      enum: ['provisioning', 'active', 'suspended', 'failed'],
      required: true,
    },
    placement: { type: String, enum: ['shared', 'dedicated'], required: true },
    settings: {
      requireMfa: { type: Boolean, default: false },
    },
    rootOrgUnitId: String,
    adminUserId: String,
    provisioning: {
      completed: { type: [String], default: [] },
      error: String,
    },
  },
  { collection: 'tenants', timestamps: true, versionKey: false },
);
tenantSchema.index(
  { slug: 1 },
  { unique: true, partialFilterExpression: { slug: { $type: 'string' } } },
);
tenantSchema.index({ status: 1, createdAt: -1 });
// A field named `language` would be read as MongoDB's text-search language override,
// which rejects values like `ar`; point the override at a field that never exists.
tenantSchema.index(
  { name: 'text', requestedSlug: 'text' },
  { default_language: 'none', language_override: 'textSearchLanguageNone' },
);

export function tenantModel(conn: Connection): Model<Tenant> {
  return (conn.models.Tenant as Model<Tenant>) ?? conn.model<Tenant>('Tenant', tenantSchema);
}

export function toTenantDto(t: Tenant) {
  return {
    id: String(t._id),
    slug: t.slug ?? null,
    name: t.name,
    countryCode: t.countryCode,
    industryCode: t.industryCode,
    defaultLanguage: t.defaultLanguage,
    timezone: t.timezone,
    currency: t.currency,
    locale: t.locale,
    status: t.status,
    placement: t.placement,
    settings: t.settings,
    createdAt: t.createdAt,
  };
}
