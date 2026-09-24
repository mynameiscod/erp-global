import type { ReactNode } from 'react';
import { Card } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { LanguageSwitcher } from './LanguageSwitcher';

export function AuthLayout({
  title,
  subtitle,
  children,
  wide,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="auth-bg min-vh-100 d-flex flex-column">
      <div className="d-flex justify-content-between align-items-center p-3">
        <div className="d-flex align-items-center gap-2">
          <img src="/favicon.svg" alt="" width={32} height={32} />
          <span className="fw-semibold">{t('app.name')}</span>
        </div>
        <LanguageSwitcher variant="light" />
      </div>
      <div className="flex-grow-1 d-flex align-items-center justify-content-center p-3">
        <Card className="shadow-sm border-0 w-100" style={{ maxWidth: wide ? 760 : 440 }}>
          <Card.Body className="p-4 p-md-5">
            <h1 className="h4 mb-1">{title}</h1>
            {subtitle && <p className="text-body-secondary">{subtitle}</p>}
            {children}
          </Card.Body>
        </Card>
      </div>
      <p className="text-center small text-body-secondary pb-3">{t('app.tagline')}</p>
    </div>
  );
}
