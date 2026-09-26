import type {
  FieldDef,
  PackManifest,
  PrintTemplateDef,
  ReportDef,
  ReportFilter,
  TaxCategory,
} from '@erp/metadata';
import { ROLES } from './conventions';

/**
 * India Country Pack: GST, identifiers, states, holidays and GST documents and returns.
 * Rates follow the GST rate structure in force from 22 September 2025 (5%, 18%, 40%, with
 * the special 0.25% and 3% rates); the former 12% and 28% slabs stay available for credit
 * notes against older invoices. Every rate is data a company can change in the Studio.
 */

/** GST state codes (the first two digits of a GSTIN) and names. */
export const IN_STATES: [string, string][] = [
  ['01', 'Jammu and Kashmir'],
  ['02', 'Himachal Pradesh'],
  ['03', 'Punjab'],
  ['04', 'Chandigarh'],
  ['05', 'Uttarakhand'],
  ['06', 'Haryana'],
  ['07', 'Delhi'],
  ['08', 'Rajasthan'],
  ['09', 'Uttar Pradesh'],
  ['10', 'Bihar'],
  ['11', 'Sikkim'],
  ['12', 'Arunachal Pradesh'],
  ['13', 'Nagaland'],
  ['14', 'Manipur'],
  ['15', 'Mizoram'],
  ['16', 'Tripura'],
  ['17', 'Meghalaya'],
  ['18', 'Assam'],
  ['19', 'West Bengal'],
  ['20', 'Jharkhand'],
  ['21', 'Odisha'],
  ['22', 'Chhattisgarh'],
  ['23', 'Madhya Pradesh'],
  ['24', 'Gujarat'],
  ['26', 'Dadra and Nagar Haveli and Daman and Diu'],
  ['27', 'Maharashtra'],
  ['29', 'Karnataka'],
  ['30', 'Goa'],
  ['31', 'Lakshadweep'],
  ['32', 'Kerala'],
  ['33', 'Tamil Nadu'],
  ['34', 'Puducherry'],
  ['35', 'Andaman and Nicobar Islands'],
  ['36', 'Telangana'],
  ['37', 'Andhra Pradesh'],
  ['38', 'Ladakh'],
  ['97', 'Other Territory'],
];

const pct = (n: number) => String(n).replace('.', '_');

const CATEGORIES: TaxCategory[] = [
  { key: 'gst_exempt', label: { en: 'Exempt', hi: 'छूट प्राप्त' }, rate: 0, kind: 'exempt' },
  { key: 'gst_nil', label: { en: 'Nil rated (0%)', hi: 'शून्य दर' }, rate: 0, kind: 'nil' },
  {
    key: 'gst_non_gst',
    label: { en: 'Non-GST supply', hi: 'गैर-जीएसटी' },
    rate: 0,
    kind: 'non_taxable',
  },
  ...[0.25, 3, 5, 18, 40].map((r) => ({
    key: `gst_${pct(r)}`,
    label: { en: `GST ${r}%`, hi: `जीएसटी ${r}%` },
    rate: r,
  })),
  ...[12, 28].map((r) => ({
    key: `gst_${r}`,
    label: { en: `GST ${r}% (before 22 Sep 2025)`, hi: `जीएसटी ${r}% (22 सितंबर 2025 से पहले)` },
    rate: r,
  })),
];

const SALES_FIELDS: FieldDef[] = [
  {
    key: 'customer_gstin',
    type: 'text',
    label: { en: 'Customer GSTIN', hi: 'ग्राहक जीएसटीआईएन' },
    identifier: 'in_gstin',
    defaultFrom: 'customer.gstin',
  },
  {
    key: 'place_of_supply',
    type: 'select',
    picklist: 'in_states',
    label: { en: 'Place of supply', hi: 'आपूर्ति का स्थान' },
    defaultFrom: 'customer.state',
  },
  {
    key: 'buyer_country',
    type: 'text',
    label: { en: 'Buyer country', hi: 'खरीदार का देश' },
    pattern: '^[A-Z]{2}$',
    defaultFrom: 'customer.country_code',
  },
  {
    key: 'reverse_charge',
    type: 'boolean',
    label: { en: 'Reverse charge', hi: 'रिवर्स चार्ज' },
  },
  {
    key: 'gst_section',
    type: 'formula',
    label: { en: 'GSTR-1 section', hi: 'जीएसटीआर-1 खंड' },
    resultType: 'text',
    // B2C large: inter-state supplies to unregistered buyers above ₹1,00,000 per invoice.
    formula:
      'IF(tax_rule = "export", "EXP", IF(customer_gstin != "", "B2B", IF(AND(tax_rule = "inter", grand_total > 100000), "B2CL", "B2CS")))',
  },
];

const LINE_COLUMNS: FieldDef[] = [
  {
    key: 'hsn',
    type: 'text',
    label: { en: 'HSN/SAC' },
    pattern: '^[0-9]{4,8}$',
    defaultFrom: 'item.hsn',
  },
  {
    key: 'tax_category',
    type: 'select',
    picklist: 'in_gst_categories',
    label: { en: 'GST', hi: 'जीएसटी' },
    defaultFrom: 'item.gst_category',
  },
];

const TAX = {
  category: 'tax_category',
  code: 'hsn',
  sellerRegion: 'unit.state',
  buyerRegion: 'place_of_supply',
  buyerCountry: 'buyer_country',
  buyerRegistered: 'customer_gstin',
  reverseCharge: 'reverse_charge',
};

function gstDocument(
  key: string,
  title: { en: string; hi: string },
  bill: boolean,
): PrintTemplateDef {
  return {
    key,
    entity: '$entity',
    label: { en: `${title.en} (GST)`, hi: `${title.hi} (जीएसटी)` },
    page: { size: 'A4' },
    mode: 'blocks',
    copies: [
      { en: 'Original for recipient', hi: 'प्राप्तकर्ता के लिए मूल' },
      { en: 'Duplicate for supplier', hi: 'आपूर्तिकर्ता के लिए प्रतिलिपि' },
    ],
    footer: { pageNumbers: true },
    fileName: `${title.en.replace(/\s+/g, '')}-{{number}}`,
    blocks: [
      {
        id: 'head',
        type: 'letterhead',
        lines: [
          { en: '{{company.name}}' },
          { en: '{{unit.address}}' },
          { en: 'GSTIN {{unit.gstin}} · State code {{unit.state}}' },
        ],
      },
      { id: 'title', type: 'title', text: title, condition: bill ? 'tax_total > 0' : undefined },
      ...(bill
        ? [
            {
              id: 'bos',
              type: 'title' as const,
              text: { en: 'Bill of Supply', hi: 'आपूर्ति का बिल' },
              condition: 'tax_total = 0',
            },
          ]
        : []),
      {
        id: 'parties',
        type: 'fields',
        columns: 2,
        items: [
          { path: 'number' },
          { path: 'date' },
          { path: 'customer.name', label: { en: 'Bill to', hi: 'बिल प्राप्तकर्ता' } },
          { path: 'customer_gstin' },
          { path: 'place_of_supply' },
          { path: 'reverse_charge' },
        ],
      },
      {
        id: 'lines',
        type: 'table',
        source: '$lines',
        numbered: true,
        columns: [
          { path: 'item', width: 30 },
          { path: 'hsn' },
          { path: 'qty', format: 'number' },
          { path: 'rate', format: 'currency' },
          { path: 'taxable_value', format: 'currency' },
          { path: 'tax_rate' },
          { path: 'tax_amount', format: 'currency' },
        ],
        totals: ['taxable_value', 'tax_amount'],
      },
      {
        id: 'taxes',
        type: 'table',
        source: 'tax_summary',
        columns: [
          { path: 'component' },
          { path: 'rate' },
          { path: 'taxable', format: 'currency' },
          { path: 'amount', format: 'currency' },
        ],
        totals: ['amount'],
        condition: 'tax_total > 0',
      },
      {
        id: 'totals',
        type: 'totals',
        rows: [
          { label: { en: 'Taxable value', hi: 'कर योग्य मूल्य' }, value: 'subtotal' },
          { label: { en: 'Tax', hi: 'कर' }, value: 'tax_total' },
          { label: { en: 'Round off', hi: 'पूर्णांकन' }, value: 'round_off' },
          { label: { en: 'Total', hi: 'कुल' }, value: 'grand_total', bold: true },
        ],
        words: { value: 'grand_total', label: { en: 'Amount in words:', hi: 'राशि शब्दों में:' } },
      },
      {
        id: 'rcm',
        type: 'text',
        text: { en: 'Tax is payable on reverse charge.', hi: 'कर रिवर्स चार्ज पर देय है।' },
        condition: 'reverse_charge',
      },
      {
        id: 'decl',
        type: 'text',
        size: 8,
        text: {
          en: 'Declaration: we declare that this document shows the actual price of the goods or services described and that all particulars are true and correct.',
          hi: 'घोषणा: हम घोषणा करते हैं कि यह दस्तावेज़ वर्णित वस्तुओं या सेवाओं का वास्तविक मूल्य दर्शाता है और सभी विवरण सत्य और सही हैं।',
        },
      },
      {
        id: 'sign',
        type: 'signature',
        name: { en: 'For {{company.name}}', hi: '{{company.name}} के लिए' },
        title: { en: 'Authorised signatory', hi: 'अधिकृत हस्ताक्षरकर्ता' },
      },
    ],
  };
}

const lastMonth: ReportFilter = {
  path: 'date',
  op: 'relative',
  relative: { period: 'last_month' as const },
  prompt: true,
};
const report = (r: Omit<ReportDef, 'entity'>): ReportDef => ({
  ...r,
  entity: '$entity',
  dateField: 'date',
});

const SALES_REPORTS: ReportDef[] = [
  report({
    key: 'gstr1_b2b',
    label: { en: 'GSTR-1 B2B invoices ($entity)', hi: 'जीएसटीआर-1 बी2बी ($entity)' },
    columns: [
      { path: 'customer_gstin' },
      { path: 'customer.name' },
      { path: 'number' },
      { path: 'date' },
      { path: 'place_of_supply' },
      { path: 'reverse_charge' },
      { path: 'subtotal' },
      { path: 'tax_total' },
      { path: 'grand_total' },
    ],
    filters: [{ path: 'gst_section', op: 'eq', value: 'B2B' }, lastMonth],
    sort: [{ path: 'date', dir: 'asc' }],
  }),
  report({
    key: 'gstr1_b2cl',
    label: { en: 'GSTR-1 B2C large ($entity)', hi: 'जीएसटीआर-1 बी2सी बड़े ($entity)' },
    columns: [
      { path: 'number' },
      { path: 'date' },
      { path: 'place_of_supply' },
      { path: 'subtotal' },
      { path: 'tax_total' },
      { path: 'grand_total' },
    ],
    filters: [{ path: 'gst_section', op: 'eq', value: 'B2CL' }, lastMonth],
    sort: [{ path: 'date', dir: 'asc' }],
  }),
  report({
    key: 'gstr1_b2cs',
    label: { en: 'GSTR-1 B2C small ($entity)', hi: 'जीएसटीआर-1 बी2सी छोटे ($entity)' },
    lines: '$lines',
    columns: [],
    filters: [{ path: 'gst_section', op: 'eq', value: 'B2CS' }, lastMonth],
    groupBy: [{ path: 'place_of_supply' }, { path: '$lines.tax_rate' }],
    aggregates: [
      { fn: 'sum', path: '$lines.taxable_value', label: { en: 'Taxable value' } },
      { fn: 'sum', path: '$lines.tax_amount', label: { en: 'Tax' } },
    ],
  }),
  report({
    key: 'gstr1_exp',
    label: { en: 'GSTR-1 exports ($entity)', hi: 'जीएसटीआर-1 निर्यात ($entity)' },
    columns: [
      { path: 'number' },
      { path: 'date' },
      { path: 'customer.name' },
      { path: 'buyer_country' },
      { path: 'grand_total' },
    ],
    filters: [{ path: 'gst_section', op: 'eq', value: 'EXP' }, lastMonth],
  }),
  report({
    key: 'gstr1_hsn',
    label: { en: 'GSTR-1 HSN summary ($entity)', hi: 'जीएसटीआर-1 एचएसएन सारांश ($entity)' },
    lines: '$lines',
    columns: [],
    filters: [lastMonth],
    groupBy: [{ path: '$lines.hsn' }, { path: '$lines.tax_rate' }, { path: 'tax_rule' }],
    aggregates: [
      { fn: 'sum', path: '$lines.qty', label: { en: 'Quantity' } },
      { fn: 'sum', path: '$lines.taxable_value', label: { en: 'Taxable value' } },
      { fn: 'sum', path: '$lines.tax_amount', label: { en: 'Tax' } },
    ],
  }),
  report({
    key: 'gstr3b_outward',
    label: { en: 'GSTR-3B outward supplies ($entity)', hi: 'जीएसटीआर-3बी बाहरी आपूर्ति ($entity)' },
    lines: '$lines',
    columns: [],
    filters: [lastMonth],
    groupBy: [{ path: 'tax_rule' }, { path: '$lines.tax_rate' }],
    aggregates: [
      { fn: 'sum', path: '$lines.taxable_value', label: { en: 'Taxable value' } },
      { fn: 'sum', path: '$lines.tax_amount', label: { en: 'Tax' } },
    ],
  }),
  report({
    key: 'gstr3b_unregistered',
    label: {
      en: 'GSTR-3B inter-state to unregistered ($entity)',
      hi: 'जीएसटीआर-3बी अपंजीकृत को अंतर-राज्य ($entity)',
    },
    lines: '$lines',
    columns: [],
    filters: [
      { path: 'customer_gstin', op: 'empty' },
      { path: 'tax_rule', op: 'eq', value: 'inter' },
      lastMonth,
    ],
    groupBy: [{ path: 'place_of_supply' }],
    aggregates: [
      { fn: 'sum', path: '$lines.taxable_value', label: { en: 'Taxable value' } },
      { fn: 'sum', path: '$lines.tax_amount', label: { en: 'IGST' } },
    ],
  }),
];

const CREDIT_REPORTS: ReportDef[] = [
  report({
    key: 'gstr1_cdn',
    label: { en: 'GSTR-1 credit notes ($entity)', hi: 'जीएसटीआर-1 क्रेडिट नोट ($entity)' },
    columns: [
      { path: 'customer_gstin' },
      { path: 'number' },
      { path: 'date' },
      { path: 'place_of_supply' },
      { path: 'subtotal' },
      { path: 'tax_total' },
      { path: 'grand_total' },
    ],
    filters: [lastMonth],
  }),
];

const holidays = (year: number) => [
  { date: `${year}-01-26`, label: { en: 'Republic Day', hi: 'गणतंत्र दिवस' } },
  { date: `${year}-08-15`, label: { en: 'Independence Day', hi: 'स्वतंत्रता दिवस' } },
  { date: `${year}-10-02`, label: { en: 'Gandhi Jayanti', hi: 'गांधी जयंती' } },
];

export const INDIA: PackManifest = {
  id: 'country.in',
  type: 'country',
  version: '1.0.0',
  name: { en: 'India', hi: 'भारत' },
  description: {
    en: 'GST (CGST, SGST, IGST) with place of supply, GSTIN and PAN validation, states, GST invoices and credit notes, GSTR-1 and GSTR-3B summaries, Indian financial year and national holidays.',
    hi: 'जीएसटी (सीजीएसटी, एसजीएसटी, आईजीएसटी), जीएसटीआईएन और पैन जाँच, राज्य, जीएसटी चालान, जीएसटीआर-1 और जीएसटीआर-3बी सारांश, भारतीय वित्तीय वर्ष और राष्ट्रीय अवकाश।',
  },
  suggestFor: ['IN'],
  uses: ['tax'],
  layer: {
    settings: { fiscalYearStartMonth: 4 },
    identifierTypes: [
      {
        key: 'in_gstin',
        label: { en: 'GSTIN', hi: 'जीएसटीआईएन' },
        pattern: '[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]',
        checksum: 'luhn_mod36',
        uppercase: true,
        example: '36AABCU9603R1ZO',
      },
      {
        key: 'in_pan',
        label: { en: 'PAN', hi: 'पैन' },
        pattern: '[A-Z]{5}[0-9]{4}[A-Z]',
        uppercase: true,
        example: 'AABCU9603R',
      },
      {
        key: 'in_pincode',
        label: { en: 'PIN code', hi: 'पिन कोड' },
        pattern: '[1-9][0-9]{5}',
        example: '500081',
      },
    ],
    picklists: [
      {
        key: 'in_states',
        label: { en: 'States and union territories', hi: 'राज्य और केंद्र शासित प्रदेश' },
        options: IN_STATES.map(([value, name]) => ({ value, label: { en: `${name} (${value})` } })),
      },
      {
        key: 'in_gst_categories',
        label: { en: 'GST rates', hi: 'जीएसटी दरें' },
        options: CATEGORIES.map((c) => ({ value: c.key, label: c.label })),
      },
    ],
    taxes: {
      components: [
        { key: 'cgst', label: { en: 'CGST', hi: 'सीजीएसटी' } },
        { key: 'sgst', label: { en: 'SGST/UTGST', hi: 'एसजीएसटी/यूटीजीएसटी' } },
        { key: 'igst', label: { en: 'IGST', hi: 'आईजीएसटी' } },
        { key: 'cess', label: { en: 'Compensation cess', hi: 'क्षतिपूर्ति उपकर' } },
      ],
      categories: CATEGORIES,
      rules: [
        {
          key: 'export',
          label: { en: 'Export (zero rated)', hi: 'निर्यात (शून्य दर)' },
          condition: 'buyer_country != "" && buyer_country != company_country',
          split: [],
          zero: true,
        },
        {
          key: 'intra',
          label: {
            en: 'Within the state (CGST + SGST)',
            hi: 'राज्य के भीतर (सीजीएसटी + एसजीएसटी)',
          },
          condition: 'buyer_region = "" || seller_region = "" || seller_region = buyer_region',
          split: [
            { component: 'cgst', share: 0.5 },
            { component: 'sgst', share: 0.5 },
          ],
        },
        {
          key: 'inter',
          label: { en: 'Between states (IGST)', hi: 'राज्यों के बीच (आईजीएसटी)' },
          split: [{ component: 'igst', share: 1 }],
        },
      ],
      defaultCategory: 'gst_18',
      roundTotal: true,
    },
    calendar: {
      weekend: [0],
      hours: { start: '09:00', end: '18:00' },
      holidays: [...holidays(2026), ...holidays(2027)],
    },
    entities: [
      {
        key: 'org_unit',
        // Each branch's GST registration, printed on its documents.
        fields: [
          {
            key: 'gstin',
            type: 'text',
            label: { en: 'GSTIN', hi: 'जीएसटीआईएन' },
            identifier: 'in_gstin',
            locked: true,
          },
          { key: 'pan', type: 'text', label: { en: 'PAN', hi: 'पैन' }, identifier: 'in_pan' },
          {
            key: 'state',
            type: 'select',
            picklist: 'in_states',
            label: { en: 'State', hi: 'राज्य' },
            locked: true,
          },
          { key: 'address', type: 'longtext', label: { en: 'Address', hi: 'पता' } },
          {
            key: 'pincode',
            type: 'text',
            label: { en: 'PIN code', hi: 'पिन कोड' },
            identifier: 'in_pincode',
          },
        ],
      },
    ],
    rules: [],
  },
  patches: [
    {
      role: ROLES.customer,
      fields: [
        {
          key: 'gstin',
          type: 'text',
          label: { en: 'GSTIN', hi: 'जीएसटीआईएन' },
          identifier: 'in_gstin',
        },
        {
          key: 'state',
          type: 'select',
          picklist: 'in_states',
          label: { en: 'State', hi: 'राज्य' },
        },
        {
          key: 'country_code',
          type: 'text',
          label: { en: 'Country code (if abroad)', hi: 'देश कोड (विदेश में हो तो)' },
          pattern: '^[A-Z]{2}$',
        },
      ],
      // A GSTIN starts with the state code.
      rules: [
        {
          key: 'in_gstin_state',
          entity: '$entity',
          on: 'save',
          condition: 'gstin != "" && state != "" && LEFT(gstin, 2) != state',
          effect: 'block',
          message: {
            en: 'The GSTIN does not belong to the chosen state',
            hi: 'जीएसटीआईएन चुने गए राज्य का नहीं है',
          },
        },
      ],
    },
    {
      role: ROLES.item,
      fields: [
        {
          key: 'hsn',
          type: 'text',
          label: { en: 'HSN/SAC code', hi: 'एचएसएन/एसएसी कोड' },
          pattern: '^[0-9]{4,8}$',
        },
        {
          key: 'gst_category',
          type: 'select',
          picklist: 'in_gst_categories',
          label: { en: 'GST rate', hi: 'जीएसटी दर' },
        },
      ],
    },
    {
      // Education fees and similar supplies: exempt unless the company says otherwise.
      role: ROLES.taxExempt,
      fields: [
        {
          key: 'gst_category',
          type: 'select',
          picklist: 'in_gst_categories',
          label: { en: 'GST rate', hi: 'जीएसटी दर' },
          default: 'gst_exempt',
        },
      ],
    },
    {
      role: ROLES.salesInvoice,
      fields: SALES_FIELDS.map((f) => ({
        ...f,
        locked: f.key === 'customer_gstin' || f.key === 'place_of_supply',
      })),
      lineColumns: LINE_COLUMNS,
      tax: TAX,
      printTemplates: [gstDocument('gst_invoice', { en: 'Tax Invoice', hi: 'कर चालान' }, true)],
      reports: SALES_REPORTS,
    },
    {
      role: ROLES.creditNote,
      fields: SALES_FIELDS.filter((f) => f.key !== 'gst_section'),
      lineColumns: LINE_COLUMNS,
      tax: TAX,
      printTemplates: [
        gstDocument('gst_credit_note', { en: 'Credit Note', hi: 'क्रेडिट नोट' }, false),
      ],
      reports: CREDIT_REPORTS,
    },
  ],
};
