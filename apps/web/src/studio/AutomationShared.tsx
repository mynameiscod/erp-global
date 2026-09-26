import { useMemo } from 'react';
import { Button, Form, InputGroup } from 'react-bootstrap';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  compileFormula,
  FormulaError,
  type ApproverSpec,
  type EntityDef,
  type Recipient,
} from '@erp/metadata';
import { api } from '../api/client';
import type { RoleDto } from '../api/types';
import { useLabel } from '../config/hooks';
import { useStudio } from './StudioContext';

/** Checks a condition or value formula against the entity's fields; returns an error or null. */
export function formulaProblem(
  src: string | undefined,
  entity: EntityDef | undefined,
): string | null {
  if (!src?.trim()) return null;
  try {
    const f = compileFormula(src);
    const keys = new Set(entity?.fields.map((x) => x.key) ?? []);
    const unknown = f.fields.find((k) => !keys.has(k));
    return unknown ? `Unknown field "${unknown}"` : null;
  } catch (e) {
    return e instanceof FormulaError ? e.message : 'Invalid formula';
  }
}

/** A formula box with live checking and the field keys as hints. */
export function ConditionInput({
  id,
  value,
  onChange,
  entity,
  placeholder,
}: {
  id: string;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  entity: EntityDef | undefined;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  const problem = formulaProblem(value, entity);
  return (
    <>
      <Form.Control
        id={id}
        as="textarea"
        rows={2}
        dir="ltr"
        className="font-monospace small"
        value={value ?? ''}
        isInvalid={!!problem}
        placeholder={placeholder ?? t('automation.conditionPlaceholder')}
        onChange={(e) => onChange(e.target.value || undefined)}
      />
      {problem ? (
        <Form.Control.Feedback type="invalid">{problem}</Form.Control.Feedback>
      ) : (
        <Form.Text muted className="d-block text-truncate" dir="ltr">
          {entity?.fields.map((f) => f.key).join(' · ')} · old.x · CHANGED(x) · HAS_ROLE("…") ·
          IN_UNIT("…") · STATUS()
        </Form.Text>
      )}
    </>
  );
}

export function useRoles() {
  return useQuery({ queryKey: ['roles'], queryFn: () => api<RoleDto[]>('/access/roles') });
}

/**
 * Roles to choose from: the company's roles, plus the roles installed packs bring (known by
 * key; the role itself is created when the pack is published). `value` is a role id, or
 * `key:<roleKey>` for a pack role.
 */
export function useRoleChoices() {
  const roles = useRoles();
  const { draft } = useStudio();
  const label = useLabel();
  return useMemo(() => {
    const byKey = new Map<string, { name: string; id?: string }>();
    for (const p of draft.config.packs ?? [])
      for (const r of p.manifest.roles ?? []) byKey.set(r.key, { name: label(r.name) || r.key });
    for (const r of roles.data ?? []) if (r.key) byKey.set(r.key, { name: r.name, id: r.id });
    const options = [
      ...(roles.data ?? []).map((r) => ({ value: r.id, name: r.name, pack: false })),
      ...[...byKey]
        .filter(([, v]) => !v.id)
        .map(([k, v]) => ({ value: `key:${k}`, name: v.name, pack: true })),
    ];
    /** The role's name for display: by id, or by key (a pack role), falling back to the key. */
    const nameOf = (ref: { roleId?: string; roleKey?: string }) =>
      ref.roleId
        ? (roles.data?.find((r) => r.id === ref.roleId)?.name ?? ref.roleId)
        : ref.roleKey
          ? (byKey.get(ref.roleKey)?.name ?? ref.roleKey)
          : '';
    return { options, nameOf, byKey, loading: roles.isLoading };
  }, [roles.data, roles.isLoading, draft.config.packs, label]);
}

/** A role reference as a select value, and back. */
export const roleValue = (s: { roleId?: string; roleKey?: string }) =>
  s.roleId ?? (s.roleKey ? `key:${s.roleKey}` : '');
export const roleRef = (v: string): { roleId?: string; roleKey?: string } =>
  v.startsWith('key:') ? { roleKey: v.slice(4) } : { roleId: v };

type Spec = ApproverSpec | Recipient;
type SpecType = Spec['type'];

/**
 * Edits a list of approvers (workflow levels) or recipients (notifications). Users are
 * entered by id for now; roles, manager, unit head, creator and user fields by choice.
 */
export function PeopleEditor({
  value,
  onChange,
  entity,
  kinds,
}: {
  value: Spec[];
  onChange: (v: Spec[]) => void;
  entity: EntityDef | undefined;
  kinds: SpecType[];
}) {
  const { t } = useTranslation();
  const label = useLabel();
  const roles = useRoleChoices();
  const userFields = (entity?.fields ?? []).filter(
    (f) => (f.type === 'lookup' || f.type === 'lookup_many') && f.target === 'user',
  );
  const set = (i: number, s: Spec) => onChange(value.map((x, n) => (n === i ? s : x)));
  const blank = (type: SpecType): Spec => {
    switch (type) {
      case 'role':
        return { type, ...roleRef(roles.options[0]?.value ?? '') };
      case 'users':
        return { type, userIds: [] };
      case 'field':
        return { type, field: userFields[0]?.key ?? '' };
      default:
        return { type } as Spec;
    }
  };
  return (
    <div>
      {value.map((s, i) => (
        <InputGroup key={i} size="sm" className="mb-1">
          <Form.Select
            value={s.type}
            style={{ maxWidth: 170 }}
            onChange={(e) => set(i, blank(e.target.value as SpecType))}
          >
            {kinds.map((k) => (
              <option key={k} value={k}>
                {t(`automation.who.${k}`)}
              </option>
            ))}
          </Form.Select>
          {s.type === 'role' && (
            <Form.Select
              value={roleValue(s)}
              onChange={(e) => set(i, { type: 'role', ...roleRef(e.target.value) })}
            >
              {!roles.options.some((o) => o.value === roleValue(s)) && (
                <option value={roleValue(s)}>
                  {s.roleKey && !s.roleId
                    ? t('studio.roles.packRole', { name: roles.nameOf(s) })
                    : roles.nameOf(s)}
                </option>
              )}
              {roles.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.pack ? t('studio.roles.packRole', { name: o.name }) : o.name}
                </option>
              ))}
            </Form.Select>
          )}
          {s.type === 'field' && (
            <Form.Select value={s.field} onChange={(e) => set(i, { ...s, field: e.target.value })}>
              {userFields.map((f) => (
                <option key={f.key} value={f.key}>
                  {label(f.label)}
                </option>
              ))}
            </Form.Select>
          )}
          {s.type === 'users' && (
            <Form.Control
              dir="ltr"
              className="font-monospace"
              placeholder={t('automation.userIds')}
              value={s.userIds.join(', ')}
              onChange={(e) =>
                set(i, { ...s, userIds: e.target.value.split(/[\s,]+/).filter(Boolean) })
              }
            />
          )}
          <Button
            variant="outline-danger"
            onClick={() => onChange(value.filter((_, n) => n !== i))}
          >
            <i className="bi bi-x-lg" />
          </Button>
        </InputGroup>
      ))}
      <Button
        size="sm"
        variant="link"
        className="px-0"
        onClick={() => onChange([...value, blank(kinds[0])])}
      >
        <i className="bi bi-plus-lg me-1" />
        {t('automation.addPerson')}
      </Button>
    </div>
  );
}

/** Field = formula rows (automation "update" and "create" actions). */
export function AssignmentsEditor({
  value,
  onChange,
  target,
  source,
}: {
  value: { field: string; value: string }[];
  onChange: (v: { field: string; value: string }[]) => void;
  target: EntityDef | undefined;
  source: EntityDef | undefined;
}) {
  const { t } = useTranslation();
  const label = useLabel();
  const fields = (target?.fields ?? []).filter(
    (f) => !f.archived && f.type !== 'formula' && f.type !== 'autonumber',
  );
  const set = (i: number, patch: Partial<{ field: string; value: string }>) =>
    onChange(value.map((x, n) => (n === i ? { ...x, ...patch } : x)));
  return (
    <div>
      {value.map((a, i) => {
        const problem = formulaProblem(a.value, source);
        return (
          <InputGroup key={i} size="sm" className="mb-1" hasValidation>
            <Form.Select
              value={a.field}
              style={{ maxWidth: 200 }}
              onChange={(e) => set(i, { field: e.target.value })}
            >
              {fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {label(f.label)}
                </option>
              ))}
            </Form.Select>
            <InputGroup.Text>=</InputGroup.Text>
            <Form.Control
              dir="ltr"
              className="font-monospace"
              value={a.value}
              isInvalid={!!problem}
              placeholder='"Approved" · TODAY() · amount * 2'
              onChange={(e) => set(i, { value: e.target.value })}
            />
            <Button
              variant="outline-danger"
              onClick={() => onChange(value.filter((_, n) => n !== i))}
            >
              <i className="bi bi-x-lg" />
            </Button>
            {problem && <Form.Control.Feedback type="invalid">{problem}</Form.Control.Feedback>}
          </InputGroup>
        );
      })}
      <Button
        size="sm"
        variant="link"
        className="px-0"
        disabled={!fields.length}
        onClick={() => onChange([...value, { field: fields[0]?.key ?? '', value: '' }])}
      >
        <i className="bi bi-plus-lg me-1" />
        {t('automation.addValue')}
      </Button>
    </div>
  );
}

/** Multi-select as a row of toggle checkboxes. */
export function ChecklistInput<T extends string>({
  id,
  options,
  value,
  onChange,
  labelOf,
}: {
  id: string;
  options: T[];
  value: T[];
  onChange: (v: T[]) => void;
  labelOf: (v: T) => string;
}) {
  return (
    <div className="d-flex flex-wrap gap-3">
      {options.map((o) => (
        <Form.Check
          key={o}
          id={`${id}-${o}`}
          type="checkbox"
          label={labelOf(o)}
          checked={value.includes(o)}
          onChange={(e) =>
            onChange(e.target.checked ? [...value, o] : value.filter((x) => x !== o))
          }
        />
      ))}
    </div>
  );
}
