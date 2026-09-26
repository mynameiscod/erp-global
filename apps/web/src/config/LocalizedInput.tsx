import { useState } from 'react';
import { Button, Form, InputGroup } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { UI_LANGUAGES } from '@erp/contracts';
import type { LocalizedText } from '@erp/metadata';

/**
 * Edits one text in several languages. The first language is always shown;
 * the others expand on request, so simple setups stay simple.
 */
const RTL = new Set(['ar', 'he', 'fa', 'ur']);

export function LocalizedInput({
  value,
  onChange,
  id,
  invalid,
  extra,
  multiline,
}: {
  value: LocalizedText | undefined;
  onChange: (v: LocalizedText) => void;
  id: string;
  invalid?: boolean;
  /** More languages than the app's own, e.g. those a print template uses (te, ta…). */
  extra?: string[];
  multiline?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(() => Object.keys(value ?? {}).length > 1);
  const languages: { code: string; dir: string }[] = [
    ...UI_LANGUAGES,
    ...(extra ?? [])
      .filter((c) => !UI_LANGUAGES.some((l) => l.code === c))
      .map((code) => ({ code, dir: RTL.has(code.split('-')[0]) ? 'rtl' : 'ltr' })),
  ];
  const primary = languages.find((l) => l.code === i18n.language) ?? languages[0];
  const others = languages.filter((l) => l.code !== primary.code);
  const set = (lang: string, text: string) => {
    const next = { ...(value ?? {}) };
    if (text) next[lang] = text;
    else delete next[lang];
    onChange(next);
  };
  const row = (l: { code: string; dir: string }, first: boolean) => (
    <InputGroup key={l.code} className={first ? '' : 'mt-1'} size={first ? undefined : 'sm'}>
      <InputGroup.Text style={{ minWidth: 48 }} className="justify-content-center">
        {l.code.toUpperCase()}
      </InputGroup.Text>
      <Form.Control
        id={first ? id : `${id}-${l.code}`}
        {...(multiline ? { as: 'textarea' as const, rows: 2 } : {})}
        dir={l.dir}
        lang={l.code}
        value={value?.[l.code] ?? ''}
        isInvalid={first && invalid}
        onChange={(e) => set(l.code, e.target.value)}
      />
    </InputGroup>
  );
  return (
    <div>
      {row(primary, true)}
      {open ? (
        others.map((l) => row(l, false))
      ) : (
        <Button variant="link" size="sm" className="px-0" onClick={() => setOpen(true)}>
          <i className="bi bi-translate me-1" />
          {t('studio.labelsIn')}
        </Button>
      )}
    </div>
  );
}
