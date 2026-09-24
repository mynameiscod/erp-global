import { useEffect, useMemo, useState } from 'react';
import { Button, Col, Form, Row } from 'react-bootstrap';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { INDUSTRIES, signupSchema, UI_LANGUAGES, type CountryDto } from '@erp/contracts';
import { api } from '../../api/client';
import { rememberCompany } from '../../auth/AuthContext';
import { AuthLayout } from '../../components/AuthLayout';
import { applyFieldErrors, ErrorAlert, Field } from '../../components/ui';

type SignupForm = z.input<typeof signupSchema>;

const toSlug = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

function browserCountry(): string {
  const region = navigator.language?.split('-')[1];
  return region && /^[A-Z]{2}$/.test(region) ? region : 'IN';
}

export function SignupPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const [slugTouched, setSlugTouched] = useState(false);

  const countries = useQuery({
    queryKey: ['countries', i18n.language],
    queryFn: () =>
      api<CountryDto[]>('/reference/countries', { auth: false, query: { lang: i18n.language } }),
    staleTime: Infinity,
  });

  const form = useForm<SignupForm>({
    resolver: zodResolver(signupSchema),
    defaultValues: {
      companyName: '',
      slug: '',
      countryCode: browserCountry(),
      industryCode: 'services',
      defaultLanguage: i18n.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      admin: { name: '', email: '', password: '' },
    },
  });
  const { register, watch, setValue, formState } = form;
  const errors = formState.errors;
  const companyName = watch('companyName');
  const slug = watch('slug');
  const countryCode = watch('countryCode');
  const country = useMemo(
    () => countries.data?.find((c) => c.code === countryCode),
    [countries.data, countryCode],
  );

  // Suggest a URL name from the company name until the user edits it.
  useEffect(() => {
    if (!slugTouched) setValue('slug', toSlug(companyName ?? ''));
  }, [companyName, slugTouched, setValue]);

  // Default the time zone to the chosen country's first zone.
  useEffect(() => {
    if (country?.timezones.length && !country.timezones.includes(form.getValues('timezone'))) {
      setValue('timezone', country.timezones[0]);
    }
  }, [country, form, setValue]);

  const [debouncedSlug, setDebouncedSlug] = useState(slug);
  useEffect(() => {
    const h = setTimeout(() => setDebouncedSlug(slug), 400);
    return () => clearTimeout(h);
  }, [slug]);
  const availability = useQuery({
    queryKey: ['slug', debouncedSlug],
    queryFn: () =>
      api<{ available: boolean; reason?: string }>(
        `/tenants/slug-available/${encodeURIComponent(debouncedSlug)}`,
        { auth: false },
      ),
    enabled: (debouncedSlug?.length ?? 0) >= 3,
  });

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const res = await api<{ slug: string }>('/tenants/signup', {
        method: 'POST',
        auth: false,
        body: v,
      });
      rememberCompany(res.slug);
      navigate(`/login?company=${encodeURIComponent(res.slug)}&notice=signup.done`);
    } catch (e) {
      if (!applyFieldErrors(e, form.setError as never)) setError(e);
    }
  });

  return (
    <AuthLayout title={t('signup.title')} subtitle={t('signup.subtitle')} wide>
      <ErrorAlert error={error} />
      <Form onSubmit={onSubmit} noValidate>
        <Row>
          <Col md={6}>
            <Field
              label={t('signup.companyName')}
              controlId="companyName"
              error={errors.companyName?.message}
            >
              <Form.Control {...register('companyName')} autoComplete="organization" />
            </Field>
          </Col>
          <Col md={6}>
            <Field
              label={t('signup.slug')}
              controlId="slug"
              error={errors.slug?.message}
              hint={
                availability.data ? (
                  availability.data.available ? (
                    <span className="text-success">
                      <i className="bi bi-check-circle me-1" />
                      {t('signup.slugAvailable')}
                    </span>
                  ) : (
                    <span className="text-danger">
                      {availability.data.reason ?? t('signup.slugTaken')}
                    </span>
                  )
                ) : (
                  t('signup.slugHint')
                )
              }
            >
              <Form.Control
                {...register('slug', { onChange: () => setSlugTouched(true) })}
                autoCapitalize="none"
                dir="ltr"
              />
            </Field>
          </Col>
          <Col md={6}>
            <Field
              label={t('common.country')}
              controlId="countryCode"
              error={errors.countryCode?.message}
            >
              <Form.Select {...register('countryCode')} disabled={countries.isLoading}>
                {countries.data?.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </Form.Select>
            </Field>
          </Col>
          <Col md={6}>
            <Field
              label={t('common.industry')}
              controlId="industryCode"
              error={errors.industryCode?.message}
            >
              <Form.Select {...register('industryCode')}>
                {INDUSTRIES.map((i) => (
                  <option key={i.code} value={i.code}>
                    {i.name}
                  </option>
                ))}
              </Form.Select>
            </Field>
          </Col>
          <Col md={6}>
            <Field
              label={t('signup.defaultLanguage')}
              controlId="defaultLanguage"
              error={errors.defaultLanguage?.message}
            >
              <Form.Select {...register('defaultLanguage')}>
                {UI_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </Form.Select>
            </Field>
          </Col>
          <Col md={6}>
            <Field
              label={t('common.timezone')}
              controlId="timezone"
              error={errors.timezone?.message}
            >
              <Form.Select {...register('timezone')}>
                {[...new Set([...(country?.timezones ?? []), form.getValues('timezone')])].map(
                  (tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ),
                )}
              </Form.Select>
            </Field>
          </Col>
        </Row>

        <h2 className="h6 mt-2 mb-3 text-body-secondary text-uppercase">
          {t('signup.adminSection')}
        </h2>
        <Row>
          <Col md={6}>
            <Field
              label={t('signup.adminName')}
              controlId="adminName"
              error={errors.admin?.name?.message}
            >
              <Form.Control {...register('admin.name')} autoComplete="name" />
            </Field>
          </Col>
          <Col md={6}>
            <Field
              label={t('common.email')}
              controlId="adminEmail"
              error={errors.admin?.email?.message}
            >
              <Form.Control
                type="email"
                {...register('admin.email')}
                autoComplete="email"
                dir="ltr"
              />
            </Field>
          </Col>
          <Col md={6}>
            <Field
              label={t('auth.password')}
              controlId="adminPassword"
              error={errors.admin?.password?.message}
              hint={t('auth.passwordHint')}
            >
              <Form.Control
                type="password"
                {...register('admin.password')}
                autoComplete="new-password"
              />
            </Field>
          </Col>
        </Row>
        <Button type="submit" size="lg" className="w-100" disabled={formState.isSubmitting}>
          {formState.isSubmitting ? t('signup.creating') : t('signup.submit')}
        </Button>
      </Form>
      <p className="text-center small mt-3 mb-0">
        <Link to="/login">{t('auth.backToLogin')}</Link>
      </p>
    </AuthLayout>
  );
}
