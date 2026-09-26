import type { AutomationDef, MessageTemplate, RuleDef, WorkflowDef } from './automation-types';
import type { DashboardDef } from './dashboards';
import type { IdentifierType, WorkCalendar } from './identifiers';
import type { InstalledPack } from './packs';
import type { EntityTaxSettings, TaxSetup } from './tax';
import type { PrintTemplateDef } from './print';
import type { ReportDef } from './reports';

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
  'table',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/** Types whose value is computed by the server, never sent by the client. */
export const COMPUTED_TYPES: ReadonlySet<FieldType> = new Set(['formula', 'autonumber']);

/** Fields the server fills: formulas, auto-numbers and fields added by the tax engine. */
export function isCalculated(f: Pick<FieldDef, 'type' | 'calculated'>): boolean {
  return COMPUTED_TYPES.has(f.type) || !!f.calculated;
}

/** Column types a table field (line items) can have. */
export const TABLE_COLUMN_TYPES: readonly FieldType[] = [
  'text',
  'longtext',
  'integer',
  'decimal',
  'currency',
  'percent',
  'date',
  'boolean',
  'select',
  'lookup',
  'formula',
];

/** Default and hard limit on rows in one table field. */
export const TABLE_MAX_ROWS = 500;

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
  // table: rows stored inside the record, each column a field of its own
  columns?: FieldDef[];
  /** Text fields: validated as this identifier type (e.g. a tax number), from a Country Pack. */
  identifier?: string;
  /** Filled by the server (the tax engine); never set in the Studio. */
  calculated?: 'tax';
  /**
   * When left empty, filled on save from a linked record: `item.price` copies the `price`
   * of the record the `item` lookup (a field, or a column of the same line) points to.
   */
  defaultFrom?: string;
  /** At most this many rows (default and maximum 500). */
  maxRows?: number;
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
  /** What the entity is, for packs: e.g. `customer`, `item`, `sales_invoice`. */
  roles?: string[];
  /** Taxes calculated on its line items. */
  tax?: EntityTaxSettings;
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
  /** One per entity. Missing in layers saved before Step 4; read them through `normalizeLayer`. */
  workflows: WorkflowDef[];
  rules: RuleDef[];
  automations: AutomationDef[];
  templates: MessageTemplate[];
  /** Step 5. Missing in layers saved before it; read them through `normalizeLayer`. */
  printTemplates: PrintTemplateDef[];
  reports: ReportDef[];
  dashboards: DashboardDef[];
  /** Step 6: tax data, identifier types and the working calendar (usually from a Country Pack). */
  taxes?: TaxSetup;
  identifierTypes: IdentifierType[];
  calendar?: WorkCalendar;
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
  /** Installed packs, as snapshots of the version installed. Below the company layer. */
  packs?: InstalledPack[];
  /**
   * Entities and fields that removed or upgraded packs no longer define but that hold data,
   * kept archived so no record is orphaned.
   */
  retired?: ConfigLayer;
}

/** The merged configuration that applies to one place in the org tree. */
export interface EffectiveConfig extends Omit<ConfigLayer, 'entities'> {
  entities: EntityDef[];
  version: number;
  settings: Required<Pick<ConfigSettings, 'fiscalYearStartMonth'>> & ConfigSettings;
}

export function emptyLayer(): ConfigLayer {
  return {
    entities: [],
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
    identifierTypes: [],
  };
}

/** Fills lists that older saved configurations do not have. */
export function normalizeTenantConfig(config: TenantConfig): TenantConfig {
  return {
    ...config,
    company: normalizeLayer(config.company),
    orgUnits: Object.fromEntries(
      Object.entries(config.orgUnits).map(([id, l]) => [id, normalizeLayer(l)]),
    ),
    ...(config.retired ? { retired: normalizeLayer(config.retired) } : {}),
  };
}

/** Fills lists that older saved layers do not have. */
export function normalizeLayer<T extends Partial<ConfigLayer>>(layer: T): T & ConfigLayer {
  return { ...emptyLayer(), ...layer } as T & ConfigLayer;
}

/** Columns every record has, usable in list views and sorting. */
export const SYSTEM_COLUMNS = [
  'number',
  'status',
  'createdAt',
  'updatedAt',
  'createdBy',
  'updatedBy',
  'orgUnitId',
] as const;
export type SystemColumn = (typeof SYSTEM_COLUMNS)[number];
