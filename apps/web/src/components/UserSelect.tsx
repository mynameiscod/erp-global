import { Form } from 'react-bootstrap';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import type { Page, UserDto } from '../api/types';

/** Picks an active user of the company (manager, unit head, delegate). */
export function UserSelect({
  id,
  value,
  onChange,
  exclude,
}: {
  id: string;
  value: string | null | undefined;
  onChange: (userId: string | null) => void;
  exclude?: string;
}) {
  const { t } = useTranslation();
  const users = useQuery({
    queryKey: ['users', 'active'],
    queryFn: () =>
      api<Page<UserDto>>('/identity/users', { query: { status: 'active', pageSize: 200 } }),
    staleTime: 60_000,
  });
  return (
    <Form.Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{t('common.none')}</option>
      {users.data?.items
        .filter((u) => u.id !== exclude)
        .map((u) => (
          <option key={u.id} value={u.id}>
            {u.name} · {u.email}
          </option>
        ))}
    </Form.Select>
  );
}
