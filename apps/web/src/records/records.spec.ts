import { describe, expect, it } from 'vitest';
import { withTaxFields, type EffectiveConfig, type EntityDef, type TaxSetup } from '@erp/metadata';
import type { OrgUnitDto } from '../api/types';
import { defaultFills } from './defaults';
import { editableValues, MORE_SECTION, sectionsFor } from './DynamicFields';
import { browserTaxContext, previewTaxes, unitChain } from './taxPreview';

const gst: TaxSetup = {
  components: [
    { key: 'cgst', label: { en: 'CGST' } },
    { key: 'sgst', label: { en: 'SGST' } },
    { key: 'igst', label: { en: 'IGST' } },
  ],
  categories: [{ key: 'gst_18', label: { en: 'GST 18%' }, rate: 18 }],
  rules: [
    {
      key: 'intra',
      label: { en: 'Within the state' },
      condition: 'seller_region = buyer_region',
      split: [
        { component: 'cgst', share: 0.5 },
        { component: 'sgst', share: 0.5 },
      ],
    },
    { key: 'inter', label: { en: 'Between states' }, split: [{ component: 'igst', share: 1 }] },
  ],
  defaultCategory: 'gst_18',
};

const invoice = withTaxFields<EntityDef>({
  key: 'invoice',
  kind: 'custom',
  label: { en: 'Invoice' },
  pluralLabel: { en: 'Invoices' },
  tax: {
    lines: 'lines',
    amount: 'amount',
    sellerRegion: 'unit.state',
    buyerRegion: 'customer.state',
  },
  fields: [
    { key: 'customer', type: 'lookup', label: { en: 'Customer' }, target: 'customer' },
    { key: 'gstin', type: 'text', label: { en: 'GSTIN' }, identifier: 'gstin' },
    {
      key: 'lines',
      type: 'table',
      label: { en: 'Lines' },
      columns: [
        { key: 'item', type: 'lookup', label: { en: 'Item' }, target: 'item' },
        { key: 'qty', type: 'integer', label: { en: 'Qty' } },
        { key: 'rate', type: 'decimal', label: { en: 'Rate' }, defaultFrom: 'item.price' },
        {
          key: 'amount',
          type: 'formula',
          label: { en: 'Amount' },
          formula: 'qty * rate',
          resultType: 'number',
        },
      ],
    },
  ],
});

const unit = (id: string, path: string, custom?: Record<string, unknown>): OrgUnitDto => ({
  id,
  name: id,
  code: null,
  type: 'branch',
  parentId: null,
  path,
  depth: path.split('/').filter(Boolean).length - 1,
  status: 'active',
  custom,
});

const CUSTOMER = 'a'.repeat(24);
const ITEM = 'b'.repeat(24);

describe('record form', () => {
  it('shows fields the layout does not place in a last section, tax totals apart', () => {
    const cfg = {
      forms: [
        {
          entity: 'invoice',
          sections: [
            { key: 's', label: { en: 'Main' }, columns: 2, fields: ['customer', 'lines'] },
          ],
        },
      ],
    } as unknown as EffectiveConfig;
    const sections = sectionsFor(invoice, cfg);
    expect(sections.map((s) => s.key)).toEqual(['s', MORE_SECTION]);
    expect(sections[1].fields).toEqual(['gstin']);
  });

  it('never sends calculated fields', () => {
    expect(editableValues(invoice, { customer: CUSTOMER, grand_total: 1, subtotal: 2 })).toEqual({
      customer: CUSTOMER,
    });
  });

  it('previews taxes with the regions found in the browser', () => {
    const units = [unit('root', '/root/', { state: '29' }), unit('br', '/root/br/')];
    const linked = new Map([['customer', { state: '29' }]]);
    const values = { customer: CUSTOMER, lines: [{ _id: 'r1', qty: '2', rate: '50' }] };
    const { ctx, unresolved } = browserTaxContext(
      invoice,
      values,
      unitChain(units, 'br'),
      linked,
      'IN',
    );
    expect(unresolved).toBe(false);
    expect(ctx).toMatchObject({ sellerRegion: '29', buyerRegion: '29' });
    const out = previewTaxes(invoice, values, gst, ctx);
    expect(out).toMatchObject({
      subtotal: 100,
      tax_total: 18,
      grand_total: 118,
      tax_rule: 'intra',
    });
    expect((out.lines as Record<string, unknown>[])[0]).toMatchObject({
      _id: 'r1',
      qty: '2',
      taxable_value: 100,
      tax_amount: 18,
    });
    expect(out.tax_summary).toHaveLength(2);

    const other = browserTaxContext(invoice, values, [], new Map(), 'IN');
    expect(other.unresolved).toBe(true);
  });

  it('fills line columns from the chosen item', async () => {
    const prev = { lines: [{ _id: 'r1', qty: 1 }] };
    const next = { lines: [{ _id: 'r1', qty: 1, item: ITEM }] };
    const fills = defaultFills(invoice, prev, next, 'INR');
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ target: 'item', id: ITEM });
    const out = fills[0].apply({ price: { amount: '12.50', currency: 'INR' } }, next);
    expect((out.lines as Record<string, unknown>[])[0].rate).toBe('12.50');
    // A value the user typed is kept.
    const typed = { lines: [{ _id: 'r1', item: ITEM, rate: '9' }] };
    expect(fills[0].apply({ price: '12.50' }, typed)).toBe(typed);
  });
});
