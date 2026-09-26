import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Form, Image, InputGroup, Spinner } from 'react-bootstrap';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Page } from '@erp/contracts';
import type { CurrencyValue, EffectiveConfig, FieldDef } from '@erp/metadata';
import { api, apiUpload } from '../api/client';
import type { OrgUnitDto, UserDto } from '../api/types';
import { useLabel } from '../config/hooks';
import { ErrorAlert } from '../components/ui';
import { TableInput } from './TableInput';

export interface FieldInputProps {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  cfg: EffectiveConfig;
  currency: string;
  invalid?: boolean;
  id: string;
}

interface Option {
  id: string;
  title: string;
}

/** Options for a lookup field: records of a custom entity, users, or org units. */
function useLookupOptions(target: string | undefined, q: string) {
  return useQuery({
    queryKey: ['lookup', target, q],
    enabled: !!target,
    staleTime: 30_000,
    queryFn: async (): Promise<Option[]> => {
      if (target === 'user') {
        const page = await api<Page<UserDto>>('/identity/users', { query: { q, pageSize: 20 } });
        return page.items.map((u) => ({ id: u.id, title: `${u.name} (${u.email})` }));
      }
      if (target === 'org_unit') {
        const units = await api<OrgUnitDto[]>('/org/units');
        return units
          .filter((u) => !q || u.name.toLowerCase().includes(q.toLowerCase()))
          .map((u) => ({ id: u.id, title: `${'— '.repeat(u.depth)}${u.name}` }));
      }
      const res = await api<{ id: string; number: string | null; title: string }[]>(
        `/records/${target}/lookup`,
        { query: { q } },
      );
      return res.map((r) => ({ id: r.id, title: r.number ? `${r.title} · ${r.number}` : r.title }));
    },
  });
}

/** Titles for ids that are already selected, so the picker can show names instead of ids. */
export function useLookupTitles(target: string | undefined, ids: string[]) {
  const key = [...ids].sort().join(',');
  return useQuery({
    queryKey: ['lookup-titles', target, key],
    enabled: !!target && ids.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Map<string, string>> => {
      if (target === 'user') {
        const users = await Promise.all(
          ids.map((id) => api<UserDto>(`/identity/users/${id}`).catch(() => null)),
        );
        return new Map(users.filter((u): u is UserDto => !!u).map((u) => [u.id, u.name]));
      }
      if (target === 'org_unit') {
        const units = await api<OrgUnitDto[]>('/org/units');
        return new Map(units.map((u) => [u.id, u.name]));
      }
      const res = await api<{ id: string; title: string }[]>(`/records/${target}/lookup`, {
        query: { ids: key },
      });
      return new Map(res.map((r) => [r.id, r.title]));
    },
  });
}

function LookupInput({ field, value, onChange, id }: FieldInputProps) {
  const { t } = useTranslation();
  const multiple = field.type === 'lookup_many';
  const selected = useMemo(
    () => (multiple ? ((value as string[] | undefined) ?? []) : value ? [value as string] : []),
    [multiple, value],
  );
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const h = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(h);
  }, [q]);
  const options = useLookupOptions(field.target, debounced);
  const titles = useLookupTitles(field.target, selected);
  const titleOf = (x: string) =>
    titles.data?.get(x) ?? options.data?.find((o) => o.id === x)?.title ?? '…';

  const choose = (x: string) => {
    if (!x) return;
    onChange(multiple ? [...new Set([...selected, x])] : x);
  };
  const remove = (x: string) => onChange(multiple ? selected.filter((s) => s !== x) : null);

  return (
    <div>
      {selected.length > 0 && (
        <div className="d-flex flex-wrap gap-1 mb-1">
          {selected.map((x) => (
            <Badge
              key={x}
              bg="primary-subtle"
              text="primary-emphasis"
              className="d-flex align-items-center gap-1"
            >
              {titleOf(x)}
              <Button
                variant="link"
                size="sm"
                className="p-0 lh-1"
                onClick={() => remove(x)}
                aria-label={t('records.remove')}
              >
                <i className="bi bi-x" />
              </Button>
            </Badge>
          ))}
        </div>
      )}
      <InputGroup size="sm">
        <Form.Control
          placeholder={t('records.searchHint')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Form.Select
          id={id}
          value=""
          onChange={(e) => choose(e.target.value)}
          style={{ maxWidth: '60%' }}
        >
          <option value="">{options.isLoading ? t('common.loading') : t('records.choose')}</option>
          {options.data
            ?.filter((o) => !selected.includes(o.id))
            .map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
              </option>
            ))}
        </Form.Select>
      </InputGroup>
    </div>
  );
}

function FileInput({ field, value, onChange, id }: FieldInputProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fileId = value as string | undefined;
  const meta = useQuery({
    queryKey: ['file', fileId],
    enabled: !!fileId,
    staleTime: 60_000,
    queryFn: () => api<{ name: string; contentType: string; url: string }>(`/files/${fileId}`),
  });
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiUpload<{ id: string }>('/files', file);
      onChange(res.id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const accept =
    field.type === 'image' ? 'image/png,image/jpeg,image/gif,image/webp' : field.accept?.join(',');
  return (
    <div>
      <ErrorAlert error={error} onClose={() => setError(null)} />
      {fileId && meta.data && (
        <div className="d-flex align-items-center gap-2 mb-2">
          {meta.data.contentType.startsWith('image/') ? (
            <Image
              src={meta.data.url}
              alt={meta.data.name}
              height={72}
              rounded
              className="border"
            />
          ) : (
            <a href={meta.data.url} target="_blank" rel="noreferrer">
              <i className="bi bi-file-earmark me-1" />
              {meta.data.name}
            </a>
          )}
          <Button size="sm" variant="outline-danger" onClick={() => onChange(null)}>
            {t('records.remove')}
          </Button>
        </div>
      )}
      <div className="d-flex align-items-center gap-2">
        <Form.Control
          id={id}
          type="file"
          size="sm"
          accept={accept}
          disabled={busy}
          onChange={(e) => void upload((e.target as HTMLInputElement).files?.[0])}
        />
        {busy && <Spinner size="sm" />}
      </div>
    </div>
  );
}

/** datetime-local works in local time; values are stored as UTC ISO strings. */
function toLocalInput(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** One input for any configured field type. */
export function FieldInput(props: FieldInputProps) {
  const { field: f, value, onChange, cfg, currency, invalid, id } = props;
  const label = useLabel();
  const { t } = useTranslation();
  const str = value === undefined || value === null ? '' : String(value);
  const text = (type: string, extra: object = {}) => (
    <Form.Control
      id={id}
      type={type}
      value={str}
      isInvalid={invalid}
      onChange={(e) => onChange(e.target.value)}
      {...extra}
    />
  );

  switch (f.type) {
    case 'text':
      return text('text', { maxLength: f.maxLength ?? 500 });
    case 'longtext':
      return text('text', { as: 'textarea', rows: 3, maxLength: f.maxLength ?? 10000 });
    case 'email':
      return text('email', { dir: 'ltr' });
    case 'phone':
      return text('tel', { dir: 'ltr', placeholder: '+91 98765 43210' });
    case 'url':
      return text('url', { dir: 'ltr', placeholder: 'https://' });
    case 'integer':
      return text('text', { inputMode: 'numeric', dir: 'ltr' });
    case 'decimal':
      return text('text', { inputMode: 'decimal', dir: 'ltr' });
    case 'percent':
      return (
        <InputGroup>
          {text('text', { inputMode: 'decimal', dir: 'ltr' })}
          <InputGroup.Text>%</InputGroup.Text>
        </InputGroup>
      );
    case 'currency': {
      const c = (value as Partial<CurrencyValue> | undefined) ?? {};
      const code = f.currency ?? c.currency ?? currency;
      return (
        <InputGroup>
          <InputGroup.Text>{code}</InputGroup.Text>
          <Form.Control
            id={id}
            inputMode="decimal"
            dir="ltr"
            isInvalid={invalid}
            value={c.amount ?? ''}
            onChange={(e) =>
              onChange(e.target.value ? { amount: e.target.value, currency: code } : null)
            }
          />
        </InputGroup>
      );
    }
    case 'date':
      return text('date');
    case 'time':
      return text('time');
    case 'datetime':
      return (
        <Form.Control
          id={id}
          type="datetime-local"
          isInvalid={invalid}
          value={toLocalInput(value as string | undefined)}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)}
        />
      );
    case 'boolean':
      return (
        <Form.Check
          id={id}
          type="switch"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case 'select': {
      const list = cfg.picklists.find((p) => p.key === f.picklist);
      return (
        <Form.Select
          id={id}
          value={str}
          isInvalid={invalid}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">{t('records.choose')}</option>
          {list?.options
            .filter((o) => o.active !== false || o.value === str)
            .map((o) => (
              <option key={o.value} value={o.value}>
                {label(o.label)}
              </option>
            ))}
        </Form.Select>
      );
    }
    case 'multiselect': {
      const list = cfg.picklists.find((p) => p.key === f.picklist);
      const selected = new Set((value as string[] | undefined) ?? []);
      return (
        <div id={id} className={invalid ? 'border border-danger rounded p-1' : ''}>
          {list?.options
            .filter((o) => o.active !== false || selected.has(o.value))
            .map((o) => (
              <Form.Check
                inline
                key={o.value}
                id={`${id}-${o.value}`}
                label={label(o.label)}
                checked={selected.has(o.value)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(o.value);
                  else next.delete(o.value);
                  onChange([...next]);
                }}
              />
            ))}
        </div>
      );
    }
    case 'lookup':
    case 'lookup_many':
      return <LookupInput {...props} />;
    case 'file':
    case 'image':
      return <FileInput {...props} />;
    case 'table':
      return <TableInput {...props} />;
    case 'formula':
    case 'autonumber':
      return (
        <Form.Control
          id={id}
          plaintext
          readOnly
          value={str || t('records.calculated')}
          className="text-body-secondary"
        />
      );
  }
}
