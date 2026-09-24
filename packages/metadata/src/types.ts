/** Text in several languages, e.g. `{ en: 'Student', hi: 'छात्र', ar: 'طالب' }`. */
export type LocalizedText = Record<string, string>;

export const FIELD_TYPES = [
  'text',
  'longtext',
  'integer',
  'decimal',
  'currency',
  'percent',
  'date',
  'datetime',
  'time',
  'boolean',
  'select',
  'multiselect',
  'email',
  'phone',
  'url',
  'lookup',
  'lookup_many',
  'file',
  'image',
  'formula',
  'autonumber',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/** Types whose value is computed by the server, never sent by the client. */
export const COMPUTED_TYPES: ReadonlySet<FieldType> = new Set(['formula', 'autonumber']);

export interface FieldDef {
  key: string;
  type: FieldType;
  label: LocalizedText;
  help?: LocalizedText;
  required?: boolean;
  unique?: boolean;
  searchable?: boolean;
  /** Hidden from forms and lists, data kept. Published fields are archived instead of deleted. */
  archived?: boolean;
  /** Set by a Country or Industry Pack: the field cannot be removed or retyped. */
  locked?: boolean;
  default?: unknown;
  // text
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  // numbers
  min?: number;
  max?: number;
  /** Digits after the decimal point for decimal and currency. */
  scale?: number;
  /** Fixed currency for a currency field; empty means the company currency. */
  currency?: string;
  // select / multiselect
  picklist?: string;
  // lookup / lookup_many: a custom entity key, or the built-ins `user` and `org_unit`
  target?: string;
  // formula
  formula?: string;
  resultType?: 'number' | 'text' | 'boolean' | 'date';
  // autonumber
  numbering?: string;
  // file / image
  accept?: string[];
  maxSizeMb?: number;
}

export interface EntityDef {
  key: string;
  /** `system` entities (user, org_unit) are built in; only custom fields can be added to them. */
  kind: 'custom' | 'system';
  label: LocalizedText;
  pluralLabel: LocalizedText;
  icon?: string;
  /** Field shown as the record's title in lists and lookups. */
  titleField?: string;
  /** Records belong to an org unit and follow org-unit permission scope. */
  orgScoped?: boolean;
  archived?: boolean;
  fields: FieldDef[];
}

export interface PicklistOption {
  value: string;
  label: LocalizedText;
  color?: string;
  active?: boolean;
}

export interface PicklistDef {
  key: string;
  label: LocalizedText;
  options: PicklistOption[];
}

export interface FormSection {
  key: string;
  label: LocalizedText;
  columns: 1 | 2 | 3;
  fields: string[];
}

export interface FormLayout {
  entity: string;
  sections: FormSection[];
}

export interface ListView {
  entity: string;
  columns: string[];
  sort?: { field: string; dir: 'asc' | 'desc' };
  pageSize?: number;
}

export interface NumberingSeries {
  key: string;
  label: LocalizedText;
  /** e.g. `ADM/{FY}/{BRANCH}/{SEQ:5}` */
  pattern: string;
  reset: 'never' | 'yearly' | 'monthly';
  /** `org_unit`: separate counters per org unit, `company`: one counter for the company. */
  scope: 'company' | 'org_unit';
}

export interface ConfigSettings {
  /** 1 = January. Defaults from the company's country (India: 4). */
  fiscalYearStartMonth?: number;
  defaultLanguage?: string;
}

/**
 * An entity as it appears in one layer. A layer can add fields to an entity
 * defined further up (e.g. a branch adding a field to Student) without
 * repeating its labels; the merged result must be complete.
 */
export type EntityPatch = { key: string; fields: FieldDef[] } & Partial<
  Omit<EntityDef, 'key' | 'fields'>
>;

/** One layer of configuration: platform base, a pack, the company, or an org-unit override. */
export interface ConfigLayer {
  entities: EntityPatch[];
  picklists: PicklistDef[];
  forms: FormLayout[];
  listViews: ListView[];
  numbering: NumberingSeries[];
  settings?: ConfigSettings;
}

/** An org-unit override: applies to that unit and every unit below it. */
export interface OrgUnitLayer extends ConfigLayer {
  /** Path of the unit when the override was saved; used to order and describe overrides. */
  path: string;
  name?: string;
}

/** Everything a company configures: its own layer plus overrides keyed by org unit id. */
export interface TenantConfig {
  company: ConfigLayer;
  orgUnits: Record<string, OrgUnitLayer>;
}

/** The merged configuration that applies to one place in the org tree. */
export interface EffectiveConfig extends Omit<ConfigLayer, 'entities'> {
  entities: EntityDef[];
  version: number;
  settings: Required<Pick<ConfigSettings, 'fiscalYearStartMonth'>> & ConfigSettings;
}

export function emptyLayer(): ConfigLayer {
  return { entities: [], picklists: [], forms: [], listViews: [], numbering: [] };
}

/** Columns every record has, usable in list views and sorting. */
export const SYSTEM_COLUMNS = [
  'number',
  'createdAt',
  'updatedAt',
  'createdBy',
  'updatedBy',
  'orgUnitId',
] as const;
export type SystemColumn = (typeof SYSTEM_COLUMNS)[number];
