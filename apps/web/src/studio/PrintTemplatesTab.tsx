import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  ButtonGroup,
  Card,
  Col,
  Dropdown,
  Form,
  InputGroup,
  Row,
  Table,
} from 'react-bootstrap';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Page } from '@erp/contracts';
import {
  KEY_RE,
  mergeLayers,
  PAGE_SIZES,
  platformBaseLayer,
  SYSTEM_COLUMNS,
  VALUE_FORMATS,
  type Align,
  type EntityDef,
  type LocalizedText,
  type PrintBlock,
  type PrintBlockType,
  type PrintTemplateDef,
} from '@erp/metadata';
import { api, apiBlob, apiUpload } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useConfigActions, useLabel } from '../config/hooks';
import { LocalizedInput } from '../config/LocalizedInput';
import { ErrorAlert, Field } from '../components/ui';
import type { RecordDto } from '../records/RecordsListPage';
import { useStudio } from './StudioContext';

/** Languages a template can print in (labels are typed per language). */
const PRINT_LANGUAGES = ['en', 'hi', 'te', 'ta', 'kn', 'ml', 'mr', 'bn', 'gu', 'pa', 'ar', 'ur'];
const BLOCK_TYPES: PrintBlockType[] = [
  'letterhead',
  'title',
  'fields',
  'table',
  'totals',
  'text',
  'qr',
  'barcode',
  'signature',
  'image',
  'divider',
  'spacer',
  'page_break',
];

function languageName(code: string, ui: string): string {
  try {
    return new Intl.DisplayNames([ui], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

function newBlock(type: PrintBlockType): PrintBlock {
  const id = `${type}_${Date.now().toString(36)}`;
  switch (type) {
    case 'letterhead':
      return { id, type, lines: [{ en: '{{company.name}}' }, { en: '{{unit.name}}' }] };
    case 'title':
      return { id, type, text: { en: 'Title' }, align: 'center' };
    case 'fields':
      return { id, type, columns: 2, items: [{ path: 'number' }] };
    case 'table':
      return { id, type, source: '', columns: [], numbered: true };
    case 'totals':
      return { id, type, rows: [] };
    case 'text':
      return { id, type, text: { en: '' } };
    case 'qr':
      return { id, type, value: '{{number}}', size: 25 };
    case 'barcode':
      return { id, type, value: '{{number}}' };
    case 'signature':
      return { id, type, name: { en: 'Authorised signatory' }, align: 'right' };
    case 'image':
      return { id, type, file: '', width: 40 };
    case 'divider':
      return { id, type };
    case 'spacer':
      return { id, type, height: 5 };
    case 'page_break':
      return { id, type };
  }
}

/** Fields a template can place: the entity's own, system columns, and fields of linked records. */
function useFieldPaths(entity: EntityDef | undefined, entities: EntityDef[]) {
  const label = useLabel();
  const { t } = useTranslation();
  return useMemo(() => {
    if (!entity) return [];
    const out: { path: string; label: string }[] = SYSTEM_COLUMNS.filter(
      (s) => !['updatedBy', 'updatedAt'].includes(s),
    ).map((s) => ({
      path: s,
      label: t(`reports.system.${s}`),
    }));
    for (const f of entity.fields) {
      if (f.archived || f.type === 'table') continue;
      out.push({ path: f.key, label: label(f.label) });
      if (f.type === 'lookup' && f.target) {
        const target = entities.find((e) => e.key === f.target);
        for (const g of target?.fields ?? []) {
          if (g.archived || g.type === 'table') continue;
          out.push({ path: `${f.key}.${g.key}`, label: `${label(f.label)} › ${label(g.label)}` });
        }
        if (f.target === 'user' || f.target === 'org_unit')
          out.push({ path: `${f.key}.name`, label: `${label(f.label)} › ${t('common.name')}` });
      }
    }
    return out;
  }, [entity, entities, label, t]);
}

function AlignSelect({
  value,
  onChange,
}: {
  value: Align | undefined;
  onChange: (a: Align | undefined) => void;
}) {
  const { t } = useTranslation();
  return (
    <ButtonGroup size="sm">
      {(['left', 'center', 'right'] as Align[]).map((a) => (
        <Button
          key={a}
          variant={value === a ? 'secondary' : 'outline-secondary'}
          onClick={() => onChange(value === a ? undefined : a)}
          aria-label={t(`print.align.${a}`)}
        >
          <i className={`bi bi-text-${a === 'center' ? 'center' : a}`} />
        </Button>
      ))}
    </ButtonGroup>
  );
}

function FileButton({
  value,
  onChange,
  accept = 'image/png,image/jpeg,image/webp',
}: {
  value?: string;
  onChange: (id: string | undefined) => void;
  accept?: string;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<unknown>(null);
  return (
    <div>
      <ErrorAlert error={error} onClose={() => setError(null)} />
      <div className="d-flex align-items-center gap-2">
        <Form.Control
          type="file"
          size="sm"
          accept={accept}
          onChange={(e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (f) apiUpload<{ id: string }>('/files', f).then((r) => onChange(r.id), setError);
          }}
        />
        {value && (
          <Button size="sm" variant="outline-danger" onClick={() => onChange(undefined)}>
            {t('records.remove')}
          </Button>
        )}
      </div>
      {value && (
        <div className="small text-success mt-1">
          <i className="bi bi-check" /> {t('print.imageSet')}
        </div>
      )}
    </div>
  );
}

function BlockEditor({
  block,
  onChange,
  entity,
  entities,
  languages,
}: {
  block: PrintBlock;
  onChange: (b: PrintBlock) => void;
  entity: EntityDef;
  entities: EntityDef[];
  languages: string[];
}) {
  const { t } = useTranslation();
  const label = useLabel();
  const paths = useFieldPaths(entity, entities);
  const b = block;
  const set = (patch: Partial<PrintBlock>) => onChange({ ...b, ...patch } as PrintBlock);
  const text = (
    id: string,
    value: LocalizedText | undefined,
    onText: (v: LocalizedText) => void,
    multiline = false,
  ) => (
    <LocalizedInput
      id={id}
      value={value}
      onChange={onText}
      extra={languages}
      multiline={multiline}
    />
  );
  // Where table rows can come from: table fields, or records of another entity that point here.
  const sources = [
    ...entity.fields
      .filter((f) => f.type === 'table')
      .map((f) => ({ value: f.key, label: label(f.label), columns: f.columns ?? [] })),
    ...entities.flatMap((e) =>
      e.fields
        .filter((f) => f.type === 'lookup' && f.target === entity.key)
        .map((f) => ({
          value: `related:${e.key}.${f.key}`,
          label: `${label(e.pluralLabel)} (${label(f.label)})`,
          columns: e.fields,
        })),
    ),
  ];
  let body: React.ReactNode = null;
  switch (b.type) {
    case 'letterhead':
      body = (
        <>
          <Row className="g-2 mb-2">
            <Col md={8}>
              <Form.Label className="small mb-1">{t('print.logo')}</Form.Label>
              <FileButton value={b.logo} onChange={(logo) => set({ logo })} />
            </Col>
            <Col md={4}>
              <Form.Label className="small mb-1 d-block">{t('print.logoPosition')}</Form.Label>
              <AlignSelect
                value={b.logoPosition}
                onChange={(logoPosition) => set({ logoPosition })}
              />
            </Col>
          </Row>
          {b.lines.map((l, i) => (
            <InputGroup key={i} className="mb-1 align-items-start">
              <div className="flex-grow-1">
                {text(`${b.id}-l${i}`, l, (v) =>
                  set({ lines: b.lines.map((x, j) => (j === i ? v : x)) }),
                )}
              </div>
              <Button
                size="sm"
                variant="outline-danger"
                onClick={() => set({ lines: b.lines.filter((_, j) => j !== i) })}
                aria-label={t('common.delete')}
              >
                <i className="bi bi-x" />
              </Button>
            </InputGroup>
          ))}
          <Button size="sm" variant="link" onClick={() => set({ lines: [...b.lines, { en: '' }] })}>
            <i className="bi bi-plus" /> {t('print.addLine')}
          </Button>
        </>
      );
      break;
    case 'title':
    case 'text':
      body = (
        <>
          {text(`${b.id}-t`, b.text, (v) => set({ text: v }), b.type === 'text')}
          <div className="d-flex align-items-center gap-2 mt-2">
            <AlignSelect value={b.align} onChange={(align) => set({ align })} />
            <InputGroup size="sm" style={{ maxWidth: 140 }}>
              <InputGroup.Text>pt</InputGroup.Text>
              <Form.Control
                type="number"
                min={6}
                max={40}
                value={b.size ?? ''}
                onChange={(e) => set({ size: e.target.value ? Number(e.target.value) : undefined })}
              />
            </InputGroup>
            {b.type === 'text' && (
              <Form.Check
                type="switch"
                id={`${b.id}-bold`}
                label={t('print.bold')}
                checked={!!b.bold}
                onChange={(e) => set({ bold: e.target.checked || undefined })}
              />
            )}
          </div>
        </>
      );
      break;
    case 'fields':
      body = (
        <>
          <Form.Select
            size="sm"
            className="mb-2"
            style={{ maxWidth: 160 }}
            value={b.columns}
            onChange={(e) => set({ columns: Number(e.target.value) as 1 | 2 | 3 })}
          >
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {t('print.columns', { count: n })}
              </option>
            ))}
          </Form.Select>
          {b.items.map((it, i) => (
            <InputGroup size="sm" className="mb-1" key={i}>
              <Form.Select
                value={it.path}
                onChange={(e) =>
                  set({
                    items: b.items.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)),
                  })
                }
              >
                {paths.map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.label}
                  </option>
                ))}
              </Form.Select>
              <Form.Select
                style={{ maxWidth: 130 }}
                value={it.format ?? 'auto'}
                onChange={(e) =>
                  set({
                    items: b.items.map((x, j) =>
                      j === i
                        ? {
                            ...x,
                            format:
                              e.target.value === 'auto'
                                ? undefined
                                : (e.target.value as typeof it.format),
                          }
                        : x,
                    ),
                  })
                }
              >
                {VALUE_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {t(`print.format.${f}`)}
                  </option>
                ))}
              </Form.Select>
              <Button
                variant="outline-danger"
                onClick={() => set({ items: b.items.filter((_, j) => j !== i) })}
                aria-label={t('common.delete')}
              >
                <i className="bi bi-x" />
              </Button>
            </InputGroup>
          ))}
          <Button
            size="sm"
            variant="link"
            onClick={() => set({ items: [...b.items, { path: paths[0]?.path ?? 'number' }] })}
          >
            <i className="bi bi-plus" /> {t('print.addField')}
          </Button>
        </>
      );
      break;
    case 'table': {
      const src = sources.find((s) => s.value === b.source);
      body = (
        <>
          <Form.Select
            size="sm"
            className="mb-2"
            value={b.source}
            onChange={(e) => set({ source: e.target.value, columns: [], totals: undefined })}
          >
            <option value="">{t('print.chooseSource')}</option>
            {sources.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Form.Select>
          {src && (
            <>
              {b.columns.map((c, i) => (
                <InputGroup size="sm" className="mb-1" key={i}>
                  <Form.Select
                    value={c.path}
                    onChange={(e) =>
                      set({
                        columns: b.columns.map((x, j) =>
                          j === i ? { ...x, path: e.target.value } : x,
                        ),
                      })
                    }
                  >
                    {src.columns.map((f) => (
                      <option key={f.key} value={f.key}>
                        {label(f.label)}
                      </option>
                    ))}
                  </Form.Select>
                  <Form.Select
                    style={{ maxWidth: 120 }}
                    value={c.format ?? 'auto'}
                    onChange={(e) =>
                      set({
                        columns: b.columns.map((x, j) =>
                          j === i
                            ? {
                                ...x,
                                format:
                                  e.target.value === 'auto'
                                    ? undefined
                                    : (e.target.value as typeof c.format),
                              }
                            : x,
                        ),
                      })
                    }
                  >
                    {VALUE_FORMATS.filter((f) => f !== 'words').map((f) => (
                      <option key={f} value={f}>
                        {t(`print.format.${f}`)}
                      </option>
                    ))}
                  </Form.Select>
                  <Form.Control
                    style={{ maxWidth: 70 }}
                    type="number"
                    placeholder="%"
                    value={c.width ?? ''}
                    onChange={(e) =>
                      set({
                        columns: b.columns.map((x, j) =>
                          j === i
                            ? { ...x, width: e.target.value ? Number(e.target.value) : undefined }
                            : x,
                        ),
                      })
                    }
                  />
                  <InputGroup.Text>
                    <Form.Check
                      id={`${b.id}-tot-${i}`}
                      label={t('print.total')}
                      checked={b.totals?.includes(c.path) ?? false}
                      onChange={(e) =>
                        set({
                          totals: e.target.checked
                            ? [...(b.totals ?? []), c.path]
                            : (b.totals ?? []).filter((x) => x !== c.path),
                        })
                      }
                    />
                  </InputGroup.Text>
                  <Button
                    variant="outline-danger"
                    onClick={() => set({ columns: b.columns.filter((_, j) => j !== i) })}
                    aria-label={t('common.delete')}
                  >
                    <i className="bi bi-x" />
                  </Button>
                </InputGroup>
              ))}
              <div className="d-flex align-items-center gap-3">
                <Button
                  size="sm"
                  variant="link"
                  onClick={() =>
                    set({ columns: [...b.columns, { path: src.columns[0]?.key ?? '' }] })
                  }
                >
                  <i className="bi bi-plus" /> {t('print.addColumn')}
                </Button>
                <Form.Check
                  type="switch"
                  id={`${b.id}-num`}
                  label={t('print.numbered')}
                  checked={!!b.numbered}
                  onChange={(e) => set({ numbered: e.target.checked || undefined })}
                />
              </div>
            </>
          )}
        </>
      );
      break;
    }
    case 'totals':
      body = (
        <>
          <Form.Text muted className="d-block mb-1">
            {t('print.totalsHelp')}
          </Form.Text>
          {b.rows.map((r, i) => (
            <Row className="g-1 mb-1 align-items-start" key={i}>
              <Col md={5}>
                {text(`${b.id}-r${i}`, r.label, (v) =>
                  set({ rows: b.rows.map((x, j) => (j === i ? { ...x, label: v } : x)) }),
                )}
              </Col>
              <Col md={4}>
                <Form.Control
                  size="sm"
                  dir="ltr"
                  className="font-monospace"
                  placeholder="SUM(lines.amount)"
                  value={r.value}
                  onChange={(e) =>
                    set({
                      rows: b.rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                    })
                  }
                />
              </Col>
              <Col md={3} className="d-flex gap-1">
                <Form.Check
                  id={`${b.id}-b${i}`}
                  label={t('print.bold')}
                  checked={!!r.bold}
                  onChange={(e) =>
                    set({
                      rows: b.rows.map((x, j) =>
                        j === i ? { ...x, bold: e.target.checked || undefined } : x,
                      ),
                    })
                  }
                />
                <Button
                  size="sm"
                  variant="outline-danger"
                  onClick={() => set({ rows: b.rows.filter((_, j) => j !== i) })}
                  aria-label={t('common.delete')}
                >
                  <i className="bi bi-x" />
                </Button>
              </Col>
            </Row>
          ))}
          <Button
            size="sm"
            variant="link"
            onClick={() => set({ rows: [...b.rows, { label: { en: 'Total' }, value: '' }] })}
          >
            <i className="bi bi-plus" /> {t('print.addTotal')}
          </Button>
          <InputGroup size="sm" className="mt-2">
            <InputGroup.Text>{t('print.inWords')}</InputGroup.Text>
            <Form.Control
              dir="ltr"
              className="font-monospace"
              placeholder="grand_total"
              value={b.words?.value ?? ''}
              onChange={(e) =>
                set({ words: e.target.value ? { ...b.words, value: e.target.value } : undefined })
              }
            />
          </InputGroup>
        </>
      );
      break;
    case 'qr':
    case 'barcode':
      body = (
        <>
          <Form.Control
            size="sm"
            dir="ltr"
            className="font-monospace mb-2"
            value={b.value}
            onChange={(e) => set({ value: e.target.value })}
          />
          <div className="d-flex align-items-center gap-2">
            <AlignSelect value={b.align} onChange={(align) => set({ align })} />
            <InputGroup size="sm" style={{ maxWidth: 150 }}>
              <InputGroup.Text>mm</InputGroup.Text>
              <Form.Control
                type="number"
                value={(b.type === 'qr' ? b.size : b.height) ?? ''}
                onChange={(e) =>
                  set(
                    b.type === 'qr'
                      ? { size: e.target.value ? Number(e.target.value) : undefined }
                      : { height: e.target.value ? Number(e.target.value) : undefined },
                  )
                }
              />
            </InputGroup>
          </div>
          {b.type === 'qr' && (
            <div className="mt-2">
              {text(`${b.id}-cap`, b.caption, (caption) =>
                set({ caption: Object.keys(caption).length ? caption : undefined }),
              )}
            </div>
          )}
        </>
      );
      break;
    case 'signature':
      body = (
        <>
          <FileButton value={b.image} onChange={(image) => set({ image })} />
          <Row className="g-2 mt-1">
            <Col md={6}>{text(`${b.id}-n`, b.name, (name) => set({ name }))}</Col>
            <Col md={6}>{text(`${b.id}-ti`, b.title, (title) => set({ title }))}</Col>
          </Row>
          <div className="mt-2">
            <AlignSelect value={b.align} onChange={(align) => set({ align })} />
          </div>
        </>
      );
      break;
    case 'image':
      body = (
        <>
          <FileButton value={b.file || undefined} onChange={(file) => set({ file: file ?? '' })} />
          <div className="d-flex align-items-center gap-2 mt-2">
            <AlignSelect value={b.align} onChange={(align) => set({ align })} />
            <InputGroup size="sm" style={{ maxWidth: 150 }}>
              <InputGroup.Text>mm</InputGroup.Text>
              <Form.Control
                type="number"
                value={b.width ?? ''}
                onChange={(e) =>
                  set({ width: e.target.value ? Number(e.target.value) : undefined })
                }
              />
            </InputGroup>
          </div>
        </>
      );
      break;
    case 'spacer':
      body = (
        <InputGroup size="sm" style={{ maxWidth: 150 }}>
          <InputGroup.Text>mm</InputGroup.Text>
          <Form.Control
            type="number"
            value={b.height}
            onChange={(e) => set({ height: Number(e.target.value) || 1 })}
          />
        </InputGroup>
      );
      break;
  }
  return (
    <>
      {body}
      <InputGroup size="sm" className="mt-2">
        <InputGroup.Text title={t('print.conditionHelp')}>{t('print.showIf')}</InputGroup.Text>
        <Form.Control
          dir="ltr"
          className="font-monospace"
          placeholder='STATUS() = "paid"'
          value={b.condition ?? ''}
          onChange={(e) => set({ condition: e.target.value || undefined })}
        />
      </InputGroup>
    </>
  );
}

/** Opens a draft template as a PDF on a real record, or on sample values. */
function Preview({ template, entity }: { template: PrintTemplateDef; entity: string }) {
  const { t } = useTranslation();
  const [recordId, setRecordId] = useState('');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const records = useQuery({
    queryKey: ['records', entity, 'preview'],
    queryFn: () => api<Page<RecordDto>>(`/records/${entity}`, { query: { pageSize: 20 } }),
    enabled: !!entity,
    retry: false,
  });
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const { blob } = await apiBlob('/documents/preview', {
        method: 'POST',
        body: { template, recordId: recordId || undefined },
      });
      setUrl(URL.createObjectURL(blob));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <InputGroup size="sm" className="mb-2">
        <Form.Select value={recordId} onChange={(e) => setRecordId(e.target.value)}>
          <option value="">{t('print.sampleValues')}</option>
          {records.data?.items.map((r) => (
            <option key={r.id} value={r.id}>
              {r.number ?? r.id}
            </option>
          ))}
        </Form.Select>
        <Button onClick={() => void run()} disabled={busy}>
          <i className="bi bi-file-earmark-pdf me-1" />
          {t('print.preview')}
        </Button>
      </InputGroup>
      <ErrorAlert error={error} />
      {url ? (
        <iframe className="print-preview" src={url} title={t('print.preview')} />
      ) : (
        <div className="text-body-secondary small">{t('print.previewHelp')}</div>
      )}
    </div>
  );
}

function PrintDesigner({
  template,
  onClose,
}: {
  template?: PrintTemplateDef;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const label = useLabel();
  const { layer, company, scope } = useStudio();
  const { putItem } = useConfigActions();
  const merged = useMemo(
    () =>
      mergeLayers(
        scope === 'company' ? [platformBaseLayer(), layer] : [platformBaseLayer(), company, layer],
      ),
    [layer, company, scope],
  );
  const entities = merged.entities.filter(
    (e): e is EntityDef => !!e.kind && !!e.label && !!e.pluralLabel,
  );
  const [d, setD] = useState<PrintTemplateDef>(
    template ?? {
      key: '',
      entity: '',
      label: {},
      page: { size: 'A4' },
      mode: 'blocks',
      blocks: [newBlock('letterhead'), newBlock('title'), newBlock('fields')],
      footer: { pageNumbers: true },
    },
  );
  const set = (patch: Partial<PrintTemplateDef>) => setD((prev) => ({ ...prev, ...patch }));
  const entity = entities.find((e) => e.key === d.entity);
  const blocks = d.blocks ?? [];
  const setBlock = (i: number, b: PrintBlock) =>
    set({ blocks: blocks.map((x, j) => (j === i ? b : x)) });
  const move = (i: number, by: number) => {
    const list = [...blocks];
    const [b] = list.splice(i, 1);
    list.splice(Math.max(0, Math.min(list.length, i + by)), 0, b);
    set({ blocks: list });
  };
  const languages = d.languages ?? [];
  const ok = KEY_RE.test(d.key) && !!d.entity && Object.values(d.label).some(Boolean);
  const clean = (): PrintTemplateDef => ({
    ...d,
    languages: languages.length ? languages : undefined,
    copies: d.copies?.filter((c) => Object.values(c).some(Boolean)).length
      ? d.copies.filter((c) => Object.values(c).some(Boolean))
      : undefined,
    watermarks: d.watermarks?.length ? d.watermarks : undefined,
    blocks: d.mode === 'blocks' ? blocks : undefined,
    html: d.mode === 'html' ? d.html : undefined,
    css: d.mode === 'html' ? d.css : undefined,
    fileName: d.fileName || undefined,
  });
  return (
    <Card className="shadow-sm border-0">
      <Card.Header className="bg-body d-flex align-items-center gap-2">
        <span className="fw-semibold">{template ? template.key : t('print.new')}</span>
        <div className="ms-auto d-flex gap-2">
          <Button size="sm" variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            disabled={!ok || putItem.isPending}
            onClick={() =>
              void putItem
                .mutateAsync({ kind: 'print-templates', key: d.key, body: clean(), scope })
                .then(onClose)
            }
          >
            {t('common.save')}
          </Button>
        </div>
      </Card.Header>
      <Card.Body>
        <ErrorAlert error={putItem.error} />
        <Row>
          <Col xl={7}>
            <Row>
              <Col md={4}>
                <Field label={t('studio.key')} controlId="pt-key">
                  <Form.Control
                    dir="ltr"
                    className="font-monospace"
                    value={d.key}
                    disabled={!!template}
                    onChange={(e) => set({ key: e.target.value.toLowerCase() })}
                  />
                </Field>
              </Col>
              <Col md={4}>
                <Field label={t('studio.label')} controlId="pt-label">
                  <LocalizedInput
                    id="pt-label"
                    value={d.label}
                    onChange={(v) => set({ label: v })}
                  />
                </Field>
              </Col>
              <Col md={4}>
                <Field label={t('reports.entity')} controlId="pt-entity">
                  <Form.Select
                    value={d.entity}
                    disabled={!!template}
                    onChange={(e) => set({ entity: e.target.value })}
                  >
                    <option value="">{t('records.choose')}</option>
                    {entities
                      .filter((e) => e.kind === 'custom' && !e.archived)
                      .map((e) => (
                        <option key={e.key} value={e.key}>
                          {label(e.pluralLabel)}
                        </option>
                      ))}
                  </Form.Select>
                </Field>
              </Col>
              <Col md={3}>
                <Field label={t('print.paper')} controlId="pt-size">
                  <Form.Select
                    value={d.page.size}
                    onChange={(e) =>
                      set({
                        page: {
                          ...d.page,
                          size: e.target.value as PrintTemplateDef['page']['size'],
                        },
                      })
                    }
                  >
                    {PAGE_SIZES.map((s) => (
                      <option key={s} value={s}>
                        {t(`print.size.${s}`)}
                      </option>
                    ))}
                  </Form.Select>
                </Field>
              </Col>
              <Col md={3}>
                <Field label={t('print.orientation')} controlId="pt-or">
                  <Form.Select
                    value={d.page.orientation ?? 'portrait'}
                    disabled={d.page.size.startsWith('thermal')}
                    onChange={(e) =>
                      set({
                        page: {
                          ...d.page,
                          orientation: e.target.value as 'portrait' | 'landscape',
                        },
                      })
                    }
                  >
                    <option value="portrait">{t('print.portrait')}</option>
                    <option value="landscape">{t('print.landscape')}</option>
                  </Form.Select>
                </Field>
              </Col>
              <Col md={3}>
                <Field label={t('print.margin')} controlId="pt-margin">
                  <InputGroup>
                    <Form.Control
                      type="number"
                      min={0}
                      max={50}
                      value={d.page.margin ?? ''}
                      onChange={(e) =>
                        set({
                          page: {
                            ...d.page,
                            margin: e.target.value ? Number(e.target.value) : undefined,
                          },
                        })
                      }
                    />
                    <InputGroup.Text>mm</InputGroup.Text>
                  </InputGroup>
                </Field>
              </Col>
              <Col md={3}>
                <Field label={t('print.fontSize')} controlId="pt-font">
                  <InputGroup>
                    <Form.Control
                      type="number"
                      min={6}
                      max={16}
                      value={d.fontSize ?? ''}
                      onChange={(e) =>
                        set({ fontSize: e.target.value ? Number(e.target.value) : undefined })
                      }
                    />
                    <InputGroup.Text>pt</InputGroup.Text>
                  </InputGroup>
                </Field>
              </Col>
              <Col md={6}>
                <Field
                  label={t('print.languages')}
                  controlId="pt-lang"
                  hint={t('print.languagesHint')}
                >
                  <InputGroup>
                    {[0, 1].map((i) => (
                      <Form.Select
                        key={i}
                        value={languages[i] ?? ''}
                        onChange={(e) => {
                          const next = [...languages];
                          next[i] = e.target.value;
                          set({ languages: next.filter(Boolean).slice(0, 2) });
                        }}
                      >
                        <option value="">
                          {i === 0 ? t('print.readerLanguage') : t('common.none')}
                        </option>
                        {PRINT_LANGUAGES.map((c) => (
                          <option key={c} value={c}>
                            {languageName(c, i18n.language)}
                          </option>
                        ))}
                      </Form.Select>
                    ))}
                  </InputGroup>
                </Field>
              </Col>
              <Col md={3}>
                <Field label={t('print.accent')} controlId="pt-accent">
                  <Form.Control
                    type="color"
                    value={d.accent ?? '#1f3a5f'}
                    onChange={(e) => set({ accent: e.target.value })}
                  />
                </Field>
              </Col>
              <Col md={3}>
                <Field label={t('print.mode')} controlId="pt-mode">
                  <Form.Select
                    value={d.mode}
                    onChange={(e) => set({ mode: e.target.value as 'blocks' | 'html' })}
                  >
                    <option value="blocks">{t('print.blocks')}</option>
                    <option value="html">{t('print.html')}</option>
                  </Form.Select>
                </Field>
              </Col>
            </Row>

            <details className="mb-3">
              <summary className="fw-semibold small mb-2">{t('print.more')}</summary>
              <Row className="mt-2">
                <Col md={6}>
                  <Form.Label className="small">{t('print.copies')}</Form.Label>
                  {(d.copies ?? []).map((c, i) => (
                    <InputGroup key={i} className="mb-1 align-items-start">
                      <div className="flex-grow-1">
                        <LocalizedInput
                          id={`pt-copy-${i}`}
                          value={c}
                          extra={languages}
                          onChange={(v) =>
                            set({ copies: (d.copies ?? []).map((x, j) => (j === i ? v : x)) })
                          }
                        />
                      </div>
                      <Button
                        size="sm"
                        variant="outline-danger"
                        onClick={() => set({ copies: (d.copies ?? []).filter((_, j) => j !== i) })}
                        aria-label={t('common.delete')}
                      >
                        <i className="bi bi-x" />
                      </Button>
                    </InputGroup>
                  ))}
                  <Button
                    size="sm"
                    variant="link"
                    onClick={() => set({ copies: [...(d.copies ?? []), { en: '' }] })}
                  >
                    <i className="bi bi-plus" /> {t('print.addCopy')}
                  </Button>
                </Col>
                <Col md={6}>
                  <Form.Label className="small">{t('print.watermarks')}</Form.Label>
                  {(d.watermarks ?? []).map((w, i) => (
                    <div key={i} className="mb-2">
                      <LocalizedInput
                        id={`pt-wm-${i}`}
                        value={w.text}
                        extra={languages}
                        onChange={(text) =>
                          set({
                            watermarks: (d.watermarks ?? []).map((x, j) =>
                              j === i ? { ...x, text } : x,
                            ),
                          })
                        }
                      />
                      <InputGroup size="sm" className="mt-1">
                        <InputGroup.Text>{t('print.showIf')}</InputGroup.Text>
                        <Form.Control
                          dir="ltr"
                          className="font-monospace"
                          value={w.condition ?? ''}
                          onChange={(e) =>
                            set({
                              watermarks: (d.watermarks ?? []).map((x, j) =>
                                j === i ? { ...x, condition: e.target.value || undefined } : x,
                              ),
                            })
                          }
                        />
                        <Button
                          variant="outline-danger"
                          onClick={() =>
                            set({ watermarks: (d.watermarks ?? []).filter((_, j) => j !== i) })
                          }
                          aria-label={t('common.delete')}
                        >
                          <i className="bi bi-x" />
                        </Button>
                      </InputGroup>
                    </div>
                  ))}
                  <Button
                    size="sm"
                    variant="link"
                    onClick={() =>
                      set({
                        watermarks: [
                          ...(d.watermarks ?? []),
                          { text: { en: 'PAID' }, condition: 'STATUS() = "paid"' },
                        ],
                      })
                    }
                  >
                    <i className="bi bi-plus" /> {t('print.addWatermark')}
                  </Button>
                </Col>
                <Col md={6}>
                  <Field label={t('print.footer')} controlId="pt-footer">
                    <LocalizedInput
                      id="pt-footer"
                      value={d.footer?.text}
                      extra={languages}
                      onChange={(text) =>
                        set({
                          footer: {
                            ...d.footer,
                            text: Object.keys(text).length ? text : undefined,
                          },
                        })
                      }
                    />
                  </Field>
                  <Form.Check
                    type="switch"
                    id="pt-pages"
                    label={t('print.pageNumbers')}
                    checked={!!d.footer?.pageNumbers}
                    onChange={(e) =>
                      set({ footer: { ...d.footer, pageNumbers: e.target.checked || undefined } })
                    }
                  />
                </Col>
                <Col md={6}>
                  <Field label={t('print.fileName')} controlId="pt-file" hint="Invoice-{{number}}">
                    <Form.Control
                      dir="ltr"
                      value={d.fileName ?? ''}
                      onChange={(e) => set({ fileName: e.target.value })}
                    />
                  </Field>
                  <Form.Check
                    type="switch"
                    id="pt-audit"
                    label={t('print.auditPrints')}
                    checked={!!d.auditPrints}
                    onChange={(e) => set({ auditPrints: e.target.checked || undefined })}
                  />
                  <Form.Check
                    type="switch"
                    id="pt-active"
                    label={t('reports.active')}
                    checked={d.active !== false}
                    onChange={(e) => set({ active: e.target.checked ? undefined : false })}
                  />
                </Col>
              </Row>
            </details>

            <p className="small text-body-secondary">{t('print.placeholders')}</p>
            {!entity ? (
              <p className="text-body-secondary">{t('print.chooseEntity')}</p>
            ) : d.mode === 'html' ? (
              <>
                <Field label="HTML" controlId="pt-html">
                  <Form.Control
                    as="textarea"
                    rows={16}
                    dir="ltr"
                    className="font-monospace small"
                    value={d.html ?? ''}
                    onChange={(e) => set({ html: e.target.value })}
                  />
                </Field>
                <Field label="CSS" controlId="pt-css">
                  <Form.Control
                    as="textarea"
                    rows={6}
                    dir="ltr"
                    className="font-monospace small"
                    value={d.css ?? ''}
                    onChange={(e) => set({ css: e.target.value })}
                  />
                </Field>
              </>
            ) : (
              <>
                {blocks.map((b, i) => (
                  <div key={b.id} className="print-block p-2 mb-2">
                    <div className="d-flex align-items-center mb-2">
                      <Badge bg="secondary-subtle" text="secondary-emphasis">
                        {t(`print.block.${b.type}`)}
                      </Badge>
                      <div className="ms-auto">
                        <Button
                          size="sm"
                          variant="link"
                          onClick={() => move(i, -1)}
                          disabled={i === 0}
                          aria-label={t('dashboards.up')}
                        >
                          <i className="bi bi-arrow-up" />
                        </Button>
                        <Button
                          size="sm"
                          variant="link"
                          onClick={() => move(i, 1)}
                          disabled={i === blocks.length - 1}
                          aria-label={t('dashboards.down')}
                        >
                          <i className="bi bi-arrow-down" />
                        </Button>
                        <Button
                          size="sm"
                          variant="link"
                          className="text-danger"
                          onClick={() => set({ blocks: blocks.filter((_, j) => j !== i) })}
                          aria-label={t('common.delete')}
                        >
                          <i className="bi bi-trash" />
                        </Button>
                      </div>
                    </div>
                    <BlockEditor
                      block={b}
                      onChange={(x) => setBlock(i, x)}
                      entity={entity}
                      entities={entities}
                      languages={languages}
                    />
                  </div>
                ))}
                <Dropdown>
                  <Dropdown.Toggle size="sm" variant="outline-primary">
                    <i className="bi bi-plus me-1" />
                    {t('print.addBlock')}
                  </Dropdown.Toggle>
                  <Dropdown.Menu>
                    {BLOCK_TYPES.map((bt) => (
                      <Dropdown.Item
                        key={bt}
                        onClick={() => set({ blocks: [...blocks, newBlock(bt)] })}
                      >
                        {t(`print.block.${bt}`)}
                      </Dropdown.Item>
                    ))}
                  </Dropdown.Menu>
                </Dropdown>
              </>
            )}
          </Col>
          <Col xl={5}>
            <div className="position-sticky" style={{ top: 16 }}>
              {entity && <Preview template={clean()} entity={d.entity} />}
            </div>
          </Col>
        </Row>
      </Card.Body>
    </Card>
  );
}

export function PrintTemplatesTab() {
  const { t } = useTranslation();
  const label = useLabel();
  const { can } = useAuth();
  const { layer, company, scope } = useStudio();
  const { deleteItem } = useConfigActions();
  const [editing, setEditing] = useState<PrintTemplateDef | 'new' | null>(null);
  const own = new Set(layer.printTemplates.map((p) => p.key));
  // In a branch, company templates can be overridden (e.g. the branch's own letterhead).
  const inherited =
    scope === 'company' ? [] : company.printTemplates.filter((p) => !own.has(p.key));
  if (editing)
    return (
      <PrintDesigner
        template={editing === 'new' ? undefined : editing}
        onClose={() => setEditing(null)}
      />
    );
  return (
    <Card className="shadow-sm border-0">
      <Card.Body>
        <p className="small text-body-secondary">{t('print.intro')}</p>
        <ErrorAlert error={deleteItem.error} />
        {can('config.manage') && (
          <Button size="sm" className="mb-3" onClick={() => setEditing('new')}>
            <i className="bi bi-plus-lg me-1" />
            {t('print.new')}
          </Button>
        )}
        {!layer.printTemplates.length && !inherited.length && (
          <p className="text-body-secondary">{t('print.none')}</p>
        )}
        <Table hover size="sm" className="align-middle mb-0">
          <tbody>
            {[...layer.printTemplates, ...inherited].map((p) => (
              <tr key={p.key}>
                <td className="font-monospace small" dir="ltr">
                  {p.key}
                </td>
                <td>
                  {label(p.label)}{' '}
                  {!own.has(p.key) && (
                    <Badge bg="light" text="dark">
                      {t('print.fromCompany')}
                    </Badge>
                  )}
                  {p.active === false && (
                    <Badge bg="secondary" className="ms-1">
                      {t('reports.paused')}
                    </Badge>
                  )}
                </td>
                <td className="small text-body-secondary">
                  {p.entity} · {t(`print.size.${p.page.size}`)}
                  {p.languages?.length ? ` · ${p.languages.join(' + ')}` : ''}
                </td>
                <td className="text-end text-nowrap">
                  {can('config.manage') && (
                    <Button
                      size="sm"
                      variant="outline-primary"
                      className="me-1"
                      onClick={() => setEditing(p)}
                      title={own.has(p.key) ? undefined : t('print.overrideHint')}
                    >
                      <i className={`bi ${own.has(p.key) ? 'bi-pencil' : 'bi-pencil-square'}`} />
                    </Button>
                  )}
                  {own.has(p.key) && can('config.manage') && (
                    <Button
                      size="sm"
                      variant="outline-danger"
                      onClick={() =>
                        window.confirm(t('common.confirm')) &&
                        deleteItem.mutate({ kind: 'print-templates', key: p.key, scope })
                      }
                    >
                      <i className="bi bi-trash" />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card.Body>
    </Card>
  );
}
