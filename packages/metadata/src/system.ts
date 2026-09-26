import { SYSTEM_COLUMNS, type ConfigLayer } from './types';

/** Built-in entities. Companies can add custom fields to them but cannot change what they are. */
export const SYSTEM_ENTITY_KEYS = ['user', 'org_unit'] as const;

/** Fields the built-in entities already have; custom fields cannot reuse these keys. */
export const NATIVE_FIELDS: Record<string, string[]> = {
  user: ['id', 'name', 'email', 'status', 'language', 'timezone', 'password', 'mfa'],
  org_unit: ['id', 'name', 'code', 'type', 'parent', 'path', 'depth', 'status'],
};

/** Keys no custom field may use on any entity. */
export const RESERVED_FIELD_KEYS = new Set<string>([
  ...SYSTEM_COLUMNS,
  'id',
  '_id',
  'tenant_id',
  'tenantid',
  'data',
  'custom',
  'org_unit',
  'org_path',
]);

/** The platform layer every company starts from. Packs are layered on top of it. */
export function platformBaseLayer(): ConfigLayer {
  return {
    entities: [
      {
        key: 'user',
        kind: 'system',
        label: { en: 'User', hi: 'उपयोगकर्ता', ar: 'مستخدم' },
        pluralLabel: { en: 'Users', hi: 'उपयोगकर्ता', ar: 'المستخدمون' },
        icon: 'person',
        orgScoped: false,
        fields: [],
      },
      {
        key: 'org_unit',
        kind: 'system',
        label: { en: 'Organization unit', hi: 'संगठन इकाई', ar: 'وحدة تنظيمية' },
        pluralLabel: { en: 'Organization units', hi: 'संगठन इकाइयाँ', ar: 'الوحدات التنظيمية' },
        icon: 'diagram-3',
        orgScoped: false,
        fields: [],
      },
    ],
    picklists: [],
    forms: [],
    listViews: [],
    numbering: [],
    workflows: [],
    rules: [],
    automations: [],
    templates: [],
    printTemplates: [],
    reports: [],
    dashboards: [],
  };
}
