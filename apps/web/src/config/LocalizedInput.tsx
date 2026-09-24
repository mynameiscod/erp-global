import { useState } from 'react';
import { Button, Form, InputGroup } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { UI_LANGUAGES } from '@erp/contracts';
import type { LocalizedText } from '@erp/metadata';

/**
 * Edits one text in several languages. The first language is always shown;
 * the others expand on request, so simple setups stay simple.
 */
export function LocalizedInput({
  value,
  onChange,
  id,
  invalid,
}: {
  value: LocalizedText | undefined;
  onChange: (v: LocalizedText) => void;
  id: string;
  invalid?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(() => Object.keys(value ?? {}).length > 1);
  const primary = UI_LANGUAGES.find((l) => l.code === i18n.language) ?? UI_LANGUAGES[0];
  const others = UI_LANGUAGES.filter((l) => l.code !== primary.code);
  const set = (lang: string, text: string) => {
    const next = { ...(value ?? {}) };
    if (text) next[lang] = text;
    else delete next[lang];
    onChange(next);
  };
  const row = (l: (typeof UI_LANGUAGES)[number], first: boolean) => (
    <InputGroup key={l.code} className={first ? '' : 'mt-1'} size={first ? undefined : 'sm'}>
      <InputGroup.Text style={{ minWidth: 48 }} className="justify-content-center">
        {l.code.toUpperCase()}
      </InputGroup.Text>
      <Form.Control
        id={first ? id : `${id}-${l.code}`}
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
