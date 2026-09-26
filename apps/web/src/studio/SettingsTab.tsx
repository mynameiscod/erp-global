import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Collapse, Form, Row, Table } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { UI_LANGUAGES } from '@erp/contracts';
import type { ConfigSettings, LocalizedText, WorkCalendar } from '@erp/metadata';
import { useAuth } from '../auth/AuthContext';
import { useConfigActions, useEffectiveConfig, useLabel } from '../config/hooks';
import { LocalizedInput } from '../config/LocalizedInput';
import { ErrorAlert, Field } from '../components/ui';
import { PACK_BADGE, useInherited, useStep6Actions } from './packBase';
import { useStudio } from './StudioContext';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const hasText = (l: LocalizedText) => Object.values(l).some((v) => v.trim());

/**
 * The working week, hours and holidays (for timers that count working hours only). A Country
 * Pack usually brings them; the company's values replace the week and hours and add holidays.
 */
function CalendarCard() {
  const { t, i18n } = useTranslation();
  const label = useLabel();
  const { can } = useAuth();
  const { company } = useStudio();
  const { packs } = useInherited();
  const { putCalendar } = useStep6Actions();
  const editable = can('config.manage');
  const [own, setOwn] = useState<WorkCalendar>(company.calendar ?? {});
  const [saved, setSaved] = useState(false);
  const [showPack, setShowPack] = useState(false);
  useEffect(() => setOwn(company.calendar ?? {}), [company.calendar]);
  const pack = packs.calendar;
  const change = (patch: Partial<WorkCalendar>) => {
    setSaved(false);
    setOwn((o) => ({ ...o, ...patch }));
  };

  const days = Array.from({ length: 7 }, (_, d) =>
    // 2026-01-04 is a Sunday.
    new Intl.DateTimeFormat(i18n.language, { weekday: 'short', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2026, 0, 4 + d)),
    ),
  );
  const weekend = own.weekend ?? pack?.weekend ?? [];
  const hours = own.hours ?? pack?.hours;
  const holidays = own.holidays ?? [];
  const ownDates = new Set(holidays.map((h) => h.date));
  const packHolidays = (pack?.holidays ?? []).filter((h) => !ownDates.has(h.date));
  const valid =
    (!own.hours || (HHMM.test(own.hours.start) && HHMM.test(own.hours.end))) &&
    holidays.every(
      (h, i) =>
        /^\d{4}-\d{2}-\d{2}$/.test(h.date) &&
        hasText(h.label) &&
        holidays.findIndex((x) => x.date === h.date) === i,
    ) &&
    weekend.length < 7;

  const save = async () => {
    const clean: WorkCalendar = {};
    if (own.weekend) clean.weekend = [...own.weekend].sort();
    if (own.hours) clean.hours = own.hours;
    if (holidays.length)
      clean.holidays = [...holidays].sort((a, b) => a.date.localeCompare(b.date));
    if (own.workingHoursOnly !== undefined) clean.workingHoursOnly = own.workingHoursOnly;
    await putCalendar.mutateAsync(clean);
    setSaved(true);
  };

  /** "From pack" while the company has not set its own value; "Revert" once it has. */
  const origin = (k: 'weekend' | 'hours') =>
    own[k] === undefined ? (
      pack?.[k] !== undefined && (
        <Badge {...PACK_BADGE} className="ms-2">
          {t('studio.taxes.fromPack')}
        </Badge>
      )
    ) : (
      <Button size="sm" variant="link" className="py-0" onClick={() => change({ [k]: undefined })}>
        {t('studio.taxes.revert')}
      </Button>
    );

  return (
    <Card className="shadow-sm border-0 mt-3" style={{ maxWidth: 860 }}>
      <Card.Body>
        <h2 className="h5">{t('studio.calendar.title')}</h2>
        <p className="small text-body-secondary">{t('studio.calendar.intro')}</p>
        <ErrorAlert error={putCalendar.error} />
        {saved && <Alert variant="success">{t('common.saved')}</Alert>}
        <fieldset disabled={!editable}>
          <Form.Label className="d-block">
            {t('studio.calendar.weekend')}
            {origin('weekend')}
          </Form.Label>
          <div className="d-flex flex-wrap gap-3 mb-3">
            {days.map((name, d) => (
              <Form.Check
                key={d}
                id={`cal-we-${d}`}
                type="checkbox"
                label={name}
                checked={weekend.includes(d)}
                onChange={(e) =>
                  change({
                    weekend: e.target.checked ? [...weekend, d] : weekend.filter((x) => x !== d),
                  })
                }
              />
            ))}
          </div>
          <Form.Label className="d-block">
            {t('studio.calendar.hours')}
            {origin('hours')}
          </Form.Label>
          <Row className="g-2 mb-3" style={{ maxWidth: 360 }}>
            <Col>
              <Form.Control
                type="time"
                aria-label={t('studio.calendar.start')}
                value={hours?.start ?? ''}
                onChange={(e) =>
                  change({ hours: { start: e.target.value, end: hours?.end ?? '18:00' } })
                }
              />
            </Col>
            <Col xs="auto" className="d-flex align-items-center">
              –
            </Col>
            <Col>
              <Form.Control
                type="time"
                aria-label={t('studio.calendar.end')}
                value={hours?.end ?? ''}
                onChange={(e) =>
                  change({ hours: { start: hours?.start ?? '09:00', end: e.target.value } })
                }
              />
            </Col>
          </Row>
          <Form.Check
            type="switch"
            id="cal-working-only"
            label={t('studio.calendar.workingHoursOnly')}
            checked={own.workingHoursOnly ?? pack?.workingHoursOnly ?? false}
            onChange={(e) => change({ workingHoursOnly: e.target.checked })}
          />
          <Form.Text muted className="d-block mb-3">
            {t('studio.calendar.workingHoursOnlyHelp')}
          </Form.Text>

          <h3 className="h6">{t('studio.calendar.holidays')}</h3>
          <Table size="sm" className="align-middle">
            <thead>
              <tr className="small text-body-secondary">
                <th style={{ width: 180 }}>{t('studio.calendar.date')}</th>
                <th>{t('common.name')}</th>
                <th style={{ width: 50 }} />
              </tr>
            </thead>
            <tbody>
              {holidays.map((h, i) => (
                <tr key={i}>
                  <td>
                    <Form.Control
                      size="sm"
                      type="date"
                      value={h.date}
                      isInvalid={!!h.date && holidays.findIndex((x) => x.date === h.date) !== i}
                      onChange={(e) =>
                        change({
                          holidays: holidays.map((x, n) =>
                            n === i ? { ...x, date: e.target.value } : x,
                          ),
                        })
                      }
                    />
                  </td>
                  <td>
                    <LocalizedInput
                      id={`cal-h-${i}`}
                      value={h.label}
                      onChange={(v) =>
                        change({
                          holidays: holidays.map((x, n) => (n === i ? { ...x, label: v } : x)),
                        })
                      }
                    />
                  </td>
                  <td>
                    <Button
                      size="sm"
                      variant="outline-danger"
                      aria-label={t('common.delete')}
                      onClick={() => change({ holidays: holidays.filter((_, n) => n !== i) })}
                    >
                      <i className="bi bi-x" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Button
            size="sm"
            variant="outline-primary"
            className="mb-3"
            onClick={() => change({ holidays: [...holidays, { date: '', label: {} }] })}
          >
            <i className="bi bi-plus me-1" />
            {t('studio.calendar.addHoliday')}
          </Button>
          {packHolidays.length > 0 && (
            <div className="mb-3">
              <Button
                size="sm"
                variant="link"
                className="px-0 d-block"
                onClick={() => setShowPack((v) => !v)}
                aria-expanded={showPack}
              >
                <i className={`bi bi-chevron-${showPack ? 'down' : 'right'} me-1 flip-rtl`} />
                {t('studio.calendar.packHolidays', { count: packHolidays.length })}
              </Button>
              <Collapse in={showPack}>
                <div>
                  <Table size="sm" className="small mb-1">
                    <tbody>
                      {packHolidays.map((h) => (
                        <tr key={h.date}>
                          <td style={{ width: 180 }} className="font-monospace" dir="ltr">
                            {h.date}
                          </td>
                          <td>{label(h.label)}</td>
                          <td className="text-end">
                            <Badge {...PACK_BADGE}>{t('studio.taxes.fromPack')}</Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  <Form.Text muted>{t('studio.calendar.packHolidaysHelp')}</Form.Text>
                </div>
              </Collapse>
            </div>
          )}
          <div>
            <Button disabled={!valid || putCalendar.isPending} onClick={() => void save()}>
              {t('common.save')}
            </Button>
          </div>
        </fieldset>
      </Card.Body>
    </Card>
  );
}

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
    <>
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
      <CalendarCard />
    </>
  );
}
