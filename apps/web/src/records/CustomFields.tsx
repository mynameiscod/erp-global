import { useTranslation } from 'react-i18next';
import { activeFields, findEntity } from '@erp/metadata';
import { ApiError } from '../api/client';
import { useEffectiveConfig } from '../config/hooks';
import { DynamicFields, type Values } from './DynamicFields';

/** Field errors from a server response for built-in entities (`custom.<field>` paths). */
export function customFieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError)) return {};
  return Object.fromEntries(
    Object.entries(e.fieldErrors())
      .filter(([k]) => k.startsWith('custom.'))
      .map(([k, v]) => [k.slice('custom.'.length), v]),
  );
}

/**
 * Custom fields a company added to a built-in entity (users, org units),
 * rendered with the same components as custom entities. Renders nothing when
 * no fields are configured.
 */
export function CustomFields({
  entityKey,
  values,
  errors,
  onChange,
  orgUnitId,
}: {
  entityKey: 'user' | 'org_unit';
  values: Values;
  errors: Record<string, string>;
  onChange: (values: Values) => void;
  orgUnitId?: string;
}) {
  const { t } = useTranslation();
  const cfg = useEffectiveConfig(orgUnitId);
  const entity = cfg.data ? findEntity(cfg.data, entityKey) : undefined;
  if (!cfg.data || !entity || activeFields(entity).length === 0) return null;
  return (
    <div className="mt-2">
      <h3 className="h6 text-body-secondary border-bottom pb-1">{t('records.customFields')}</h3>
      <DynamicFields
        entity={entity}
        cfg={cfg.data}
        currency={cfg.data.tenant.currency}
        values={values}
        errors={errors}
        onChange={(k, v) => onChange({ ...values, [k]: v })}
        idPrefix={`cf-${entityKey}`}
        showSectionTitles={false}
      />
    </div>
  );
}
