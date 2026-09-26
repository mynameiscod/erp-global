export type PermissionScope = 'platform' | 'tenant';

export interface PermissionDef {
  key: string;
  module: string;
  scope: PermissionScope;
  description: string;
}

/**
 * The permission catalog. Keys follow `module.entity.action`.
 * Tenant permissions are granted through roles assigned at an org unit and
 * apply to that unit and every unit below it.
 */
export const PERMISSIONS = [
  {
    key: 'platform.tenant.read',
    module: 'platform',
    scope: 'platform',
    description: 'View all tenants',
  },
  {
    key: 'platform.tenant.manage',
    module: 'platform',
    scope: 'platform',
    description: 'Create, suspend and configure tenants',
  },

  {
    key: 'tenant.settings.read',
    module: 'tenant',
    scope: 'tenant',
    description: 'View company settings',
  },
  {
    key: 'tenant.settings.update',
    module: 'tenant',
    scope: 'tenant',
    description: 'Change company settings',
  },

  { key: 'org.unit.read', module: 'org', scope: 'tenant', description: 'View organization units' },
  {
    key: 'org.unit.create',
    module: 'org',
    scope: 'tenant',
    description: 'Create organization units',
  },
  {
    key: 'org.unit.update',
    module: 'org',
    scope: 'tenant',
    description: 'Rename or edit organization units',
  },
  {
    key: 'org.unit.move',
    module: 'org',
    scope: 'tenant',
    description: 'Move organization units in the hierarchy',
  },
  {
    key: 'org.unit.deactivate',
    module: 'org',
    scope: 'tenant',
    description: 'Deactivate organization units',
  },

  { key: 'access.role.read', module: 'access', scope: 'tenant', description: 'View roles' },
  {
    key: 'access.role.manage',
    module: 'access',
    scope: 'tenant',
    description: 'Create, edit and delete roles',
  },
  {
    key: 'access.assignment.read',
    module: 'access',
    scope: 'tenant',
    description: 'View role assignments',
  },
  {
    key: 'access.assignment.manage',
    module: 'access',
    scope: 'tenant',
    description: 'Assign and remove roles',
  },

  { key: 'identity.user.read', module: 'identity', scope: 'tenant', description: 'View users' },
  { key: 'identity.user.invite', module: 'identity', scope: 'tenant', description: 'Invite users' },
  {
    key: 'identity.user.manage',
    module: 'identity',
    scope: 'tenant',
    description: 'Deactivate and reactivate users',
  },

  {
    key: 'config.read',
    module: 'config',
    scope: 'tenant',
    description: 'View the configuration studio',
  },
  {
    key: 'config.manage',
    module: 'config',
    scope: 'tenant',
    description: 'Edit draft configuration: entities, fields, forms, lists, numbering',
  },
  {
    key: 'config.publish',
    module: 'config',
    scope: 'tenant',
    description: 'Publish and roll back configuration versions',
  },

  {
    key: 'workflow.automation.manage',
    module: 'workflow',
    scope: 'tenant',
    description: 'View automation runs, re-run failures and see the webhook signing secret',
  },

  {
    key: 'reports.personal',
    module: 'reports',
    scope: 'tenant',
    description: 'Build personal reports and dashboards from data you can see',
  },
  {
    key: 'reports.share',
    module: 'reports',
    scope: 'tenant',
    description: 'Share personal reports and dashboards with a role',
  },
  {
    key: 'reports.export',
    module: 'reports',
    scope: 'tenant',
    description: 'Export reports to Excel, CSV or PDF and receive scheduled reports',
  },

  { key: 'audit.event.read', module: 'audit', scope: 'tenant', description: 'View the audit log' },
  {
    key: 'audit.chain.verify',
    module: 'audit',
    scope: 'tenant',
    description: 'Verify audit log integrity',
  },
] as const satisfies readonly PermissionDef[];

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

export const TENANT_PERMISSION_KEYS: PermissionKey[] = PERMISSIONS.filter(
  (p) => p.scope === 'tenant',
).map((p) => p.key);

export const PLATFORM_PERMISSION_KEYS: PermissionKey[] = PERMISSIONS.filter(
  (p) => p.scope === 'platform',
).map((p) => p.key);

const ALL_KEYS = new Set<string>(PERMISSIONS.map((p) => p.key));

export function isPermissionKey(value: string): value is PermissionKey {
  return ALL_KEYS.has(value);
}

// ---- record permissions (generated per custom entity) ----

export const RECORD_ACTIONS = ['read', 'create', 'update', 'delete'] as const;
export type RecordAction = (typeof RECORD_ACTIONS)[number];

/**
 * Permissions for custom entities are generated from published config:
 * `records.<entity>.<action>`. A `*` segment matches any entity or action,
 * e.g. `records.*.read` (read everything) or `records.*.*` (full access).
 */
export type RecordPermission = `records.${string}.${RecordAction | '*'}`;

/** Anything that can be granted through a role. */
export type Permission = PermissionKey | RecordPermission;

export const ENTITY_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
const RECORD_PERMISSION_RE = /^records\.([a-z][a-z0-9_]{1,39}|\*)\.(read|create|update|delete|\*)$/;

export function recordPermission(entity: string, action: RecordAction): RecordPermission {
  return `records.${entity}.${action}`;
}

export function isRecordPermission(value: string): value is RecordPermission {
  return RECORD_PERMISSION_RE.test(value);
}

export function isPermission(value: string): value is Permission {
  return isPermissionKey(value) || isRecordPermission(value);
}

/** Does a granted permission (possibly with `*` segments) cover the requested one? */
export function permissionMatches(granted: string, requested: string): boolean {
  if (granted === requested) return true;
  if (!granted.includes('*')) return false;
  const g = granted.split('.');
  const r = requested.split('.');
  return g.length === r.length && g.every((seg, i) => seg === '*' || seg === r[i]);
}
