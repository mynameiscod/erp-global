import { Dropdown } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { UI_LANGUAGES } from '@erp/contracts';

export function LanguageSwitcher({ variant = 'outline-secondary' }: { variant?: string }) {
  const { i18n, t } = useTranslation();
  const current = UI_LANGUAGES.find((l) => l.code === i18n.language) ?? UI_LANGUAGES[0];
  return (
    <Dropdown align="end">
      <Dropdown.Toggle variant={variant} size="sm" aria-label={t('common.language')}>
        <i className="bi bi-translate me-1" />
        {current.name}
      </Dropdown.Toggle>
      <Dropdown.Menu>
        {UI_LANGUAGES.map((l) => (
          <Dropdown.Item
            key={l.code}
            active={l.code === i18n.language}
            onClick={() => void i18n.changeLanguage(l.code)}
            lang={l.code}
            dir={l.dir}
          >
            {l.name}
          </Dropdown.Item>
        ))}
      </Dropdown.Menu>
    </Dropdown>
  );
}
