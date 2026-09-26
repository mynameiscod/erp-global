import type {
  DashboardDef,
  EntityPatch,
  FieldDef,
  PackManifest,
  PrintTemplateDef,
  ReportDef,
} from '@erp/metadata';
import { ROLES } from './conventions';

/**
 * Retail Industry Pack: items with barcodes and reorder levels, customers, POS bills
 * with a payment mode, sales returns, an 80 mm receipt and an A4 invoice, daily, item
 * and payment-mode sales, a low-stock alert and a Store manager dashboard.
 *
 * Shelf prices usually include tax, so bills and returns are tax-inclusive. Stock on hand
 * is a plain number on the item until inventory arrives. A Country Pack adds its tax
 * fields (HSN, GST rate, GSTIN…) through the roles the entities declare.
 */

const ITEM = 'rt_item';
const CUSTOMER = 'rt_customer';
const SALE = 'rt_sale';
const RETURN = 'rt_sales_return';

/** Line items shared by bills and returns, in the shape the `sales_invoice` role expects. */
const LINES: FieldDef = {
  key: 'lines',
  type: 'table',
  label: { en: 'Items', hi: 'वस्तुएँ' },
  required: true,
  columns: [
    { key: 'item', type: 'lookup', target: ITEM, label: { en: 'Item', hi: 'वस्तु' } },
    { key: 'qty', type: 'decimal', scale: 3, min: 0, label: { en: 'Qty', hi: 'मात्रा' } },
    {
      key: 'rate',
      type: 'currency',
      label: { en: 'Rate', hi: 'दर' },
      defaultFrom: 'item.price',
    },
    {
      key: 'amount',
      type: 'formula',
      label: { en: 'Amount', hi: 'राशि' },
      formula: 'qty * rate',
      resultType: 'number',
    },
  ],
};

const TAX = { lines: 'lines', amount: 'amount', inclusive: true } as const;

const ENTITIES: EntityPatch[] = [
  {
    key: ITEM,
    kind: 'custom',
    label: { en: 'Item', hi: 'वस्तु' },
    pluralLabel: { en: 'Items', hi: 'वस्तुएँ' },
    icon: 'upc-scan',
    titleField: 'name',
    orgScoped: false,
    roles: [ROLES.item],
    fields: [
      {
        key: 'name',
        type: 'text',
        label: { en: 'Name', hi: 'नाम' },
        required: true,
        searchable: true,
        maxLength: 120,
      },
      {
        key: 'barcode',
        type: 'text',
        label: { en: 'Barcode', hi: 'बारकोड' },
        unique: true,
        searchable: true,
        pattern: '^[0-9A-Za-z-]{4,32}$',
      },
      {
        key: 'sku',
        type: 'text',
        label: { en: 'SKU', hi: 'एसकेयू' },
        unique: true,
        searchable: true,
        maxLength: 40,
      },
      {
        key: 'category',
        type: 'select',
        picklist: 'rt_item_categories',
        label: { en: 'Category', hi: 'श्रेणी' },
      },
      {
        key: 'unit',
        type: 'select',
        picklist: 'rt_units',
        label: { en: 'Unit', hi: 'इकाई' },
        default: 'pcs',
      },
      {
        key: 'price',
        type: 'currency',
        label: { en: 'Selling price', hi: 'बिक्री मूल्य' },
        help: { en: 'Including tax', hi: 'कर सहित' },
        required: true,
        min: 0,
      },
      { key: 'mrp', type: 'currency', label: { en: 'MRP', hi: 'एमआरपी' }, min: 0 },
      {
        key: 'cost',
        type: 'currency',
        label: { en: 'Purchase cost', hi: 'खरीद लागत' },
        min: 0,
      },
      {
        key: 'stock',
        type: 'decimal',
        scale: 3,
        label: { en: 'Stock on hand', hi: 'उपलब्ध स्टॉक' },
      },
      {
        key: 'reorder_level',
        type: 'decimal',
        scale: 3,
        min: 0,
        label: { en: 'Reorder level', hi: 'पुनः ऑर्डर स्तर' },
      },
      {
        key: 'low_stock',
        type: 'formula',
        label: { en: 'Low stock', hi: 'कम स्टॉक' },
        formula: 'AND(reorder_level > 0, stock < reorder_level)',
        resultType: 'boolean',
      },
      {
        key: 'reorder_contact',
        type: 'lookup',
        target: 'user',
        label: { en: 'Reorder contact', hi: 'पुनः ऑर्डर संपर्क' },
        help: {
          en: 'Told when the item runs low',
          hi: 'स्टॉक कम होने पर सूचना दी जाती है',
        },
      },
      { key: 'active', type: 'boolean', label: { en: 'On sale', hi: 'बिक्री में' }, default: true },
    ],
  },
  {
    key: CUSTOMER,
    kind: 'custom',
    label: { en: 'Customer', hi: 'ग्राहक' },
    pluralLabel: { en: 'Customers', hi: 'ग्राहक' },
    icon: 'person-badge',
    titleField: 'name',
    orgScoped: false,
    roles: [ROLES.customer],
    fields: [
      {
        key: 'name',
        type: 'text',
        label: { en: 'Name', hi: 'नाम' },
        required: true,
        searchable: true,
      },
      {
        key: 'phone',
        type: 'phone',
        label: { en: 'Mobile', hi: 'मोबाइल' },
        unique: true,
        searchable: true,
      },
      { key: 'email', type: 'email', label: { en: 'Email', hi: 'ईमेल' } },
      { key: 'address', type: 'longtext', label: { en: 'Address', hi: 'पता' } },
      {
        key: 'loyalty_points',
        type: 'integer',
        min: 0,
        label: { en: 'Loyalty points', hi: 'लॉयल्टी अंक' },
      },
    ],
  },
  {
    key: SALE,
    kind: 'custom',
    label: { en: 'Sale', hi: 'बिक्री' },
    pluralLabel: { en: 'Sales', hi: 'बिक्री' },
    icon: 'receipt',
    titleField: 'bill_no',
    orgScoped: true,
    roles: [ROLES.salesInvoice],
    tax: { ...TAX, document: 'invoice' },
    fields: [
      {
        key: 'bill_no',
        type: 'autonumber',
        numbering: 'rt_sale',
        label: { en: 'Bill no.', hi: 'बिल संख्या' },
      },
      { key: 'date', type: 'date', label: { en: 'Date', hi: 'दिनांक' }, required: true },
      {
        key: 'customer',
        type: 'lookup',
        target: CUSTOMER,
        label: { en: 'Customer', hi: 'ग्राहक' },
        help: { en: 'Leave empty for a walk-in customer', hi: 'सामान्य ग्राहक के लिए खाली छोड़ें' },
      },
      LINES,
      {
        key: 'payment_mode',
        type: 'select',
        picklist: 'rt_payment_modes',
        label: { en: 'Payment mode', hi: 'भुगतान का तरीका' },
        required: true,
        default: 'cash',
      },
      {
        key: 'payment_ref',
        type: 'text',
        label: { en: 'Payment reference', hi: 'भुगतान संदर्भ' },
        help: { en: 'UPI or card transaction id', hi: 'यूपीआई या कार्ड लेनदेन आईडी' },
      },
      {
        key: 'amount_tendered',
        type: 'currency',
        min: 0,
        label: { en: 'Cash received', hi: 'प्राप्त नकद' },
      },
      {
        key: 'change_due',
        type: 'formula',
        label: { en: 'Change', hi: 'शेष लौटाना' },
        formula: 'IF(amount_tendered > grand_total, amount_tendered - grand_total, 0)',
        resultType: 'number',
      },
      {
        key: 'total_qty',
        type: 'formula',
        label: { en: 'Total quantity', hi: 'कुल मात्रा' },
        formula: 'SUM(lines.qty)',
        resultType: 'number',
      },
    ],
  },
  {
    key: RETURN,
    kind: 'custom',
    label: { en: 'Sales return', hi: 'बिक्री वापसी' },
    pluralLabel: { en: 'Sales returns', hi: 'बिक्री वापसी' },
    icon: 'arrow-return-left',
    titleField: 'return_no',
    orgScoped: true,
    roles: [ROLES.creditNote],
    tax: { ...TAX, document: 'credit_note' },
    fields: [
      {
        key: 'return_no',
        type: 'autonumber',
        numbering: 'rt_sales_return',
        label: { en: 'Return no.', hi: 'वापसी संख्या' },
      },
      { key: 'date', type: 'date', label: { en: 'Date', hi: 'दिनांक' }, required: true },
      {
        key: 'against_sale',
        type: 'lookup',
        target: SALE,
        label: { en: 'Original bill', hi: 'मूल बिल' },
      },
      {
        key: 'customer',
        type: 'lookup',
        target: CUSTOMER,
        label: { en: 'Customer', hi: 'ग्राहक' },
      },
      LINES,
      {
        key: 'reason',
        type: 'select',
        picklist: 'rt_return_reasons',
        label: { en: 'Reason', hi: 'कारण' },
        required: true,
      },
      {
        key: 'refund_mode',
        type: 'select',
        picklist: 'rt_payment_modes',
        label: { en: 'Refund mode', hi: 'धनवापसी का तरीका' },
        default: 'cash',
      },
      { key: 'notes', type: 'longtext', label: { en: 'Notes', hi: 'टिप्पणी' } },
    ],
  },
];

const PICKLISTS = [
  {
    key: 'rt_payment_modes',
    label: { en: 'Payment modes', hi: 'भुगतान के तरीके' },
    options: [
      { value: 'cash', label: { en: 'Cash', hi: 'नकद' } },
      { value: 'upi', label: { en: 'UPI', hi: 'यूपीआई' } },
      { value: 'card', label: { en: 'Card', hi: 'कार्ड' } },
      { value: 'wallet', label: { en: 'Wallet', hi: 'वॉलेट' } },
      { value: 'credit', label: { en: 'On account', hi: 'उधार' } },
    ],
  },
  {
    key: 'rt_item_categories',
    label: { en: 'Item categories', hi: 'वस्तु श्रेणियाँ' },
    options: [
      { value: 'grocery', label: { en: 'Grocery', hi: 'किराना' } },
      { value: 'personal_care', label: { en: 'Personal care', hi: 'व्यक्तिगत देखभाल' } },
      { value: 'household', label: { en: 'Household', hi: 'घरेलू सामान' } },
      { value: 'stationery', label: { en: 'Stationery', hi: 'लेखन सामग्री' } },
      { value: 'apparel', label: { en: 'Apparel', hi: 'परिधान' } },
      { value: 'electronics', label: { en: 'Electronics', hi: 'इलेक्ट्रॉनिक्स' } },
      { value: 'other', label: { en: 'Other', hi: 'अन्य' } },
    ],
  },
  {
    key: 'rt_units',
    label: { en: 'Units', hi: 'इकाइयाँ' },
    options: [
      { value: 'pcs', label: { en: 'Pieces', hi: 'नग' } },
      { value: 'kg', label: { en: 'Kilogram', hi: 'किलोग्राम' } },
      { value: 'g', label: { en: 'Gram', hi: 'ग्राम' } },
      { value: 'l', label: { en: 'Litre', hi: 'लीटर' } },
      { value: 'ml', label: { en: 'Millilitre', hi: 'मिलीलीटर' } },
      { value: 'pack', label: { en: 'Pack', hi: 'पैक' } },
      { value: 'box', label: { en: 'Box', hi: 'डिब्बा' } },
    ],
  },
  {
    key: 'rt_return_reasons',
    label: { en: 'Return reasons', hi: 'वापसी के कारण' },
    options: [
      { value: 'damaged', label: { en: 'Damaged or defective', hi: 'क्षतिग्रस्त या खराब' } },
      { value: 'expired', label: { en: 'Expired', hi: 'समाप्त' } },
      { value: 'wrong_item', label: { en: 'Wrong item', hi: 'गलत वस्तु' } },
      { value: 'size', label: { en: 'Size or fit', hi: 'आकार' } },
      { value: 'not_needed', label: { en: 'No longer needed', hi: 'अब आवश्यक नहीं' } },
      { value: 'other', label: { en: 'Other', hi: 'अन्य' } },
    ],
  },
];

// ---- documents ----

const letterhead = {
  id: 'head',
  type: 'letterhead' as const,
  logoPosition: 'center' as const,
  lines: [{ en: '{{company.name}}' }, { en: '{{unit.name}}' }, { en: '{{unit.address}}' }],
};

const posReceipt = (
  key: string,
  entity: string,
  title: { en: string; hi: string },
  party: { path: string; label: { en: string; hi: string } }[],
  cash: boolean,
): PrintTemplateDef => ({
  key,
  entity,
  label: { en: `${title.en} (80 mm)`, hi: `${title.hi} (80 मिमी)` },
  page: { size: 'thermal80', margin: 3 },
  fontSize: 8,
  mode: 'blocks',
  fileName: `${title.en.replace(/\s+/g, '')}-{{number}}`,
  blocks: [
    letterhead,
    { id: 'title', type: 'title', text: title, align: 'center', size: 11 },
    {
      id: 'info',
      type: 'fields',
      columns: 1,
      items: [{ path: 'number' }, { path: 'date' }, ...party],
    },
    { id: 'd1', type: 'divider' },
    {
      id: 'lines',
      type: 'table',
      source: 'lines',
      columns: [
        { path: 'item', width: 50 },
        { path: 'qty', format: 'number', align: 'right' },
        { path: 'rate', format: 'currency', align: 'right' },
        { path: 'amount', format: 'currency', align: 'right' },
      ],
    },
    { id: 'd2', type: 'divider' },
    {
      id: 'totals',
      type: 'totals',
      rows: [
        { label: { en: 'Total', hi: 'कुल' }, value: 'grand_total', format: 'currency', bold: true },
        {
          label: { en: 'Includes tax', hi: 'कर सम्मिलित' },
          value: 'tax_total',
          format: 'currency',
        },
        ...(cash
          ? [
              {
                label: { en: 'Cash received', hi: 'प्राप्त नकद' },
                value: 'amount_tendered',
                format: 'currency' as const,
              },
              {
                label: { en: 'Change', hi: 'शेष लौटाना' },
                value: 'change_due',
                format: 'currency' as const,
              },
            ]
          : []),
      ],
    },
    { id: 'code', type: 'barcode', value: '{{number}}', height: 10, align: 'center' },
    {
      id: 'thanks',
      type: 'text',
      align: 'center',
      text: cash
        ? { en: 'Thank you! Please visit again.', hi: 'धन्यवाद! फिर पधारें।' }
        : { en: 'Refund processed.', hi: 'धनवापसी की गई।' },
    },
  ],
});

const PRINT_TEMPLATES: PrintTemplateDef[] = [
  posReceipt(
    'rt_pos_receipt',
    SALE,
    { en: 'Receipt', hi: 'रसीद' },
    [
      { path: 'customer.name', label: { en: 'Customer', hi: 'ग्राहक' } },
      { path: 'payment_mode', label: { en: 'Paid by', hi: 'भुगतान' } },
    ],
    true,
  ),
  posReceipt(
    'rt_return_receipt',
    RETURN,
    { en: 'Return receipt', hi: 'वापसी रसीद' },
    [
      { path: 'against_sale', label: { en: 'Original bill', hi: 'मूल बिल' } },
      { path: 'refund_mode', label: { en: 'Refunded by', hi: 'धनवापसी' } },
    ],
    false,
  ),
  {
    key: 'rt_invoice',
    entity: SALE,
    label: { en: 'Invoice (A4)', hi: 'चालान (A4)' },
    page: { size: 'A4' },
    mode: 'blocks',
    footer: { pageNumbers: true },
    fileName: 'Invoice-{{number}}',
    blocks: [
      { ...letterhead, logoPosition: 'left' },
      { id: 'title', type: 'title', text: { en: 'Invoice', hi: 'चालान' } },
      {
        id: 'parties',
        type: 'fields',
        columns: 2,
        items: [
          { path: 'number' },
          { path: 'date' },
          { path: 'customer.name', label: { en: 'Bill to', hi: 'बिल प्राप्तकर्ता' } },
          { path: 'customer.phone' },
          { path: 'payment_mode' },
          { path: 'payment_ref' },
        ],
      },
      {
        id: 'lines',
        type: 'table',
        source: 'lines',
        numbered: true,
        columns: [
          { path: 'item', width: 45 },
          { path: 'qty', format: 'number' },
          { path: 'rate', format: 'currency' },
          { path: 'amount', format: 'currency' },
        ],
        totals: ['amount'],
      },
      {
        id: 'totals',
        type: 'totals',
        rows: [
          { label: { en: 'Value before tax', hi: 'कर से पहले मूल्य' }, value: 'subtotal' },
          { label: { en: 'Tax', hi: 'कर' }, value: 'tax_total' },
          { label: { en: 'Round off', hi: 'पूर्णांकन' }, value: 'round_off' },
          { label: { en: 'Total', hi: 'कुल' }, value: 'grand_total', bold: true },
        ],
        words: { value: 'grand_total', label: { en: 'Amount in words:', hi: 'राशि शब्दों में:' } },
      },
      {
        id: 'note',
        type: 'text',
        size: 8,
        text: {
          en: 'Prices include applicable taxes. Goods once sold are exchanged as per store policy.',
          hi: 'मूल्य में लागू कर शामिल हैं। बेचा गया सामान दुकान की नीति के अनुसार बदला जाता है।',
        },
      },
      {
        id: 'sign',
        type: 'signature',
        name: { en: 'For {{company.name}}', hi: '{{company.name}} के लिए' },
        title: { en: 'Authorised signatory', hi: 'अधिकृत हस्ताक्षरकर्ता' },
      },
    ],
  },
];

// ---- reports and dashboard ----

const MANAGER = 'store_manager';
const CASHIER = 'cashier';

const REPORTS: ReportDef[] = [
  {
    key: 'rt_sales_today',
    label: { en: "Today's sales", hi: 'आज की बिक्री' },
    entity: SALE,
    dateField: 'date',
    columns: [],
    filters: [{ path: 'date', op: 'relative', relative: { period: 'today' }, prompt: true }],
    aggregates: [
      { fn: 'sum', path: 'grand_total', label: { en: 'Sales', hi: 'बिक्री' } },
      { fn: 'count', label: { en: 'Bills', hi: 'बिल' } },
      { fn: 'avg', path: 'grand_total', label: { en: 'Average bill', hi: 'औसत बिल' } },
    ],
    roleKeys: [MANAGER, CASHIER],
  },
  {
    key: 'rt_sales_by_day',
    label: { en: 'Sales by day', hi: 'दिनवार बिक्री' },
    entity: SALE,
    dateField: 'date',
    columns: [],
    filters: [
      { path: 'date', op: 'relative', relative: { period: 'last_n_days', n: 30 }, prompt: true },
    ],
    groupBy: [{ path: 'date', bucket: 'day' }],
    aggregates: [
      { fn: 'sum', path: 'grand_total', label: { en: 'Sales', hi: 'बिक्री' } },
      { fn: 'count', label: { en: 'Bills', hi: 'बिल' } },
      { fn: 'sum', path: 'tax_total', label: { en: 'Tax', hi: 'कर' } },
    ],
    sort: [{ path: 'date', dir: 'asc' }],
    chart: { type: 'bar' },
    roleKeys: [MANAGER],
  },
  {
    key: 'rt_sales_by_item',
    label: { en: 'Sales by item', hi: 'वस्तुवार बिक्री' },
    entity: SALE,
    lines: 'lines',
    dateField: 'date',
    columns: [],
    filters: [{ path: 'date', op: 'relative', relative: { period: 'this_month' }, prompt: true }],
    groupBy: [{ path: 'lines.item' }],
    aggregates: [
      { fn: 'sum', path: 'lines.amount', label: { en: 'Sales', hi: 'बिक्री' } },
      { fn: 'sum', path: 'lines.qty', label: { en: 'Quantity', hi: 'मात्रा' } },
      { fn: 'count_distinct', path: 'number', label: { en: 'Bills', hi: 'बिल' } },
    ],
    chart: { type: 'bar' },
    roleKeys: [MANAGER],
  },
  {
    key: 'rt_sales_by_payment',
    label: { en: 'Sales by payment mode', hi: 'भुगतान के तरीके अनुसार बिक्री' },
    entity: SALE,
    dateField: 'date',
    columns: [],
    filters: [{ path: 'date', op: 'relative', relative: { period: 'today' }, prompt: true }],
    groupBy: [{ path: 'payment_mode' }],
    aggregates: [
      { fn: 'sum', path: 'grand_total', label: { en: 'Amount', hi: 'राशि' } },
      { fn: 'count', label: { en: 'Bills', hi: 'बिल' } },
    ],
    chart: { type: 'donut' },
    roleKeys: [MANAGER, CASHIER],
  },
  {
    key: 'rt_returns_by_reason',
    label: { en: 'Returns by reason', hi: 'कारण अनुसार वापसी' },
    entity: RETURN,
    dateField: 'date',
    columns: [],
    filters: [{ path: 'date', op: 'relative', relative: { period: 'this_month' }, prompt: true }],
    groupBy: [{ path: 'reason' }],
    aggregates: [
      { fn: 'sum', path: 'grand_total', label: { en: 'Amount', hi: 'राशि' } },
      { fn: 'count', label: { en: 'Returns', hi: 'वापसी' } },
    ],
    chart: { type: 'pie' },
    roleKeys: [MANAGER],
  },
  {
    key: 'rt_low_stock',
    label: { en: 'Items to reorder', hi: 'पुनः ऑर्डर हेतु वस्तुएँ' },
    entity: ITEM,
    columns: [
      { path: 'name' },
      { path: 'barcode' },
      { path: 'category' },
      { path: 'stock' },
      { path: 'reorder_level' },
    ],
    filters: [{ path: 'low_stock', op: 'eq', value: true }],
    sort: [{ path: 'stock', dir: 'asc' }],
    roleKeys: [MANAGER],
  },
];

const DASHBOARD: DashboardDef = {
  key: 'rt_store_manager',
  label: { en: 'Store manager', hi: 'स्टोर प्रबंधक' },
  roleKeys: [MANAGER],
  home: true,
  filters: { dateRange: true, orgUnit: true },
  widgets: [
    {
      id: 'sales',
      type: 'kpi',
      title: { en: "Today's sales", hi: 'आज की बिक्री' },
      report: 'rt_sales_today',
      kpi: { aggregate: 0, compare: true },
      x: 0,
      y: 0,
      w: 4,
      h: 2,
    },
    {
      id: 'bills',
      type: 'kpi',
      title: { en: 'Bills', hi: 'बिल' },
      report: 'rt_sales_today',
      kpi: { aggregate: 1, compare: true },
      x: 4,
      y: 0,
      w: 4,
      h: 2,
    },
    {
      id: 'avg',
      type: 'kpi',
      title: { en: 'Average bill', hi: 'औसत बिल' },
      report: 'rt_sales_today',
      kpi: { aggregate: 2 },
      x: 8,
      y: 0,
      w: 4,
      h: 2,
    },
    { id: 'daily', type: 'chart', report: 'rt_sales_by_day', x: 0, y: 2, w: 8, h: 4 },
    { id: 'payment', type: 'chart', report: 'rt_sales_by_payment', x: 8, y: 2, w: 4, h: 4 },
    {
      id: 'items',
      type: 'list',
      title: { en: 'Top items', hi: 'शीर्ष वस्तुएँ' },
      report: 'rt_sales_by_item',
      limit: 10,
      x: 0,
      y: 6,
      w: 6,
      h: 4,
    },
    { id: 'reorder', type: 'list', report: 'rt_low_stock', limit: 10, x: 6, y: 6, w: 6, h: 4 },
    {
      id: 'links',
      type: 'links',
      title: { en: 'Quick actions', hi: 'त्वरित कार्य' },
      x: 0,
      y: 10,
      w: 12,
      h: 1,
      links: [
        { label: { en: 'New bill', hi: 'नया बिल' }, href: `/r/${SALE}/new` },
        { label: { en: 'Sales return', hi: 'बिक्री वापसी' }, href: `/r/${RETURN}/new` },
        { label: { en: 'Add item', hi: 'वस्तु जोड़ें' }, href: `/r/${ITEM}/new` },
      ],
    },
  ],
};

const all = (entity: string) => `records.${entity}.*`;
const perms = (entity: string, ...actions: string[]) =>
  actions.map((a) => `records.${entity}.${a}`);

export const RETAIL: PackManifest = {
  id: 'industry.retail',
  type: 'industry',
  version: '1.0.0',
  name: { en: 'Retail', hi: 'खुदरा' },
  description: {
    en: 'Items with barcodes and reorder levels, customers, POS bills with payment modes and tax-inclusive prices, sales returns, 80 mm receipts and A4 invoices, sales by day, item and payment mode, low-stock alerts and a Store manager dashboard.',
    hi: 'बारकोड और पुनः ऑर्डर स्तर वाली वस्तुएँ, ग्राहक, भुगतान के तरीके और कर-सहित मूल्य वाले पीओएस बिल, बिक्री वापसी, 80 मिमी रसीद और A4 चालान, दिन, वस्तु और भुगतान के तरीके अनुसार बिक्री, कम स्टॉक अलर्ट और स्टोर प्रबंधक डैशबोर्ड।',
  },
  suggestFor: ['retail'],
  uses: ['tax'],
  layer: {
    entities: ENTITIES,
    picklists: PICKLISTS,
    forms: [
      {
        entity: SALE,
        sections: [
          {
            key: 'bill',
            label: { en: 'Bill', hi: 'बिल' },
            columns: 3,
            fields: ['bill_no', 'date', 'customer'],
          },
          { key: 'items', label: { en: 'Items', hi: 'वस्तुएँ' }, columns: 1, fields: ['lines'] },
          {
            key: 'payment',
            label: { en: 'Payment', hi: 'भुगतान' },
            columns: 3,
            fields: ['payment_mode', 'payment_ref', 'amount_tendered', 'change_due', 'total_qty'],
          },
        ],
      },
      {
        entity: ITEM,
        sections: [
          {
            key: 'item',
            label: { en: 'Item', hi: 'वस्तु' },
            columns: 2,
            fields: ['name', 'barcode', 'sku', 'category', 'unit', 'active'],
          },
          {
            key: 'pricing',
            label: { en: 'Pricing', hi: 'मूल्य' },
            columns: 3,
            fields: ['price', 'mrp', 'cost'],
          },
          {
            key: 'stock',
            label: { en: 'Stock', hi: 'स्टॉक' },
            columns: 2,
            fields: ['stock', 'reorder_level', 'low_stock', 'reorder_contact'],
          },
        ],
      },
    ],
    listViews: [
      {
        entity: SALE,
        columns: ['bill_no', 'date', 'customer', 'payment_mode', 'grand_total', 'createdBy'],
        sort: { field: 'createdAt', dir: 'desc' },
        pageSize: 50,
      },
      {
        entity: ITEM,
        columns: ['name', 'barcode', 'category', 'price', 'stock', 'reorder_level', 'low_stock'],
        sort: { field: 'name', dir: 'asc' },
        pageSize: 100,
      },
      { entity: CUSTOMER, columns: ['name', 'phone', 'loyalty_points'] },
      {
        entity: RETURN,
        columns: ['return_no', 'date', 'against_sale', 'reason', 'grand_total'],
        sort: { field: 'createdAt', dir: 'desc' },
      },
    ],
    numbering: [
      {
        key: 'rt_sale',
        label: { en: 'POS bills', hi: 'पीओएस बिल' },
        pattern: 'POS/{BRANCH}/{FY}/{SEQ:6}',
        reset: 'yearly',
        scope: 'org_unit',
      },
      {
        key: 'rt_sales_return',
        label: { en: 'Sales returns', hi: 'बिक्री वापसी' },
        pattern: 'SR/{BRANCH}/{FY}/{SEQ:5}',
        reset: 'yearly',
        scope: 'org_unit',
      },
    ],
    rules: [
      {
        key: 'rt_return_qty',
        entity: RETURN,
        on: 'save',
        condition: 'SUM(lines.qty) <= 0',
        effect: 'block',
        message: {
          en: 'Enter the quantity returned',
          hi: 'वापस की गई मात्रा दर्ज करें',
        },
      },
    ],
    automations: [
      {
        key: 'rt_low_stock_alert',
        entity: ITEM,
        label: { en: 'Low-stock alert', hi: 'कम स्टॉक अलर्ट' },
        trigger: { type: 'field_changed', field: 'stock' },
        condition: 'reorder_level > 0 && stock < reorder_level',
        actions: [
          {
            type: 'notify',
            template: 'rt_low_stock',
            recipients: [
              { type: 'role', roleKey: MANAGER },
              { type: 'field', field: 'reorder_contact' },
            ],
            channels: ['inapp', 'email'],
          },
        ],
      },
    ],
    templates: [
      {
        key: 'rt_low_stock',
        label: { en: 'Low stock', hi: 'कम स्टॉक' },
        title: {
          en: 'Low stock: {{record.name}}',
          hi: 'कम स्टॉक: {{record.name}}',
        },
        body: {
          en: '{{record.name}} is down to {{record.stock}} (reorder level {{record.reorder_level}}). Please reorder. {{link}}',
          hi: '{{record.name}} का स्टॉक {{record.stock}} रह गया है (पुनः ऑर्डर स्तर {{record.reorder_level}})। कृपया पुनः ऑर्डर करें। {{link}}',
        },
      },
    ],
    printTemplates: PRINT_TEMPLATES,
    reports: REPORTS,
    dashboards: [DASHBOARD],
  },
  roles: [
    {
      key: MANAGER,
      name: { en: 'Store manager', hi: 'स्टोर प्रबंधक' },
      description: {
        en: 'Runs the store: items and prices, sales, returns and reports',
        hi: 'स्टोर चलाते हैं: वस्तुएँ और मूल्य, बिक्री, वापसी और रिपोर्ट',
      },
      permissions: [
        all(ITEM),
        all(CUSTOMER),
        all(SALE),
        all(RETURN),
        'reports.personal',
        'reports.export',
      ],
    },
    {
      key: CASHIER,
      name: { en: 'Cashier', hi: 'कैशियर' },
      description: {
        en: 'Makes bills and returns at the counter',
        hi: 'काउंटर पर बिल और वापसी बनाते हैं',
      },
      permissions: [
        ...perms(ITEM, 'read'),
        ...perms(CUSTOMER, 'read', 'create', 'update'),
        ...perms(SALE, 'read', 'create'),
        ...perms(RETURN, 'read', 'create'),
      ],
    },
  ],
  samples: [
    {
      ref: 'rt_rice',
      entity: ITEM,
      data: {
        name: 'Basmati rice 5 kg',
        barcode: '8901234500011',
        sku: 'GR-RICE-5',
        category: 'grocery',
        unit: 'pack',
        price: '650',
        mrp: '699',
        cost: '560',
        stock: 40,
        reorder_level: 10,
      },
    },
    {
      ref: 'rt_oil',
      entity: ITEM,
      data: {
        name: 'Sunflower oil 1 l',
        barcode: '8901234500028',
        sku: 'GR-OIL-1',
        category: 'grocery',
        unit: 'pcs',
        price: '165',
        mrp: '175',
        cost: '142',
        stock: 6,
        reorder_level: 12,
      },
    },
    {
      ref: 'rt_toothpaste',
      entity: ITEM,
      data: {
        name: 'Toothpaste 150 g',
        barcode: '8901234500035',
        sku: 'PC-TP-150',
        category: 'personal_care',
        unit: 'pcs',
        price: '118',
        mrp: '125',
        cost: '96',
        stock: 55,
        reorder_level: 15,
      },
    },
    {
      ref: 'rt_notebook',
      entity: ITEM,
      data: {
        name: 'Ruled notebook 200 pages',
        barcode: '8901234500042',
        sku: 'ST-NB-200',
        category: 'stationery',
        unit: 'pcs',
        price: '60',
        cost: '42',
        stock: 120,
        reorder_level: 30,
      },
    },
    {
      ref: 'rt_cust_asha',
      entity: CUSTOMER,
      data: { name: 'Asha Reddy', phone: '+919876543210', loyalty_points: 120 },
    },
    {
      ref: 'rt_sale_1',
      entity: SALE,
      data: {
        date: '2026-09-26',
        customer: '@rt_cust_asha',
        payment_mode: 'upi',
        payment_ref: 'UPI-426912345678',
        lines: [
          { item: '@rt_rice', qty: 1, rate: '650' },
          { item: '@rt_oil', qty: 2, rate: '165' },
          { item: '@rt_toothpaste', qty: 1, rate: '118' },
        ],
      },
    },
    {
      ref: 'rt_sale_2',
      entity: SALE,
      data: {
        date: '2026-09-26',
        payment_mode: 'cash',
        amount_tendered: '200',
        lines: [{ item: '@rt_notebook', qty: 3, rate: '60' }],
      },
    },
    {
      ref: 'rt_return_1',
      entity: RETURN,
      data: {
        date: '2026-09-26',
        against_sale: '@rt_sale_1',
        customer: '@rt_cust_asha',
        reason: 'damaged',
        refund_mode: 'upi',
        lines: [{ item: '@rt_oil', qty: 1, rate: '165' }],
      },
    },
  ],
};
