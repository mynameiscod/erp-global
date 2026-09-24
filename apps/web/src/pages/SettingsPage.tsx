import { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Form, Row } from 'react-bootstrap';
import { useForm } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { INDUSTRIES, UI_LANGUAGES, type CountryDto } from '@erp/contracts';
import { api } from '../api/client';
import type { TenantDto } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useCurrentTenant } from '../components/AppLayout';
import { applyFieldErrors, ErrorAlert, Field, Loading, PageHeader } from '../components/ui';

interface SettingsForm {
  name: string;
  defaultLanguage: string;
  timezone: string;
  requireMfa: boolean;
}

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const tenant = useCurrentTenant();
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const editable = can('tenant.settings.update');

  const country = useQuery({
    queryKey: ['country', tenant.data?.countryCode, i18n.language],
    queryFn: () =>
      api<CountryDto>(`/reference/countries/${tenant.data!.countryCode}`, {
        auth: false,
        query: { lang: i18n.language },
      }),
    enabled: !!tenant.data,
  });

  const form = useForm<SettingsForm>();
  useEffect(() => {
    if (tenant.data) {
      form.reset({
        name: tenant.data.name,
        defaultLanguage: tenant.data.defaultLanguage,
        timezone: tenant.data.timezone,
        requireMfa: tenant.data.settings.requireMfa,
      });
    }
  }, [tenant.data, form]);

  if (tenant.isLoading || !tenant.data) return <Loading />;
  const d = tenant.data;

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    setSaved(false);
    try {
      const updated = await api<TenantDto>('/tenants/current/settings', {
        method: 'PATCH',
        body: v,
      });
      qc.setQueryData(['tenant', 'current'], updated);
      setSaved(true);
    } catch (e) {
      if (!applyFieldErrors(e, form.setError as never)) setError(e);
    }
  });

  return (
    <>
      <PageHeader title={t('settings.title')} />
      <Row className="g-3">
        <Col lg={7}>
          <Card className="shadow-sm border-0">
            <Card.Body>
              <h2 className="h6 mb-3">{t('settings.profile')}</h2>
              {saved && <Alert variant="success">{t('common.saved')}</Alert>}
              <ErrorAlert error={error} />
              <Form onSubmit={submit} noValidate>
                <fieldset disabled={!editable}>
                  <Field
                    label={t('signup.companyName')}
                    controlId="name"
                    error={form.formState.errors.name?.message}
                  >
                    <Form.Control {...form.register('name', { required: true })} />
                  </Field>
                  <Row>
                    <Col md={6}>
                      <Field label={t('signup.defaultLanguage')} controlId="defaultLanguage">
                        <Form.Select {...form.register('defaultLanguage')}>
                          {UI_LANGUAGES.map((l) => (
                            <option key={l.code} value={l.code}>
                              {l.name}
                            </option>
                          ))}
                        </Form.Select>
                      </Field>
                    </Col>
                    <Col md={6}>
                      <Field label={t('common.timezone')} controlId="timezone">
                        <Form.Select {...form.register('timezone')}>
                          {[...new Set([d.timezone, ...(country.data?.timezones ?? [])])].map(
                            (tz) => (
                              <option key={tz}>{tz}</option>
                            ),
                          )}
                        </Form.Select>
                      </Field>
                    </Col>
                  </Row>
                  <Form.Check
                    type="switch"
                    id="requireMfa"
                    label={t('settings.requireMfa')}
                    {...form.register('requireMfa')}
                  />
                  <Form.Text muted>{t('settings.requireMfaHelp')}</Form.Text>
                  {editable && (
                    <div className="mt-3">
                      <Button type="submit" disabled={form.formState.isSubmitting}>
                        {t('common.save')}
                      </Button>
                    </div>
                  )}
                </fieldset>
              </Form>
            </Card.Body>
          </Card>
        </Col>
        <Col lg={5}>
          <Card className="shadow-sm border-0">
            <Card.Body>
              <h2 className="h6 mb-3">{t('settings.region')}</h2>
              <dl className="row mb-0">
                <dt className="col-5">{t('common.country')}</dt>
                <dd className="col-7">{country.data?.name ?? d.countryCode}</dd>
                <dt className="col-5">{t('common.industry')}</dt>
                <dd className="col-7">
                  {INDUSTRIES.find((x) => x.code === d.industryCode)?.name ?? d.industryCode}
                </dd>
                <dt className="col-5">{t('settings.currency')}</dt>
                <dd className="col-7">{d.currency}</dd>
                <dt className="col-5">{t('settings.locale')}</dt>
                <dd className="col-7">{d.locale}</dd>
                <dt className="col-5">{t('tenants.slug')}</dt>
                <dd className="col-7 font-monospace">{d.slug}</dd>
                <dt className="col-5">{t('settings.placement')}</dt>
                <dd className="col-7 mb-0">{t(`settings.${d.placement}`)}</dd>
              </dl>
            </Card.Body>
          </Card>
        </Col>
      </Row>
    </>
  );
}
