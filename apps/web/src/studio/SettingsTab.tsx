import { useEffect, useState } from 'react';
import { Alert, Button, Card, Form } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { UI_LANGUAGES } from '@erp/contracts';
import type { ConfigSettings } from '@erp/metadata';
import { useAuth } from '../auth/AuthContext';
import { useConfigActions, useEffectiveConfig } from '../config/hooks';
import { ErrorAlert, Field } from '../components/ui';
import { useStudio } from './StudioContext';

export function SettingsTab() {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const { company, scope } = useStudio();
  const cfg = useEffectiveConfig();
  const { putSettings } = useConfigActions();
  const [s, setS] = useState<ConfigSettings>(company.settings ?? {});
  const [saved, setSaved] = useState(false);
  useEffect(() => setS(company.settings ?? {}), [company.settings]);

  if (scope !== 'company') return <Alert variant="info">{t('studio.company')}</Alert>;
  const months = Array.from({ length: 12 }, (_, i) =>
    new Intl.DateTimeFormat(i18n.language, { month: 'long', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2026, i, 1)),
    ),
  );
  const fy = s.fiscalYearStartMonth ?? cfg.data?.settings.fiscalYearStartMonth ?? 1;

  return (
    <Card className="shadow-sm border-0" style={{ maxWidth: 560 }}>
      <Card.Body>
        <ErrorAlert error={putSettings.error} />
        {saved && <Alert variant="success">{t('common.saved')}</Alert>}
        <fieldset disabled={!can('config.manage')}>
          <Field label={t('studio.fiscalYearStart')} controlId="set-fy">
            <Form.Select
              value={fy}
              onChange={(e) => setS({ ...s, fiscalYearStartMonth: Number(e.target.value) })}
            >
              {months.map((m, i) => (
                <option key={i} value={i + 1}>
                  {m}
                </option>
              ))}
            </Form.Select>
          </Field>
          <Field label={t('studio.defaultLanguage')} controlId="set-lang">
            <Form.Select
              value={s.defaultLanguage ?? ''}
              onChange={(e) => setS({ ...s, defaultLanguage: e.target.value || undefined })}
            >
              <option value="" />
              {UI_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </Form.Select>
          </Field>
          <Button
            onClick={() => void putSettings.mutateAsync(s).then(() => setSaved(true))}
            disabled={putSettings.isPending}
          >
            {t('common.save')}
          </Button>
        </fieldset>
      </Card.Body>
    </Card>
  );
}
