import { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Form, Row } from 'react-bootstrap';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { LoginPolicy } from '@erp/contracts';
import { api } from '../api/client';
import type { OrgUnitDto, RoleDto } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ErrorAlert, Loading } from '../components/ui';

const METHODS = ['password', 'otp', 'google', 'microsoft'] as const;

/** Company admins choose how people sign in; the server refuses anything turned off here. */
export function LoginPolicyCard() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const editable = can('tenant.settings.update');
  const policy = useQuery({
    queryKey: ['login-policy'],
    queryFn: () => api<LoginPolicy>('/tenants/current/login-policy'),
  });
  const [draft, setDraft] = useState<LoginPolicy | null>(null);
  const [domains, setDomains] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const autoJoin = !!draft?.autoJoin.enabled;
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => api<RoleDto[]>('/access/roles'),
    enabled: autoJoin,
  });
  const units = useQuery({
    queryKey: ['org-units'],
    queryFn: () => api<OrgUnitDto[]>('/org/units'),
    enabled: autoJoin,
  });

  useEffect(() => {
    if (policy.data) {
      setDraft(policy.data);
      setDomains(policy.data.ssoDomains.join(', '));
    }
  }, [policy.data]);

  if (!draft) return policy.error ? <ErrorAlert error={policy.error} /> : <Loading />;
  const sso = draft.methods.google || draft.methods.microsoft;
  const set = (patch: Partial<LoginPolicy>) => {
    setSaved(false);
    setDraft({ ...draft, ...patch });
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body: LoginPolicy = {
        ...draft,
        ssoDomains: domains
          .split(/[\s,;]+/)
          .map((d) => d.trim().replace(/^@/, ''))
          .filter(Boolean),
      };
      const next = await api<LoginPolicy>('/tenants/current/login-policy', { method: 'PUT', body });
      qc.setQueryData(['login-policy'], next);
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="shadow-sm border-0">
      <Card.Body>
        <h2 className="h6 mb-1">{t('loginPolicy.title')}</h2>
        <p className="small text-body-secondary">{t('loginPolicy.help')}</p>
        {saved && <Alert variant="success">{t('common.saved')}</Alert>}
        <ErrorAlert error={error} />
        <Form onSubmit={save} noValidate>
          <fieldset disabled={!editable || busy}>
            {METHODS.map((m) => (
              <Form.Check
                key={m}
                type="switch"
                id={`method-${m}`}
                label={t(`loginPolicy.methods.${m}`)}
                checked={draft.methods[m]}
                onChange={(e) => set({ methods: { ...draft.methods, [m]: e.target.checked } })}
              />
            ))}
            {draft.methods.otp && (
              <Form.Text className="d-block mb-2">{t('loginPolicy.otpHelp')}</Form.Text>
            )}

            {sso && (
              <div className="border-top mt-3 pt-3">
                <Form.Group className="mb-3" controlId="ssoDomains">
                  <Form.Label>{t('loginPolicy.domains')}</Form.Label>
                  <Form.Control
                    dir="ltr"
                    value={domains}
                    onChange={(e) => {
                      setSaved(false);
                      setDomains(e.target.value);
                    }}
                    placeholder="acme.in, acme.com"
                  />
                  <Form.Text muted>{t('loginPolicy.domainsHelp')}</Form.Text>
                </Form.Group>
                {draft.methods.microsoft && (
                  <Form.Check
                    type="switch"
                    id="allowPersonalMicrosoft"
                    label={t('loginPolicy.personalMicrosoft')}
                    checked={draft.allowPersonalMicrosoft}
                    onChange={(e) => set({ allowPersonalMicrosoft: e.target.checked })}
                  />
                )}
                <Form.Check
                  type="switch"
                  id="autoJoin"
                  label={t('loginPolicy.autoJoin')}
                  checked={draft.autoJoin.enabled}
                  onChange={(e) =>
                    set({ autoJoin: { ...draft.autoJoin, enabled: e.target.checked } })
                  }
                />
                <Form.Text muted className="d-block">
                  {t('loginPolicy.autoJoinHelp')}
                </Form.Text>
                {autoJoin && (
                  <Row className="mt-2">
                    <Col md={6}>
                      <Form.Group controlId="autoJoinRole">
                        <Form.Label>{t('loginPolicy.role')}</Form.Label>
                        <Form.Select
                          value={draft.autoJoin.roleId ?? ''}
                          onChange={(e) =>
                            set({
                              autoJoin: { ...draft.autoJoin, roleId: e.target.value || undefined },
                            })
                          }
                        >
                          <option value="">{t('loginPolicy.choose')}</option>
                          {roles.data?.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </Form.Select>
                      </Form.Group>
                    </Col>
                    <Col md={6}>
                      <Form.Group controlId="autoJoinUnit">
                        <Form.Label>{t('loginPolicy.orgUnit')}</Form.Label>
                        <Form.Select
                          value={draft.autoJoin.orgUnitId ?? ''}
                          onChange={(e) =>
                            set({
                              autoJoin: {
                                ...draft.autoJoin,
                                orgUnitId: e.target.value || undefined,
                              },
                            })
                          }
                        >
                          <option value="">{t('loginPolicy.choose')}</option>
                          {units.data?.map((u) => (
                            <option key={u.id} value={u.id}>
                              {'— '.repeat(u.depth)}
                              {u.name}
                            </option>
                          ))}
                        </Form.Select>
                      </Form.Group>
                    </Col>
                  </Row>
                )}
              </div>
            )}
            {editable && (
              <div className="mt-3">
                <Button type="submit">{t('common.save')}</Button>
              </div>
            )}
          </fieldset>
        </Form>
      </Card.Body>
    </Card>
  );
}
