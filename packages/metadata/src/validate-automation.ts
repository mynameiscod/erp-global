import type { ApproverSpec, AutomationDef, Recipient, WorkflowDef } from './automation-types';
import { BUILTIN_TEMPLATE_KEYS } from './builtin-templates';
import { compileFormula, FormulaError } from './formula';
import type { ConfigLayer, EntityPatch } from './types';

type Add = (path: string, message: string) => void;

/** Checks a condition or value formula against the fields of an entity. */
function checkFormula(src: string | undefined, entity: EntityPatch, path: string, add: Add): void {
  if (!src?.trim()) return;
  try {
    const f = compileFormula(src);
    const keys = new Set(entity.fields.map((x) => x.key));
    for (const d of f.fields) if (!keys.has(d)) add(path, `Unknown field "${d}"`);
  } catch (e) {
    add(path, e instanceof FormulaError ? e.message : 'Invalid formula');
  }
}

function userField(entity: EntityPatch, key: string): boolean {
  return entity.fields.some(
    (f) =>
      f.key === key && (f.type === 'lookup' || f.type === 'lookup_many') && f.target === 'user',
  );
}

function checkApprovers(
  list: ApproverSpec[] | Recipient[],
  entity: EntityPatch,
  path: string,
  add: Add,
) {
  for (const a of list) {
    if (a.type === 'field' && !userField(entity, a.field)) {
      add(path, `"${a.field}" must be a field that links to a user`);
    }
  }
}

function checkWorkflow(w: WorkflowDef, entities: Map<string, EntityPatch>, add: Add): void {
  const p = `workflows.${w.entity}`;
  const entity = entities.get(w.entity);
  if (!entity || entity.kind !== 'custom') {
    add(p, `Workflows can only be added to custom entities ("${w.entity}")`);
    return;
  }
  const states = new Set<string>();
  for (const s of w.states) {
    if (states.has(s.key)) add(`${p}.states.${s.key}`, `Duplicate state "${s.key}"`);
    states.add(s.key);
    for (const f of s.editableFields ?? []) {
      if (!entity.fields.some((x) => x.key === f))
        add(`${p}.states.${s.key}`, `Unknown field "${f}"`);
    }
  }
  if (!states.has(w.initialState)) add(p, `Unknown starting state "${w.initialState}"`);
  const actions = new Set<string>();
  for (const a of w.actions) {
    const ap = `${p}.actions.${a.key}`;
    if (actions.has(a.key)) add(ap, `Duplicate action "${a.key}"`);
    actions.add(a.key);
    for (const f of a.from) if (!states.has(f)) add(ap, `Unknown state "${f}"`);
    if (!states.has(a.to)) add(ap, `Unknown state "${a.to}"`);
    checkFormula(a.condition, entity, `${ap}.condition`, add);
    if (a.approval) {
      for (const s of [a.approval.approvedState, a.approval.rejectedState]) {
        if (!states.has(s)) add(`${ap}.approval`, `Unknown state "${s}"`);
      }
      if (a.approval.approvedState === a.to) {
        add(`${ap}.approval`, 'The approved state must differ from the pending state');
      }
      const levels = new Set<string>();
      for (const l of a.approval.levels) {
        const lp = `${ap}.approval.levels.${l.key}`;
        if (levels.has(l.key)) add(lp, `Duplicate level "${l.key}"`);
        levels.add(l.key);
        checkFormula(l.condition, entity, `${lp}.condition`, add);
        checkApprovers(l.approvers, entity, lp, add);
        checkApprovers(l.escalateTo ?? [], entity, lp, add);
        if (
          l.remindAfterHours &&
          l.escalateAfterHours &&
          l.remindAfterHours >= l.escalateAfterHours
        ) {
          add(lp, 'The reminder should come before the escalation');
        }
      }
    }
  }
}

function checkAutomation(
  a: AutomationDef,
  entities: Map<string, EntityPatch>,
  workflows: Map<string, WorkflowDef>,
  templates: Set<string>,
  add: Add,
): void {
  const p = `automations.${a.key}`;
  const entity = entities.get(a.entity);
  if (!entity || entity.kind !== 'custom') {
    add(p, `Automations can only watch custom entities ("${a.entity}")`);
    return;
  }
  const hasField = (e: EntityPatch, k: string) => e.fields.some((f) => f.key === k);
  const wf = workflows.get(a.entity);
  const t = a.trigger;
  if (t.type === 'field_changed' && !hasField(entity, t.field))
    add(p, `Unknown field "${t.field}"`);
  if (t.type === 'status_changed') {
    if (!wf) add(p, `"${a.entity}" has no workflow`);
    else if (t.to && !wf.states.some((s) => s.key === t.to)) add(p, `Unknown state "${t.to}"`);
  }
  if (t.type === 'schedule' && t.every === 'day' && !t.at) add(p, 'Choose the time of day');
  checkFormula(a.condition, entity, `${p}.condition`, add);
  a.actions.forEach((act, i) => {
    const ap = `${p}.actions.${i}`;
    switch (act.type) {
      case 'notify':
        if (!templates.has(act.template)) add(ap, `Unknown message template "${act.template}"`);
        checkApprovers(act.recipients, entity, ap, add);
        break;
      case 'update':
        if (t.type === 'deleted') add(ap, 'A deleted record cannot be updated');
        for (const s of act.set) {
          if (!hasField(entity, s.field)) add(ap, `Unknown field "${s.field}"`);
          checkFormula(s.value, entity, ap, add);
        }
        break;
      case 'create': {
        const target = entities.get(act.entity);
        if (!target || target.kind !== 'custom') {
          add(ap, `Unknown entity "${act.entity}"`);
          break;
        }
        for (const s of act.set) {
          if (!hasField(target, s.field)) add(ap, `Unknown field "${s.field}" in ${act.entity}`);
          // Values are computed from the triggering record.
          checkFormula(s.value, entity, ap, add);
        }
        break;
      }
      case 'workflow_action':
        if (!wf) add(ap, `"${a.entity}" has no workflow`);
        else if (!wf.actions.some((x) => x.key === act.action)) {
          add(ap, `Unknown workflow action "${act.action}"`);
        }
        break;
      case 'webhook':
        break;
    }
  });
}

/** Cross-checks of Step 4 items in one merged configuration. */
export function checkAutomationItems(merged: ConfigLayer, add: Add): void {
  const entities = new Map(merged.entities.map((e) => [e.key, e]));
  const workflows = new Map(merged.workflows.map((w) => [w.entity, w]));
  const templates = new Set([...BUILTIN_TEMPLATE_KEYS, ...merged.templates.map((t) => t.key)]);
  for (const w of merged.workflows) checkWorkflow(w, entities, add);
  for (const r of merged.rules) {
    const p = `rules.${r.key}`;
    const entity = entities.get(r.entity);
    if (!entity || entity.kind !== 'custom') {
      add(p, `Rules can only be added to custom entities ("${r.entity}")`);
      continue;
    }
    checkFormula(r.condition, entity, `${p}.condition`, add);
    if (r.effect === 'block') {
      if (!r.message) add(p, 'Enter the message shown when the save is blocked');
    } else if (!r.field) add(p, 'Choose the field');
    else if (!entity.fields.some((f) => f.key === r.field)) add(p, `Unknown field "${r.field}"`);
    if (r.effect === 'set') {
      if (!r.value) add(p, 'Enter the value');
      checkFormula(r.value, entity, `${p}.value`, add);
    }
  }
  for (const a of merged.automations) checkAutomation(a, entities, workflows, templates, add);
}
