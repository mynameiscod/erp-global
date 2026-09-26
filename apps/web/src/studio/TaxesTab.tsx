import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Form,
  InputGroup,
  Modal,
  Row,
  Table,
} from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import {
  CHECKSUMS,
  checkIdentifier,
  compileFormula,
  FormulaError,
  KEY_RE,
  mergeTaxSetups,
  type Checksum,
  type IdentifierType,
  type LocalizedText,
  type TaxCategory,
  type TaxCategoryKind,
  type TaxComponent,
  type TaxRule,
  type TaxSetup,
} from '@erp/metadata';
import { useAuth } from '../auth/AuthContext';
import { useLabel } from '../config/hooks';
import { LocalizedInput } from '../config/LocalizedInput';
import { ErrorAlert, Field } from '../components/ui';
import { PACK_BADGE, useInherited, useStep6Actions } from './packBase';
import { useStudio } from './StudioContext';

const EMPTY: TaxSetup = { components: [], categories: [], rules: [] };
const KINDS: TaxCategoryKind[] = ['taxable', 'exempt', 'nil', 'non_taxable'];
/** Names a rule's condition can use (see `pickTaxRule`). */
const RULE_NAMES = [
  'seller_region',
  'buyer_region',
  'buyer_country',
  'company_country',
  'buyer_registered',
  'reverse_charge',
];

const hasText = (l: LocalizedText | undefined) => Object.values(l ?? {}).some((v) => v.trim());
const rateOk = (n: number) => Number.isFinite(n) && n >= 0 && n <= 100;

function conditionProblem(src: string | undefined): string | null {
  if (!src?.trim()) return null;
  try {
    const unknown = compileFormula(src).fields.find((f) => !RULE_NAMES.includes(f));
    return unknown ? `Unknown name "${unknown}"` : null;
  } catch (e) {
    return e instanceof FormulaError ? e.message : 'Invalid formula';
  }
}

/** `cess:12, other:1` ⇄ the category's extra taxes. */
const extraText = (c: TaxCategory) =>
  (c.extra ?? []).map((e) => `${e.component}:${e.rate}`).join(', ');
const parseExtra = (s: string): TaxCategory['extra'] => {
  const list = s
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [component, rate] = p.split(':').map((x) => x.trim());
      return { component: component.toLowerCase(), rate: Number(rate ?? 0) };
    });
  return list.length ? list : undefined;
};

/**
 * Items from the packs (read-only, with "Change" to copy them into the company's layer)
 * followed by the company's own items (editable). A company item with a pack's key replaces it.
 */
function ItemTable<T extends { key: string }>({
  title,
  help,
  headers,
  packItems,
  own,
  onChange,
  blank,
  view,
  edit,
  editable,
}: {
  title: string;
  help?: string;
  headers: string[];
  packItems: T[];
  own: T[];
  onChange: (v: T[]) => void;
  blank: () => T;
  view: (item: T) => ReactNode[];
  edit: (item: T, set: (patch: Partial<T>) => void, i: number) => ReactNode[];
  editable: boolean;
}) {
  const { t } = useTranslation();
  const packKeys = new Set(packItems.map((p) => p.key));
  const rows: { pack?: T; i: number }[] = [
    ...packItems.map((p) => ({ pack: p, i: own.findIndex((o) => o.key === p.key) })),
    ...own.map((_, i) => ({ i })).filter((r) => !packKeys.has(own[r.i].key)),
  ];
  const set = (i: number, patch: Partial<T>) =>
    onChange(own.map((o, n) => (n === i ? { ...o, ...patch } : o)));
  const keys = own.map((o) => o.key);
  return (
    <div className="mb-4">
      <h3 className="h6 mb-1">{title}</h3>
      {help && <p className="small text-body-secondary mb-2">{help}</p>}
      <Table size="sm" responsive className="align-middle">
        <thead>
          <tr className="small text-body-secondary">
            <th style={{ width: 150 }}>{t('studio.key')}</th>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
            <th style={{ width: 90 }} />
            <th style={{ width: 90 }} />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ pack, i }) => {
            const item = i >= 0 ? own[i] : pack!;
            const mine = i >= 0;
            return (
              <tr key={mine ? `o${i}` : `p${pack!.key}`}>
                <td>
                  {mine && !pack ? (
                    <Form.Control
                      size="sm"
                      dir="ltr"
                      className="font-monospace"
                      value={item.key}
                      isInvalid={
                        !!item.key && (!KEY_RE.test(item.key) || keys.indexOf(item.key) !== i)
                      }
                      onChange={(e) => set(i, { key: e.target.value.toLowerCase() } as Partial<T>)}
                    />
                  ) : (
                    <code>{item.key}</code>
                  )}
                </td>
                {(mine ? edit(item, (p) => set(i, p), i) : view(item)).map((c, n) => (
                  <td key={n}>{c}</td>
                ))}
                <td>
                  {pack && !mine && <Badge {...PACK_BADGE}>{t('studio.taxes.fromPack')}</Badge>}
                  {pack && mine && (
                    <Badge bg="warning-subtle" text="warning-emphasis">
                      {t('studio.taxes.changed')}
                    </Badge>
                  )}
                  {!pack && (
                    <Badge bg="light" text="dark" className="border">
                      {t('studio.company')}
                    </Badge>
                  )}
                </td>
                <td className="text-end text-nowrap">
                  {editable && !mine && (
                    <Button
                      size="sm"
                      variant="outline-primary"
                      title={t('studio.taxes.change')}
                      onClick={() => onChange([...own, structuredClone(pack!)])}
                    >
                      <i className="bi bi-pencil" />
                    </Button>
                  )}
                  {editable && mine && (
                    <Button
                      size="sm"
                      variant="outline-danger"
                      title={pack ? t('studio.taxes.revert') : t('common.delete')}
                      onClick={() => onChange(own.filter((_, n) => n !== i))}
                    >
                      <i className={`bi ${pack ? 'bi-arrow-counterclockwise' : 'bi-x-lg'}`} />
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
          {!rows.length && (
            <tr>
              <td colSpan={headers.length + 3} className="text-body-secondary small">
                {t('studio.empty')}
              </td>
            </tr>
          )}
        </tbody>
      </Table>
      {editable && (
        <Button size="sm" variant="outline-primary" onClick={() => onChange([...own, blank()])}>
          <i className="bi bi-plus me-1" />
          {t('studio.taxes.add')}
        </Button>
      )}
    </div>
  );
}

function SplitEditor({
  value,
  onChange,
  components,
}: {
  value: TaxRule['split'];
  onChange: (v: TaxRule['split']) => void;
  components: TaxComponent[];
}) {
  const { t } = useTranslation();
  const label = useLabel();
  return (
    <div style={{ minWidth: 220 }}>
      {value.map((s, i) => (
        <InputGroup size="sm" key={i} className="mb-1">
          <Form.Select
            value={s.component}
            onChange={(e) =>
              onChange(value.map((x, n) => (n === i ? { ...x, component: e.target.value } : x)))
            }
          >
            {!components.some((c) => c.key === s.component) && (
              <option value={s.component}>{s.component}</option>
            )}
            {components.map((c) => (
              <option key={c.key} value={c.key}>
                {label(c.label) || c.key}
              </option>
            ))}
          </Form.Select>
          <Form.Control
            type="number"
            step="0.05"
            min={0}
            max={1}
            dir="ltr"
            style={{ maxWidth: 80 }}
            title={t('studio.taxes.share')}
            value={s.share}
            isInvalid={!(s.share >= 0 && s.share <= 1)}
            onChange={(e) =>
              onChange(value.map((x, n) => (n === i ? { ...x, share: Number(e.target.value) } : x)))
            }
          />
          <Button
            variant="outline-danger"
            onClick={() => onChange(value.filter((_, n) => n !== i))}
            aria-label={t('common.delete')}
          >
            <i className="bi bi-x" />
          </Button>
        </InputGroup>
      ))}
      <Button
        size="sm"
        variant="link"
        className="px-0"
        disabled={!components.length}
        onClick={() => onChange([...value, { component: components[0]?.key ?? '', share: 1 }])}
      >
        <i className="bi bi-plus me-1" />
        {t('studio.taxes.addSplit')}
      </Button>
    </div>
  );
}

function TaxSetupCard() {
  const { t } = useTranslation();
  const label = useLabel();
  const { can } = useAuth();
  const { company } = useStudio();
  const { packs } = useInherited();
  const { putTaxes } = useStep6Actions();
  const editable = can('config.manage');
  const [own, setOwn] = useState<TaxSetup>(company.taxes ?? EMPTY);
  const [saved, setSaved] = useState(false);
  useEffect(() => setOwn(company.taxes ?? EMPTY), [company.taxes]);
  const pack = packs.taxes;
  const effective = useMemo(() => mergeTaxSetups([pack, own]) ?? EMPTY, [pack, own]);
  const change = (patch: Partial<TaxSetup>) => {
    setSaved(false);
    setOwn((o) => ({ ...o, ...patch }));
  };

  const uniqueKeys = (list: { key: string }[]) =>
    list.every((x, i) => KEY_RE.test(x.key) && list.findIndex((y) => y.key === x.key) === i);
  const valid =
    uniqueKeys(own.components) &&
    uniqueKeys(own.categories) &&
    uniqueKeys(own.rules) &&
    own.components.every((c) => hasText(c.label)) &&
    own.categories.every(
      (c) => hasText(c.label) && rateOk(c.rate) && (c.extra ?? []).every((e) => rateOk(e.rate)),
    ) &&
    own.rules.every(
      (r) =>
        hasText(r.label) &&
        !conditionProblem(r.condition) &&
        r.split.every((s) => s.component && s.share >= 0 && s.share <= 1),
    );

  const save = async () => {
    const clean: TaxSetup = {
      components: own.components,
      categories: own.categories.map((c) => ({
        ...c,
        extra: c.extra?.length ? c.extra : undefined,
      })),
      rules: own.rules.map((r) => ({
        ...r,
        condition: r.condition?.trim() || undefined,
        zero: r.zero || undefined,
      })),
      defaultCategory: own.defaultCategory || undefined,
      roundTotal: own.roundTotal,
    };
    const empty =
      !clean.components.length &&
      !clean.categories.length &&
      !clean.rules.length &&
      !clean.defaultCategory &&
      clean.roundTotal === undefined;
    await putTaxes.mutateAsync(empty ? {} : clean);
    setSaved(true);
  };

  const kindLabel = (k: TaxCategoryKind | undefined) => t(`studio.taxes.kinds.${k ?? 'taxable'}`);

  return (
    <Card className="shadow-sm border-0 mb-3">
      <Card.Body>
        <h2 className="h5">{t('studio.taxes.title')}</h2>
        <p className="small text-body-secondary">
          {pack ? t('studio.taxes.introPack') : t('studio.taxes.intro')}
        </p>
        <ErrorAlert error={putTaxes.error} />
        {saved && <Alert variant="success">{t('common.saved')}</Alert>}

        <ItemTable<TaxComponent>
          title={t('studio.taxes.components')}
          help={t('studio.taxes.componentsHelp')}
          headers={[t('studio.label')]}
          packItems={pack?.components ?? []}
          own={own.components}
          onChange={(components) => change({ components })}
          blank={() => ({ key: '', label: {} })}
          editable={editable}
          view={(c) => [label(c.label)]}
          edit={(c, set, i) => [
            <LocalizedInput
              key="l"
              id={`tx-c-${i}`}
              value={c.label}
              invalid={!hasText(c.label)}
              onChange={(v) => set({ label: v })}
            />,
          ]}
        />

        <ItemTable<TaxCategory>
          title={t('studio.taxes.categories')}
          help={t('studio.taxes.categoriesHelp')}
          headers={[
            t('studio.label'),
            t('studio.taxes.rate'),
            t('studio.taxes.kind'),
            t('studio.taxes.extra'),
          ]}
          packItems={pack?.categories ?? []}
          own={own.categories}
          onChange={(categories) => change({ categories })}
          blank={() => ({ key: '', label: {}, rate: 0, kind: 'taxable' })}
          editable={editable}
          view={(c) => [label(c.label), `${c.rate}%`, kindLabel(c.kind), extraText(c) || '—']}
          edit={(c, set, i) => [
            <LocalizedInput
              key="l"
              id={`tx-k-${i}`}
              value={c.label}
              invalid={!hasText(c.label)}
              onChange={(v) => set({ label: v })}
            />,
            <InputGroup size="sm" key="r" style={{ maxWidth: 120 }}>
              <Form.Control
                type="number"
                step="0.01"
                dir="ltr"
                value={c.rate}
                isInvalid={!rateOk(c.rate)}
                onChange={(e) => set({ rate: Number(e.target.value) })}
              />
              <InputGroup.Text>%</InputGroup.Text>
            </InputGroup>,
            <Form.Select
              key="k"
              size="sm"
              value={c.kind ?? 'taxable'}
              onChange={(e) => set({ kind: e.target.value as TaxCategoryKind })}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {kindLabel(k)}
                </option>
              ))}
            </Form.Select>,
            <ExtraInput key="x" category={c} onChange={(extra) => set({ extra })} />,
          ]}
        />

        <ItemTable<TaxRule>
          title={t('studio.taxes.rules')}
          help={t('studio.taxes.rulesHelp')}
          headers={[
            t('studio.label'),
            t('studio.taxes.condition'),
            t('studio.taxes.split'),
            t('studio.taxes.zero'),
          ]}
          packItems={pack?.rules ?? []}
          own={own.rules}
          onChange={(rules) => change({ rules })}
          blank={() => ({ key: '', label: {}, split: [] })}
          editable={editable}
          view={(r) => [
            label(r.label),
            r.condition ? (
              <code className="small" dir="ltr">
                {r.condition}
              </code>
            ) : (
              <span className="text-body-secondary small">{t('studio.taxes.always')}</span>
            ),
            r.split
              .map(
                (s) =>
                  `${label(effective.components.find((c) => c.key === s.component)?.label) || s.component} × ${s.share}`,
              )
              .join(' + ') || '—',
            r.zero ? t('common.yes') : '',
          ]}
          edit={(r, set, i) => {
            const problem = conditionProblem(r.condition);
            return [
              <LocalizedInput
                key="l"
                id={`tx-r-${i}`}
                value={r.label}
                invalid={!hasText(r.label)}
                onChange={(v) => set({ label: v })}
              />,
              <div key="c" style={{ minWidth: 220 }}>
                <Form.Control
                  size="sm"
                  dir="ltr"
                  className="font-monospace"
                  value={r.condition ?? ''}
                  placeholder={t('studio.taxes.always')}
                  isInvalid={!!problem}
                  onChange={(e) => set({ condition: e.target.value })}
                />
                {problem && (
                  <Form.Control.Feedback type="invalid" className="d-block">
                    {problem}
                  </Form.Control.Feedback>
                )}
              </div>,
              <SplitEditor
                key="s"
                value={r.split}
                components={effective.components}
                onChange={(split) => set({ split })}
              />,
              <Form.Check
                key="z"
                type="switch"
                id={`tx-z-${i}`}
                checked={!!r.zero}
                onChange={(e) => set({ zero: e.target.checked || undefined })}
              />,
            ];
          }}
        />
        <p className="small text-body-secondary" dir="ltr">
          {RULE_NAMES.join(' · ')}
        </p>

        <Row>
          <Col md={6}>
            <Field
              label={t('studio.taxes.defaultCategory')}
              controlId="tx-default"
              hint={t('studio.taxes.defaultCategoryHelp')}
            >
              <Form.Select
                disabled={!editable}
                value={own.defaultCategory ?? ''}
                onChange={(e) => change({ defaultCategory: e.target.value || undefined })}
              >
                <option value="">
                  {pack?.defaultCategory
                    ? t('studio.taxes.inherit', {
                        value:
                          label(
                            effective.categories.find((c) => c.key === pack.defaultCategory)?.label,
                          ) || pack.defaultCategory,
                      })
                    : t('common.none')}
                </option>
                {effective.categories.map((c) => (
                  <option key={c.key} value={c.key}>
                    {label(c.label) || c.key}
                  </option>
                ))}
              </Form.Select>
            </Field>
          </Col>
          <Col md={6}>
            <Field
              label={t('studio.taxes.roundTotal')}
              controlId="tx-round"
              hint={t('studio.taxes.roundTotalHelp')}
            >
              <Form.Select
                disabled={!editable}
                value={own.roundTotal === undefined ? '' : String(own.roundTotal)}
                onChange={(e) =>
                  change({
                    roundTotal: e.target.value === '' ? undefined : e.target.value === 'true',
                  })
                }
              >
                <option value="">
                  {pack?.roundTotal !== undefined
                    ? t('studio.taxes.inherit', {
                        value: pack.roundTotal ? t('common.yes') : t('common.no'),
                      })
                    : t('common.no')}
                </option>
                <option value="true">{t('common.yes')}</option>
                <option value="false">{t('common.no')}</option>
              </Form.Select>
            </Field>
          </Col>
        </Row>
        {editable && (
          <Button disabled={!valid || putTaxes.isPending} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        )}
      </Card.Body>
    </Card>
  );
}

/** Extra taxes of a category as text; kept as typed until it parses. */
function ExtraInput({
  category,
  onChange,
}: {
  category: TaxCategory;
  onChange: (v: TaxCategory['extra']) => void;
}) {
  const [text, setText] = useState(extraText(category));
  const current = extraText(category);
  // Follow outside changes (a revert), but not the user's half-typed text.
  useEffect(() => {
    setText((prev) =>
      extraText({ ...category, extra: parseExtra(prev) }) === current ? prev : current,
    );
  }, [current]);
  return (
    <Form.Control
      size="sm"
      dir="ltr"
      className="font-monospace"
      placeholder="cess:12"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseExtra(e.target.value));
      }}
    />
  );
}

// ---- identifier types ----

function IdentifierDialog({
  initial,
  locked,
  taken,
  onClose,
}: {
  initial: IdentifierType;
  /** Changing a pack's type or an existing one: the key stays. */
  locked: boolean;
  taken: string[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { putIdentifier } = useStep6Actions();
  const [it, setIt] = useState<IdentifierType>(initial);
  const [sample, setSample] = useState(initial.example ?? '');
  const set = (patch: Partial<IdentifierType>) => setIt((p) => ({ ...p, ...patch }));
  const patternError = useMemo(() => {
    try {
      new RegExp(`^(?:${it.pattern})$`);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }, [it.pattern]);
  const keyOk = KEY_RE.test(it.key) && (locked || !taken.includes(it.key));
  const test = sample.trim() && !patternError ? checkIdentifier(it, sample) : null;

  const save = async () => {
    await putIdentifier.mutateAsync({
      key: it.key,
      label: it.label,
      pattern: it.pattern,
      ...(it.checksum ? { checksum: it.checksum } : {}),
      ...(it.uppercase ? { uppercase: true } : {}),
      ...(it.example?.trim() ? { example: it.example.trim() } : {}),
    });
    onClose();
  };

  return (
    <Modal show onHide={onClose} centered size="lg">
      <Modal.Header closeButton>
        <Modal.Title className="h5">{t('studio.identifiers.edit')}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <ErrorAlert error={putIdentifier.error} />
        <Row>
          <Col md={6}>
            <Field label={t('studio.label')} controlId="id-label">
              <LocalizedInput id="id-label" value={it.label} onChange={(v) => set({ label: v })} />
            </Field>
          </Col>
          <Col md={6}>
            <Field
              label={t('studio.key')}
              controlId="id-key"
              hint={t('studio.keyHint')}
              error={it.key && !keyOk ? t('studio.keyHint') : undefined}
            >
              <Form.Control
                value={it.key}
                disabled={locked}
                dir="ltr"
                className="font-monospace"
                onChange={(e) => set({ key: e.target.value.toLowerCase() })}
              />
            </Field>
          </Col>
          <Col md={8}>
            <Field
              label={t('studio.pattern')}
              controlId="id-pattern"
              hint={t('studio.identifiers.patternHelp')}
              error={patternError ?? undefined}
            >
              <Form.Control
                value={it.pattern}
                dir="ltr"
                className="font-monospace"
                onChange={(e) => set({ pattern: e.target.value })}
              />
            </Field>
          </Col>
          <Col md={4}>
            <Field label={t('studio.identifiers.checksum')} controlId="id-checksum">
              <Form.Select
                value={it.checksum ?? ''}
                onChange={(e) => set({ checksum: (e.target.value || undefined) as Checksum })}
              >
                <option value="">{t('common.none')}</option>
                {CHECKSUMS.map((c) => (
                  <option key={c} value={c}>
                    {t(`studio.identifiers.checksums.${c}`)}
                  </option>
                ))}
              </Form.Select>
            </Field>
          </Col>
          <Col md={6}>
            <Field label={t('studio.identifiers.example')} controlId="id-example">
              <Form.Control
                value={it.example ?? ''}
                dir="ltr"
                className="font-monospace"
                onChange={(e) => set({ example: e.target.value })}
              />
            </Field>
          </Col>
          <Col md={6} className="d-flex align-items-center">
            <Form.Check
              type="switch"
              id="id-upper"
              label={t('studio.identifiers.uppercase')}
              checked={!!it.uppercase}
              onChange={(e) => set({ uppercase: e.target.checked || undefined })}
            />
          </Col>
        </Row>
        <Field label={t('studio.identifiers.test')} controlId="id-test">
          <Form.Control
            value={sample}
            dir="ltr"
            className="font-monospace"
            isValid={!!test && 'value' in test}
            isInvalid={!!test && 'error' in test}
            onChange={(e) => setSample(e.target.value)}
          />
          {test && 'error' in test && (
            <Form.Control.Feedback type="invalid">{test.error}</Form.Control.Feedback>
          )}
          {test && 'value' in test && (
            <Form.Control.Feedback type="valid">
              {t('studio.identifiers.valid')}
            </Form.Control.Feedback>
          )}
        </Field>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          disabled={
            !keyOk || !hasText(it.label) || !it.pattern || !!patternError || putIdentifier.isPending
          }
          onClick={() => void save()}
        >
          {t('common.save')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

function IdentifierTypesCard() {
  const { t } = useTranslation();
  const label = useLabel();
  const { can } = useAuth();
  const { company } = useStudio();
  const { packs } = useInherited();
  const { deleteIdentifier } = useStep6Actions();
  const editable = can('config.manage');
  const [editing, setEditing] = useState<{ item: IdentifierType; locked: boolean } | null>(null);
  const packKeys = new Set(packs.identifierTypes.map((i) => i.key));
  const own = company.identifierTypes ?? [];
  const rows = [
    ...packs.identifierTypes.map((p) => own.find((o) => o.key === p.key) ?? p),
    ...own.filter((o) => !packKeys.has(o.key)),
  ];
  const ownKeys = new Set(own.map((o) => o.key));

  return (
    <Card className="shadow-sm border-0 mb-3">
      <Card.Body>
        <h2 className="h5">{t('studio.identifiers.title')}</h2>
        <p className="small text-body-secondary">{t('studio.identifiers.intro')}</p>
        <ErrorAlert error={deleteIdentifier.error} />
        {editable && (
          <Button
            size="sm"
            className="mb-3"
            onClick={() => setEditing({ item: { key: '', label: {}, pattern: '' }, locked: false })}
          >
            <i className="bi bi-plus-lg me-1" />
            {t('studio.identifiers.add')}
          </Button>
        )}
        {!rows.length ? (
          <p className="text-body-secondary mb-0">{t('studio.empty')}</p>
        ) : (
          <Table size="sm" hover responsive className="align-middle mb-0">
            <thead>
              <tr className="small text-body-secondary">
                <th>{t('studio.label')}</th>
                <th>{t('studio.key')}</th>
                <th>{t('studio.pattern')}</th>
                <th>{t('studio.identifiers.checksum')}</th>
                <th>{t('studio.identifiers.example')}</th>
                <th />
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const fromPack = packKeys.has(r.key);
                const mine = ownKeys.has(r.key);
                return (
                  <tr key={r.key}>
                    <td className="fw-medium">{label(r.label)}</td>
                    <td>
                      <code>{r.key}</code>
                    </td>
                    <td>
                      <code className="small" dir="ltr">
                        {r.pattern}
                      </code>
                      {r.uppercase && (
                        <Badge bg="light" text="dark" className="border ms-1">
                          A–Z
                        </Badge>
                      )}
                    </td>
                    <td className="small">
                      {r.checksum ? t(`studio.identifiers.checksums.${r.checksum}`) : '—'}
                    </td>
                    <td className="small font-monospace" dir="ltr">
                      {r.example}
                    </td>
                    <td>
                      {fromPack && !mine && (
                        <Badge {...PACK_BADGE}>{t('studio.taxes.fromPack')}</Badge>
                      )}
                      {fromPack && mine && (
                        <Badge bg="warning-subtle" text="warning-emphasis">
                          {t('studio.taxes.changed')}
                        </Badge>
                      )}
                    </td>
                    <td className="text-end text-nowrap">
                      {editable && (
                        <Button
                          size="sm"
                          variant="outline-primary"
                          className="me-1"
                          title={t('common.edit')}
                          onClick={() => setEditing({ item: r, locked: true })}
                        >
                          <i className="bi bi-pencil" />
                        </Button>
                      )}
                      {editable && mine && (
                        <Button
                          size="sm"
                          variant="outline-danger"
                          title={fromPack ? t('studio.taxes.revert') : t('common.delete')}
                          onClick={() =>
                            window.confirm(t('common.confirm')) && deleteIdentifier.mutate(r.key)
                          }
                        >
                          <i
                            className={`bi ${fromPack ? 'bi-arrow-counterclockwise' : 'bi-trash'}`}
                          />
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card.Body>
      {editing && (
        <IdentifierDialog
          initial={editing.item}
          locked={editing.locked}
          taken={rows.map((r) => r.key)}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

/** Tax data and identifier types: usually from a Country Pack, adjusted by the company. */
export function TaxesTab() {
  const { t } = useTranslation();
  const { scope } = useStudio();
  if (scope !== 'company') return <Alert variant="info">{t('studio.taxes.companyOnly')}</Alert>;
  return (
    <>
      <TaxSetupCard />
      <IdentifierTypesCard />
    </>
  );
}
