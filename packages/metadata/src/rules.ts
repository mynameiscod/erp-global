import type { RuleDef, WorkflowDef, WorkflowState } from './automation-types';
import { compileFormula, FormulaError, type CompiledFormula, type EvalContext } from './formula';
import { pickText } from './i18n';
import type { RecordData, RecordIssue } from './record';
import type { EffectiveConfig, EntityDef, FieldDef } from './types';

/**
 * Business rules on save. The same code runs in the browser (instant hide, require and
 * read-only on forms) and in records-service, which is the authority: a rule skipped in
 * the browser is still applied on the server.
 */

export interface RuleEnv {
  /** Values before this save; missing on create. */
  old?: RecordData;
  user?: { id: string; roles: string[] };
  unitCodes?: string[];
  status?: string | null;
  now?: Date;
}

export interface FieldEffects {
  hidden: Set<string>;
  readonly: Set<string>;
  required: Set<string>;
}

const compiled = new Map<string, CompiledFormula | null>();

/** Compiles and caches a formula; returns null (and never throws) for invalid ones. */
function formula(src: string): CompiledFormula | null {
  if (!compiled.has(src)) {
    try {
      compiled.set(src, compileFormula(src));
    } catch {
      compiled.set(src, null);
    }
    if (compiled.size > 2000) compiled.delete(compiled.keys().next().value!);
  }
  return compiled.get(src) ?? null;
}

function ctxFor(data: RecordData, env: RuleEnv): EvalContext {
  return {
    fields: data,
    now: env.now ?? new Date(),
    old: env.old,
    user: env.user,
    unitCodes: env.unitCodes,
    status: env.status,
  };
}

/**
 * True when a condition holds. An empty condition always holds. A condition that fails
 * to evaluate (e.g. text where a number is expected) does not hold.
 */
export function conditionHolds(
  condition: string | undefined,
  data: RecordData,
  env: RuleEnv,
): boolean {
  if (!condition?.trim()) return true;
  const f = formula(condition);
  if (!f) return false;
  try {
    const v = f.evaluate(ctxFor(data, env));
    return v !== null && v !== false && v !== 0 && v !== '';
  } catch (e) {
    if (e instanceof FormulaError) return false;
    throw e;
  }
}

/** Evaluates a value formula, converted to suit the target field. */
export function evaluateValue(
  source: string,
  field: FieldDef | undefined,
  data: RecordData,
  env: RuleEnv,
): unknown {
  const f = formula(source);
  if (!f) return undefined;
  let v: unknown;
  try {
    v = f.evaluate(ctxFor(data, env));
  } catch (e) {
    if (e instanceof FormulaError) return undefined;
    throw e;
  }
  if (v === null || !field) return v;
  switch (field.type) {
    case 'integer':
    case 'decimal':
    case 'percent':
      return typeof v === 'number' ? v : Number(v);
    case 'currency':
      return { amount: typeof v === 'number' ? v : Number(v) };
    case 'boolean':
      return v === true || v === 'true' || v === 1;
    case 'multiselect':
    case 'lookup_many':
      return String(v)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    default:
      return typeof v === 'string' ? v : String(v);
  }
}

export function rulesFor(
  cfg: Pick<EffectiveConfig, 'rules'>,
  entity: string,
  event: 'create' | 'update',
): RuleDef[] {
  return (cfg.rules ?? []).filter(
    (r) => r.entity === entity && r.active !== false && (r.on === 'save' || r.on === event),
  );
}

/**
 * First pass, on the incoming values: which fields are hidden, read-only or required, and
 * the values that `set` rules produce. Hidden and read-only fields keep their previous
 * value (on create: no value), whatever the client sent.
 */
export function applyFieldRules(
  entity: EntityDef,
  rules: RuleDef[],
  input: RecordData,
  env: RuleEnv,
): { data: RecordData; effects: FieldEffects } {
  const data: RecordData = { ...input };
  const effects: FieldEffects = { hidden: new Set(), readonly: new Set(), required: new Set() };
  const fields = new Map(entity.fields.map((f) => [f.key, f]));
  for (const r of rules) {
    if (!r.field || r.effect === 'block') continue;
    if (!conditionHolds(r.condition, data, env)) continue;
    if (r.effect === 'set' && r.value) {
      const v = evaluateValue(r.value, fields.get(r.field), data, env);
      if (v !== undefined) data[r.field] = v;
    } else if (r.effect === 'hide') effects.hidden.add(r.field);
    else if (r.effect === 'readonly') effects.readonly.add(r.field);
    else if (r.effect === 'require') effects.required.add(r.field);
  }
  for (const k of [...effects.hidden, ...effects.readonly]) {
    // A `set` rule may still write a read-only field; only user input is reverted.
    const setByRule = rules.some(
      (r) => r.effect === 'set' && r.field === k && conditionHolds(r.condition, data, env),
    );
    if (setByRule) continue;
    if (env.old && k in env.old) data[k] = env.old[k];
    else delete data[k];
  }
  return { data, effects };
}

const empty = (v: unknown) =>
  v === undefined ||
  v === null ||
  v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' &&
    v !== null &&
    'amount' in v &&
    (v as { amount: unknown }).amount === null);

/** Second pass, on the final values: required fields and blocking rules. */
export function checkRules(
  rules: RuleDef[],
  data: RecordData,
  effects: FieldEffects,
  env: RuleEnv,
  lang = 'en',
): RecordIssue[] {
  const issues: RecordIssue[] = [];
  for (const k of effects.required) {
    if (!effects.hidden.has(k) && empty(data[k])) issues.push({ field: k, message: 'Required' });
  }
  for (const r of rules) {
    if (r.effect !== 'block' || !conditionHolds(r.condition, data, env)) continue;
    issues.push({
      field: r.field ?? '_record',
      message: r.message ? pickText(r.message, lang) : 'This change is not allowed',
    });
  }
  return issues;
}

// ---- workflow helpers shared by records-service, workflow-service and the web ----

export function workflowFor(
  cfg: Pick<EffectiveConfig, 'workflows'>,
  entity: string,
): WorkflowDef | undefined {
  return (cfg.workflows ?? []).find((w) => w.entity === entity && w.active !== false);
}

export function stateOf(
  wf: WorkflowDef,
  key: string | null | undefined,
): WorkflowState | undefined {
  return key ? wf.states.find((s) => s.key === key) : undefined;
}

/** Fields that cannot change in the record's current state (all fields when locked). */
export function lockedFields(
  wf: WorkflowDef | undefined,
  status: string | null | undefined,
  entity: EntityDef,
): Set<string> {
  const state = wf ? stateOf(wf, status) : undefined;
  if (!state?.locked) return new Set();
  const editable = new Set(state.editableFields ?? []);
  return new Set(entity.fields.map((f) => f.key).filter((k) => !editable.has(k)));
}
