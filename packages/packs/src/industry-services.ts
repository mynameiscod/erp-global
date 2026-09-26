import type {
  AutomationDef,
  DashboardDef,
  EntityPatch,
  FieldDef,
  FormLayout,
  ListView,
  MessageTemplate,
  NumberingSeries,
  PackManifest,
  PackRole,
  PackSample,
  PicklistDef,
  PrintTemplateDef,
  ReportDef,
  ReportFilter,
  WorkflowDef,
} from '@erp/metadata';
import { ROLES } from './conventions';

/**
 * Services Industry Pack: professional services firms and agencies. Clients and their
 * contacts, a catalogue of services, quotations (approved above an amount), invoices with
 * line items, payments against invoices, and the documents, reports and Owner dashboard
 * that go with them.
 *
 * The invoice follows the `sales_invoice` conventions, so a Country Pack adds its taxes
 * (with India: GSTIN, place of supply, SAC codes, CGST/SGST/IGST). The quotation has the
 * same line shape but no role: it is an offer, not a tax document, and prints "taxes extra".
 */

const CLIENT = 'svc_client';
const CONTACT = 'svc_contact';
const SERVICE = 'svc_service';
const QUOTATION = 'svc_quotation';
const INVOICE = 'svc_invoice';
const PAYMENT = 'svc_payment';

/** Quotations above this amount need the approval of the unit head (editable in the Studio). */
export const SERVICES_APPROVAL_THRESHOLD = 100000;

// ---- option lists ----

const PICKLISTS: PicklistDef[] = [
  {
    key: 'svc_units',
    label: { en: 'Billing units', hi: 'बिलिंग इकाइयाँ' },
    options: [
      { value: 'hour', label: { en: 'Per hour', hi: 'प्रति घंटा' } },
      { value: 'day', label: { en: 'Per day', hi: 'प्रति दिन' } },
      { value: 'month', label: { en: 'Per month', hi: 'प्रति माह' } },
      { value: 'fixed', label: { en: 'Fixed fee', hi: 'निश्चित शुल्क' } },
    ],
  },
  {
    key: 'svc_payment_modes',
    label: { en: 'Payment modes', hi: 'भुगतान के तरीके' },
    options: [
      { value: 'bank_transfer', label: { en: 'Bank transfer', hi: 'बैंक ट्रांसफर' } },
      { value: 'upi', label: { en: 'UPI', hi: 'यूपीआई' } },
      { value: 'cheque', label: { en: 'Cheque', hi: 'चेक' } },
      { value: 'card', label: { en: 'Card', hi: 'कार्ड' } },
      { value: 'cash', label: { en: 'Cash', hi: 'नकद' } },
    ],
  },
  {
    key: 'svc_ageing',
    label: { en: 'Ageing of dues', hi: 'बकाया की अवधि' },
    options: [
      { value: 'not_due', label: { en: 'Not yet due', hi: 'अभी देय नहीं' }, color: '#198754' },
      { value: 'd1_30', label: { en: '1–30 days', hi: '1–30 दिन' }, color: '#0dcaf0' },
      { value: 'd31_60', label: { en: '31–60 days', hi: '31–60 दिन' }, color: '#ffc107' },
      { value: 'd61_90', label: { en: '61–90 days', hi: '61–90 दिन' }, color: '#fd7e14' },
      { value: 'd90_plus', label: { en: 'Over 90 days', hi: '90 दिन से अधिक' }, color: '#dc3545' },
    ],
  },
];

// ---- entities ----

/** Line items of quotations and invoices: the `sales_invoice` line shape. */
const LINES: FieldDef = {
  key: 'lines',
  type: 'table',
  label: { en: 'Services', hi: 'सेवाएँ' },
  columns: [
    { key: 'item', type: 'lookup', target: SERVICE, label: { en: 'Service', hi: 'सेवा' } },
    { key: 'description', type: 'text', label: { en: 'Description', hi: 'विवरण' } },
    {
      key: 'qty',
      type: 'decimal',
      scale: 2,
      min: 0,
      label: { en: 'Quantity', hi: 'मात्रा' },
      default: 1,
    },
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

const ENTITIES: EntityPatch[] = [
  {
    key: CLIENT,
    kind: 'custom',
    label: { en: 'Client', hi: 'क्लाइंट' },
    pluralLabel: { en: 'Clients', hi: 'क्लाइंट' },
    icon: 'building',
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
        key: 'email',
        type: 'email',
        label: { en: 'Billing email', hi: 'बिलिंग ईमेल' },
        help: {
          en: 'Invoices and receipts are emailed here',
          hi: 'चालान और रसीदें इसी पते पर ईमेल की जाती हैं',
        },
        searchable: true,
      },
      { key: 'phone', type: 'phone', label: { en: 'Phone', hi: 'फ़ोन' } },
      { key: 'address', type: 'longtext', label: { en: 'Address', hi: 'पता' } },
      { key: 'city', type: 'text', label: { en: 'City', hi: 'शहर' } },
      {
        key: 'payment_terms',
        type: 'integer',
        label: { en: 'Payment terms (days)', hi: 'भुगतान अवधि (दिन)' },
        min: 0,
        max: 365,
        default: 30,
      },
      { key: 'notes', type: 'longtext', label: { en: 'Notes', hi: 'टिप्पणियाँ' } },
    ],
  },
  {
    key: CONTACT,
    kind: 'custom',
    label: { en: 'Contact', hi: 'संपर्क' },
    pluralLabel: { en: 'Contacts', hi: 'संपर्क' },
    icon: 'person-lines-fill',
    titleField: 'name',
    orgScoped: false,
    fields: [
      {
        key: 'name',
        type: 'text',
        label: { en: 'Name', hi: 'नाम' },
        required: true,
        searchable: true,
      },
      {
        key: 'client',
        type: 'lookup',
        target: CLIENT,
        label: { en: 'Client', hi: 'क्लाइंट' },
        required: true,
      },
      { key: 'designation', type: 'text', label: { en: 'Designation', hi: 'पद' } },
      { key: 'email', type: 'email', label: { en: 'Email', hi: 'ईमेल' }, searchable: true },
      { key: 'phone', type: 'phone', label: { en: 'Phone', hi: 'फ़ोन' } },
      {
        key: 'primary',
        type: 'boolean',
        label: { en: 'Primary contact', hi: 'मुख्य संपर्क' },
      },
    ],
  },
  {
    key: SERVICE,
    kind: 'custom',
    label: { en: 'Service', hi: 'सेवा' },
    pluralLabel: { en: 'Services', hi: 'सेवाएँ' },
    icon: 'briefcase',
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
      },
      { key: 'code', type: 'text', label: { en: 'Code', hi: 'कोड' }, maxLength: 30 },
      { key: 'description', type: 'longtext', label: { en: 'Description', hi: 'विवरण' } },
      {
        key: 'unit',
        type: 'select',
        picklist: 'svc_units',
        label: { en: 'Billed', hi: 'बिलिंग' },
      },
      {
        key: 'price',
        type: 'currency',
        label: { en: 'Price', hi: 'मूल्य' },
        min: 0,
      },
      {
        key: 'active',
        type: 'boolean',
        label: { en: 'Offered', hi: 'उपलब्ध' },
        default: true,
      },
    ],
  },
  {
    key: QUOTATION,
    kind: 'custom',
    label: { en: 'Quotation', hi: 'कोटेशन' },
    pluralLabel: { en: 'Quotations', hi: 'कोटेशन' },
    icon: 'file-earmark-text',
    orgScoped: true,
    fields: [
      {
        key: 'quote_no',
        type: 'autonumber',
        numbering: 'svc_quotation',
        label: { en: 'Quotation no.', hi: 'कोटेशन संख्या' },
      },
      {
        key: 'customer',
        type: 'lookup',
        target: CLIENT,
        label: { en: 'Client', hi: 'क्लाइंट' },
        required: true,
      },
      { key: 'date', type: 'date', label: { en: 'Date', hi: 'तारीख' }, required: true },
      { key: 'valid_until', type: 'date', label: { en: 'Valid until', hi: 'तक मान्य' } },
      {
        key: 'client_email',
        type: 'email',
        label: { en: 'Send to', hi: 'भेजें' },
        defaultFrom: 'customer.email',
      },
      { key: 'subject', type: 'text', label: { en: 'Subject', hi: 'विषय' } },
      LINES,
      {
        key: 'total',
        type: 'formula',
        label: { en: 'Total (before tax)', hi: 'कुल (कर से पहले)' },
        formula: 'SUM(lines.amount)',
        resultType: 'number',
      },
      { key: 'terms', type: 'longtext', label: { en: 'Terms', hi: 'शर्तें' } },
    ],
  },
  {
    key: INVOICE,
    kind: 'custom',
    label: { en: 'Invoice', hi: 'चालान' },
    pluralLabel: { en: 'Invoices', hi: 'चालान' },
    icon: 'receipt',
    orgScoped: true,
    roles: [ROLES.salesInvoice],
    tax: { lines: 'lines', amount: 'amount', document: 'invoice' },
    fields: [
      {
        key: 'invoice_no',
        type: 'autonumber',
        numbering: 'svc_invoice',
        label: { en: 'Invoice no.', hi: 'चालान संख्या' },
      },
      {
        key: 'customer',
        type: 'lookup',
        target: CLIENT,
        label: { en: 'Client', hi: 'क्लाइंट' },
        required: true,
      },
      { key: 'date', type: 'date', label: { en: 'Date', hi: 'तारीख' }, required: true },
      {
        key: 'terms_days',
        type: 'integer',
        label: { en: 'Payment terms (days)', hi: 'भुगतान अवधि (दिन)' },
        min: 0,
        max: 365,
        defaultFrom: 'customer.payment_terms',
      },
      {
        key: 'due_date',
        type: 'formula',
        label: { en: 'Due date', hi: 'देय तिथि' },
        formula: 'ADD_DAYS(date, terms_days)',
        resultType: 'date',
      },
      {
        key: 'quotation',
        type: 'lookup',
        target: QUOTATION,
        label: { en: 'Quotation', hi: 'कोटेशन' },
      },
      {
        key: 'client_email',
        type: 'email',
        label: { en: 'Send to', hi: 'भेजें' },
        defaultFrom: 'customer.email',
      },
      LINES,
      { key: 'notes', type: 'longtext', label: { en: 'Notes', hi: 'टिप्पणियाँ' } },
      {
        key: 'amount_paid',
        type: 'currency',
        label: { en: 'Amount received', hi: 'प्राप्त राशि' },
        help: {
          en: 'Total of the payments received against this invoice',
          hi: 'इस चालान के विरुद्ध प्राप्त भुगतानों का योग',
        },
        min: 0,
      },
      {
        // `grand_total` is filled by the tax engine (equal to the subtotal without a Country Pack).
        key: 'balance',
        type: 'formula',
        label: { en: 'Balance due', hi: 'शेष देय' },
        formula: 'grand_total - amount_paid',
        resultType: 'number',
      },
      // Refreshed every night by the `svc_invoice_ageing` automation.
      {
        key: 'days_overdue',
        type: 'integer',
        label: { en: 'Days overdue', hi: 'अतिदेय दिन' },
      },
      {
        key: 'ageing',
        type: 'select',
        picklist: 'svc_ageing',
        label: { en: 'Ageing', hi: 'अवधि' },
      },
    ],
  },
  {
    key: PAYMENT,
    kind: 'custom',
    label: { en: 'Payment', hi: 'भुगतान' },
    pluralLabel: { en: 'Payments', hi: 'भुगतान' },
    icon: 'cash-coin',
    orgScoped: true,
    fields: [
      {
        key: 'receipt_no',
        type: 'autonumber',
        numbering: 'svc_payment',
        label: { en: 'Receipt no.', hi: 'रसीद संख्या' },
      },
      {
        key: 'invoice',
        type: 'lookup',
        target: INVOICE,
        label: { en: 'Invoice', hi: 'चालान' },
        required: true,
      },
      {
        key: 'customer',
        type: 'lookup',
        target: CLIENT,
        label: { en: 'Client', hi: 'क्लाइंट' },
        defaultFrom: 'invoice.customer',
      },
      { key: 'date', type: 'date', label: { en: 'Date', hi: 'तारीख' }, required: true },
      {
        key: 'amount',
        type: 'currency',
        label: { en: 'Amount', hi: 'राशि' },
        required: true,
        min: 0,
      },
      {
        key: 'mode',
        type: 'select',
        picklist: 'svc_payment_modes',
        label: { en: 'Mode', hi: 'तरीका' },
        default: 'bank_transfer',
      },
      {
        key: 'reference',
        type: 'text',
        label: { en: 'Reference (UTR, cheque no.)', hi: 'संदर्भ (यूटीआर, चेक संख्या)' },
      },
      {
        key: 'client_email',
        type: 'email',
        label: { en: 'Send receipt to', hi: 'रसीद भेजें' },
        defaultFrom: 'invoice.client_email',
      },
      { key: 'notes', type: 'longtext', label: { en: 'Notes', hi: 'टिप्पणियाँ' } },
    ],
  },
];

// ---- forms and lists ----

/*
 * Forms only for entities without a role: a layout hides fields it does not place, and a
 * Country Pack adds fields (GSTIN, place of supply…) to clients, services and invoices.
 */
const FORMS: FormLayout[] = [
  {
    entity: CONTACT,
    sections: [
      {
        key: 'main',
        label: { en: 'Contact', hi: 'संपर्क' },
        columns: 2,
        fields: ['name', 'client', 'designation', 'primary', 'email', 'phone'],
      },
    ],
  },
  {
    entity: QUOTATION,
    sections: [
      {
        key: 'main',
        label: { en: 'Quotation', hi: 'कोटेशन' },
        columns: 2,
        fields: ['customer', 'client_email', 'date', 'valid_until', 'subject'],
      },
      { key: 'items', label: { en: 'Services', hi: 'सेवाएँ' }, columns: 1, fields: ['lines'] },
      {
        key: 'close',
        label: { en: 'Total and terms', hi: 'कुल और शर्तें' },
        columns: 1,
        fields: ['total', 'terms'],
      },
    ],
  },
  {
    entity: PAYMENT,
    sections: [
      {
        key: 'main',
        label: { en: 'Payment', hi: 'भुगतान' },
        columns: 2,
        fields: [
          'invoice',
          'customer',
          'date',
          'amount',
          'mode',
          'reference',
          'client_email',
          'notes',
        ],
      },
    ],
  },
];

const LIST_VIEWS: ListView[] = [
  {
    entity: CLIENT,
    columns: ['name', 'city', 'email', 'phone'],
    sort: { field: 'name', dir: 'asc' },
  },
  { entity: CONTACT, columns: ['name', 'client', 'designation', 'email', 'phone'] },
  { entity: SERVICE, columns: ['name', 'code', 'unit', 'price', 'active'] },
  {
    entity: QUOTATION,
    columns: ['number', 'date', 'customer', 'subject', 'total', 'status'],
    sort: { field: 'date', dir: 'desc' },
  },
  {
    entity: INVOICE,
    columns: [
      'number',
      'date',
      'customer',
      'due_date',
      'grand_total',
      'balance',
      'ageing',
      'status',
    ],
    sort: { field: 'date', dir: 'desc' },
  },
  {
    entity: PAYMENT,
    columns: ['number', 'date', 'customer', 'invoice', 'mode', 'amount'],
    sort: { field: 'date', dir: 'desc' },
  },
];

// ---- number series ----

// At most 16 characters, as GST invoices require: SI/2026-27/00001.
const NUMBERING: NumberingSeries[] = [
  {
    key: 'svc_quotation',
    label: { en: 'Quotations', hi: 'कोटेशन' },
    pattern: 'QT/{FY}/{SEQ:5}',
    reset: 'yearly',
    scope: 'company',
  },
  {
    key: 'svc_invoice',
    label: { en: 'Invoices', hi: 'चालान' },
    pattern: 'SI/{FY}/{SEQ:5}',
    reset: 'yearly',
    scope: 'company',
  },
  {
    key: 'svc_payment',
    label: { en: 'Payment receipts', hi: 'भुगतान रसीदें' },
    pattern: 'RC/{FY}/{SEQ:5}',
    reset: 'yearly',
    scope: 'company',
  },
];

// ---- workflows ----

// Who may take role-limited actions (by role key; the pack's roles get their ids at install).
const SALES_KEYS = ['svc_owner', 'svc_sales'];
const ACCOUNTS_KEYS = ['svc_owner', 'svc_accounts'];

const WORKFLOWS: WorkflowDef[] = [
  {
    entity: QUOTATION,
    initialState: 'draft',
    states: [
      { key: 'draft', label: { en: 'Draft', hi: 'मसौदा' }, color: '#6c757d' },
      {
        key: 'pending',
        label: { en: 'Waiting for approval', hi: 'स्वीकृति की प्रतीक्षा' },
        color: '#fd7e14',
        locked: true,
      },
      { key: 'approved', label: { en: 'Approved', hi: 'स्वीकृत' }, color: '#0d6efd', locked: true },
      { key: 'sent', label: { en: 'Sent', hi: 'भेजा गया' }, color: '#0dcaf0', locked: true },
      { key: 'accepted', label: { en: 'Accepted', hi: 'स्वीकार' }, color: '#198754', locked: true },
      {
        key: 'declined',
        label: { en: 'Declined', hi: 'अस्वीकार' },
        color: '#dc3545',
        locked: true,
      },
    ],
    actions: [
      {
        key: 'submit',
        label: { en: 'Submit', hi: 'जमा करें' },
        from: ['draft'],
        to: 'pending',
        condition: 'total > 0',
        approval: {
          // Below the threshold no level applies and the quotation is approved at once.
          levels: [
            {
              key: 'owner',
              label: { en: 'Owner approval', hi: 'मालिक की स्वीकृति' },
              condition: `total > ${SERVICES_APPROVAL_THRESHOLD}`,
              approvers: [{ type: 'role', roleKey: 'svc_owner' }],
              escalateAfterHours: 72,
              escalateTo: [{ type: 'unit_head' }],
              mode: 'any',
              remindAfterHours: 24,
            },
          ],
          approvedState: 'approved',
          rejectedState: 'draft',
        },
      },
      {
        key: 'send',
        label: { en: 'Send to client', hi: 'क्लाइंट को भेजें' },
        from: ['approved'],
        to: 'sent',
        roleKeys: SALES_KEYS,
      },
      {
        key: 'accept',
        label: { en: 'Client accepted', hi: 'क्लाइंट ने स्वीकार किया' },
        from: ['sent'],
        to: 'accepted',
        roleKeys: SALES_KEYS,
      },
      {
        key: 'decline',
        label: { en: 'Client declined', hi: 'क्लाइंट ने अस्वीकार किया' },
        from: ['sent'],
        to: 'declined',
        roleKeys: SALES_KEYS,
        commentRequired: true,
      },
      {
        key: 'revise',
        label: { en: 'Revise', hi: 'संशोधित करें' },
        from: ['approved', 'sent', 'declined'],
        to: 'draft',
      },
    ],
  },
  {
    entity: INVOICE,
    initialState: 'draft',
    states: [
      { key: 'draft', label: { en: 'Draft', hi: 'मसौदा' }, color: '#6c757d' },
      {
        key: 'issued',
        label: { en: 'Issued', hi: 'जारी' },
        color: '#0d6efd',
        locked: true,
        editableFields: ['amount_paid', 'notes'],
      },
      { key: 'paid', label: { en: 'Paid', hi: 'भुगतान हो गया' }, color: '#198754', locked: true },
      {
        key: 'cancelled',
        label: { en: 'Cancelled', hi: 'रद्द' },
        color: '#dc3545',
        locked: true,
      },
    ],
    actions: [
      {
        key: 'issue',
        label: { en: 'Issue', hi: 'जारी करें' },
        from: ['draft'],
        to: 'issued',
        roleKeys: ACCOUNTS_KEYS,
        condition: 'grand_total > 0',
      },
      {
        key: 'mark_paid',
        label: { en: 'Mark as paid', hi: 'भुगतान के रूप में चिह्नित करें' },
        from: ['issued'],
        to: 'paid',
        roleKeys: ACCOUNTS_KEYS,
        condition: 'balance <= 0',
      },
      {
        key: 'cancel',
        label: { en: 'Cancel', hi: 'रद्द करें' },
        from: ['draft', 'issued'],
        to: 'cancelled',
        roleKeys: ACCOUNTS_KEYS,
        commentRequired: true,
      },
    ],
  },
];

// ---- automations and messages ----

const TEMPLATES: MessageTemplate[] = [
  {
    key: 'svc.quote_approved',
    label: { en: 'Quotation approved', hi: 'कोटेशन स्वीकृत' },
    title: {
      en: 'Quotation {{record.number}} is approved',
      hi: 'कोटेशन {{record.number}} स्वीकृत है',
    },
    body: {
      en: 'Quotation {{record.number}} is approved and can be sent to the client.',
      hi: 'कोटेशन {{record.number}} स्वीकृत है और क्लाइंट को भेजा जा सकता है।',
    },
  },
  {
    key: 'svc.invoice_paid',
    label: { en: 'Invoice paid', hi: 'चालान का भुगतान' },
    title: {
      en: 'Invoice {{record.number}} is fully paid',
      hi: 'चालान {{record.number}} का पूरा भुगतान हो गया',
    },
    body: {
      en: 'The client has paid invoice {{record.number}} in full.',
      hi: 'क्लाइंट ने चालान {{record.number}} का पूरा भुगतान कर दिया है।',
    },
  },
];

/** Days past the due date, and its ageing bucket. */
const OVERDUE = 'DAYS_BETWEEN(due_date, TODAY())';
const AGEING_SET = [
  { field: 'days_overdue', value: `MAX(${OVERDUE}, 0)` },
  {
    field: 'ageing',
    value: `IF(${OVERDUE} <= 0, "not_due", IF(${OVERDUE} <= 30, "d1_30", IF(${OVERDUE} <= 60, "d31_60", IF(${OVERDUE} <= 90, "d61_90", "d90_plus"))))`,
  },
];

const AUTOMATIONS: AutomationDef[] = [
  {
    key: 'svc_quote_approved',
    entity: QUOTATION,
    label: { en: 'Tell the author a quotation is approved', hi: 'कोटेशन स्वीकृत होने पर सूचना' },
    trigger: { type: 'status_changed', to: 'approved' },
    actions: [
      {
        type: 'notify',
        template: 'svc.quote_approved',
        recipients: [{ type: 'creator' }],
        channels: ['inapp', 'email'],
      },
    ],
  },
  {
    key: 'svc_quote_email',
    entity: QUOTATION,
    label: { en: 'Email the quotation to the client', hi: 'कोटेशन क्लाइंट को ईमेल करें' },
    trigger: { type: 'status_changed', to: 'sent' },
    condition: 'client_email != ""',
    actions: [
      {
        type: 'document',
        template: 'svc_quotation_pdf',
        emailFields: ['client_email'],
        message: 'Please find our quotation attached. We look forward to working with you.',
      },
    ],
  },
  {
    key: 'svc_invoice_email',
    entity: INVOICE,
    label: { en: 'Email the invoice to the client', hi: 'चालान क्लाइंट को ईमेल करें' },
    trigger: { type: 'status_changed', to: 'issued' },
    condition: 'client_email != ""',
    actions: [
      {
        type: 'document',
        template: 'svc_invoice_pdf',
        emailFields: ['client_email'],
        message: 'Please find our invoice attached. Thank you for your business.',
      },
    ],
  },
  {
    key: 'svc_invoice_ageing_start',
    entity: INVOICE,
    label: { en: 'Start the ageing of an issued invoice', hi: 'जारी चालान की अवधि शुरू करें' },
    trigger: { type: 'status_changed', to: 'issued' },
    actions: [{ type: 'update', set: AGEING_SET }],
  },
  {
    key: 'svc_invoice_ageing',
    entity: INVOICE,
    label: { en: 'Update the ageing of dues every night', hi: 'हर रात बकाया की अवधि अद्यतन करें' },
    trigger: { type: 'schedule', every: 'day', at: '01:00' },
    condition: 'STATUS() = "issued" && balance > 0',
    actions: [{ type: 'update', set: AGEING_SET }],
  },
  {
    key: 'svc_invoice_settled',
    entity: INVOICE,
    label: {
      en: 'Mark an invoice paid when fully received',
      hi: 'पूरा भुगतान मिलने पर चालान बंद करें',
    },
    trigger: { type: 'updated' },
    condition: 'STATUS() = "issued" && grand_total > 0 && balance <= 0',
    actions: [{ type: 'workflow_action', action: 'mark_paid' }],
  },
  {
    key: 'svc_invoice_paid',
    entity: INVOICE,
    label: {
      en: 'Tell the author and the owner an invoice is paid',
      hi: 'चालान के भुगतान की सूचना',
    },
    trigger: { type: 'status_changed', to: 'paid' },
    actions: [
      {
        type: 'notify',
        template: 'svc.invoice_paid',
        recipients: [{ type: 'creator' }, { type: 'role', roleKey: 'svc_owner' }],
        channels: ['inapp'],
      },
    ],
  },
  {
    key: 'svc_receipt_email',
    entity: PAYMENT,
    label: { en: 'Email the payment receipt', hi: 'भुगतान रसीद ईमेल करें' },
    trigger: { type: 'created' },
    condition: 'client_email != ""',
    actions: [
      {
        type: 'document',
        template: 'svc_receipt_pdf',
        emailFields: ['client_email'],
        message: 'Thank you for your payment. Your receipt is attached.',
      },
    ],
  },
];

// ---- print templates ----

const LETTERHEAD = {
  id: 'head',
  type: 'letterhead' as const,
  lines: [{ en: '{{company.name}}' }, { en: '{{unit.address}}' }],
};

const SIGNATURE = {
  id: 'sign',
  type: 'signature' as const,
  name: { en: 'For {{company.name}}', hi: '{{company.name}} के लिए' },
  title: { en: 'Authorised signatory', hi: 'अधिकृत हस्ताक्षरकर्ता' },
};

const PRINT_TEMPLATES: PrintTemplateDef[] = [
  {
    key: 'svc_quotation_pdf',
    entity: QUOTATION,
    label: { en: 'Quotation', hi: 'कोटेशन' },
    page: { size: 'A4' },
    mode: 'blocks',
    footer: { pageNumbers: true },
    fileName: 'Quotation-{{number}}',
    watermarks: [{ text: { en: 'DRAFT', hi: 'मसौदा' }, condition: 'STATUS() = "draft"' }],
    blocks: [
      LETTERHEAD,
      { id: 'title', type: 'title', text: { en: 'Quotation', hi: 'कोटेशन' } },
      {
        id: 'parties',
        type: 'fields',
        columns: 2,
        items: [
          { path: 'number' },
          { path: 'date' },
          { path: 'customer.name', label: { en: 'To', hi: 'प्रति' } },
          { path: 'valid_until' },
          { path: 'customer.address', label: { en: 'Address', hi: 'पता' } },
          { path: 'subject' },
        ],
      },
      {
        id: 'lines',
        type: 'table',
        source: 'lines',
        numbered: true,
        columns: [
          { path: 'item', width: 25 },
          { path: 'description', width: 35 },
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
          {
            label: { en: 'Total (before tax)', hi: 'कुल (कर से पहले)' },
            value: 'total',
            format: 'currency',
            bold: true,
          },
        ],
        words: { value: 'total', label: { en: 'Amount in words:', hi: 'राशि शब्दों में:' } },
      },
      {
        id: 'tax_note',
        type: 'text',
        size: 8,
        text: {
          en: 'Taxes are extra, as applicable on the date of invoice.',
          hi: 'कर अतिरिक्त हैं, जैसा चालान की तारीख को लागू हो।',
        },
      },
      { id: 'terms', type: 'text', text: { en: '{{terms}}' }, condition: 'terms != ""' },
      SIGNATURE,
    ],
  },
  {
    key: 'svc_invoice_pdf',
    entity: INVOICE,
    label: { en: 'Invoice', hi: 'चालान' },
    page: { size: 'A4' },
    mode: 'blocks',
    footer: { pageNumbers: true },
    fileName: 'Invoice-{{number}}',
    watermarks: [
      { text: { en: 'DRAFT', hi: 'मसौदा' }, condition: 'STATUS() = "draft"' },
      { text: { en: 'CANCELLED', hi: 'रद्द' }, condition: 'STATUS() = "cancelled"' },
      { text: { en: 'PAID', hi: 'भुगतान हो गया' }, condition: 'STATUS() = "paid"' },
    ],
    blocks: [
      LETTERHEAD,
      {
        id: 'title',
        type: 'title',
        text: { en: 'Tax Invoice', hi: 'कर चालान' },
        condition: 'tax_total > 0',
      },
      {
        id: 'title_plain',
        type: 'title',
        text: { en: 'Invoice', hi: 'चालान' },
        condition: 'tax_total = 0',
      },
      {
        id: 'parties',
        type: 'fields',
        columns: 2,
        items: [
          { path: 'number' },
          { path: 'date' },
          { path: 'customer.name', label: { en: 'Bill to', hi: 'बिल प्राप्तकर्ता' } },
          { path: 'due_date' },
          { path: 'customer.address', label: { en: 'Address', hi: 'पता' } },
          { path: 'quotation.number', label: { en: 'Quotation', hi: 'कोटेशन' } },
        ],
      },
      {
        id: 'lines',
        type: 'table',
        source: 'lines',
        numbered: true,
        columns: [
          { path: 'item', width: 22 },
          { path: 'description', width: 28 },
          { path: 'qty', format: 'number' },
          { path: 'rate', format: 'currency' },
          { path: 'amount', format: 'currency' },
          { path: 'tax_rate' },
          { path: 'tax_amount', format: 'currency' },
        ],
        totals: ['amount', 'tax_amount'],
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
          { label: { en: 'Subtotal', hi: 'उप-योग' }, value: 'subtotal', format: 'currency' },
          { label: { en: 'Tax', hi: 'कर' }, value: 'tax_total', format: 'currency' },
          { label: { en: 'Round off', hi: 'पूर्णांकन' }, value: 'round_off', format: 'currency' },
          {
            label: { en: 'Total', hi: 'कुल' },
            value: 'grand_total',
            format: 'currency',
            bold: true,
          },
          {
            label: { en: 'Received', hi: 'प्राप्त' },
            value: 'amount_paid',
            format: 'currency',
          },
          {
            label: { en: 'Balance due', hi: 'शेष देय' },
            value: 'balance',
            format: 'currency',
            bold: true,
          },
        ],
        words: { value: 'grand_total', label: { en: 'Amount in words:', hi: 'राशि शब्दों में:' } },
      },
      {
        id: 'due',
        type: 'text',
        text: {
          en: 'Please pay by {{due_date}}, quoting {{number}}.',
          hi: 'कृपया {{number}} का उल्लेख करते हुए {{due_date}} तक भुगतान करें।',
        },
        condition: 'balance > 0',
      },
      { id: 'notes', type: 'text', text: { en: '{{notes}}' }, condition: 'notes != ""' },
      SIGNATURE,
    ],
  },
  {
    key: 'svc_receipt_pdf',
    entity: PAYMENT,
    label: { en: 'Payment receipt', hi: 'भुगतान रसीद' },
    page: { size: 'A5', orientation: 'landscape' },
    mode: 'blocks',
    fileName: 'Receipt-{{number}}',
    blocks: [
      LETTERHEAD,
      { id: 'title', type: 'title', text: { en: 'Payment Receipt', hi: 'भुगतान रसीद' } },
      {
        id: 'details',
        type: 'fields',
        columns: 2,
        items: [
          { path: 'number' },
          { path: 'date' },
          { path: 'customer.name', label: { en: 'Received from', hi: 'से प्राप्त' } },
          { path: 'invoice.number', label: { en: 'Against invoice', hi: 'चालान के विरुद्ध' } },
          { path: 'mode' },
          { path: 'reference' },
        ],
      },
      {
        id: 'totals',
        type: 'totals',
        rows: [
          {
            label: { en: 'Amount received', hi: 'प्राप्त राशि' },
            value: 'amount',
            format: 'currency',
            bold: true,
          },
        ],
        words: { value: 'amount', label: { en: 'Amount in words:', hi: 'राशि शब्दों में:' } },
      },
      {
        id: 'thanks',
        type: 'text',
        text: { en: 'Thank you for your payment.', hi: 'आपके भुगतान के लिए धन्यवाद।' },
      },
      SIGNATURE,
    ],
  },
];

// ---- reports ----

const notCancelled: ReportFilter = { path: 'status', op: 'ne', value: 'cancelled' };
const outstanding: ReportFilter[] = [
  { path: 'status', op: 'eq', value: 'issued' },
  { path: 'balance', op: 'gt', value: 0 },
];
const thisYear: ReportFilter = {
  path: 'date',
  op: 'relative',
  relative: { period: 'this_fiscal_year' },
  prompt: true,
};
const INVOICED = { en: 'Invoiced', hi: 'चालान राशि' };
const RECEIVED = { en: 'Received', hi: 'प्राप्त' };
const DUE = { en: 'Due', hi: 'बकाया' };

const REPORTS: ReportDef[] = [
  {
    key: 'svc_invoiced_vs_paid',
    label: { en: 'Invoiced vs paid by client', hi: 'क्लाइंट अनुसार चालान बनाम भुगतान' },
    entity: INVOICE,
    dateField: 'date',
    columns: [],
    filters: [notCancelled, thisYear],
    groupBy: [{ path: 'customer' }],
    aggregates: [
      { fn: 'sum', path: 'grand_total', label: INVOICED },
      { fn: 'sum', path: 'amount_paid', label: RECEIVED },
      { fn: 'sum', path: 'balance', label: DUE },
    ],
    chart: { type: 'bar' },
  },
  {
    key: 'svc_dues_ageing',
    label: { en: 'Ageing of dues', hi: 'बकाया की अवधि' },
    entity: INVOICE,
    dateField: 'date',
    columns: [],
    filters: outstanding,
    groupBy: [{ path: 'ageing' }],
    aggregates: [
      { fn: 'sum', path: 'balance', label: DUE },
      { fn: 'count', label: { en: 'Invoices', hi: 'चालान' } },
    ],
    chart: { type: 'donut' },
  },
  {
    key: 'svc_dues_by_client',
    label: { en: 'Dues by client and age', hi: 'क्लाइंट और अवधि अनुसार बकाया' },
    entity: INVOICE,
    dateField: 'date',
    columns: [],
    filters: outstanding,
    pivot: {
      rows: [{ path: 'customer' }],
      column: { path: 'ageing' },
      values: [{ fn: 'sum', path: 'balance', label: DUE }],
    },
  },
  {
    key: 'svc_overdue_invoices',
    label: { en: 'Overdue invoices', hi: 'अतिदेय चालान' },
    entity: INVOICE,
    dateField: 'date',
    columns: [
      { path: 'number' },
      { path: 'customer.name' },
      { path: 'date' },
      { path: 'due_date' },
      { path: 'days_overdue' },
      { path: 'grand_total' },
      { path: 'balance' },
    ],
    filters: [...outstanding, { path: 'days_overdue', op: 'gt', value: 0 }],
    sort: [{ path: 'days_overdue', dir: 'desc' }],
  },
  {
    key: 'svc_invoiced_by_month',
    label: { en: 'Invoiced by month', hi: 'माह अनुसार चालान' },
    entity: INVOICE,
    dateField: 'date',
    columns: [],
    filters: [notCancelled, thisYear],
    groupBy: [{ path: 'date', bucket: 'month' }],
    aggregates: [{ fn: 'sum', path: 'grand_total', label: INVOICED }],
    chart: { type: 'bar' },
  },
  {
    key: 'svc_sales_by_service',
    label: { en: 'Sales by service', hi: 'सेवा अनुसार बिक्री' },
    entity: INVOICE,
    lines: 'lines',
    dateField: 'date',
    columns: [],
    filters: [notCancelled, thisYear],
    groupBy: [{ path: 'lines.item' }],
    aggregates: [
      { fn: 'sum', path: 'lines.qty', label: { en: 'Quantity', hi: 'मात्रा' } },
      {
        fn: 'sum',
        path: 'lines.amount',
        label: { en: 'Amount before tax', hi: 'कर से पहले राशि' },
      },
    ],
    chart: { type: 'bar' },
  },
  {
    key: 'svc_payments_by_month',
    label: { en: 'Payments received by month', hi: 'माह अनुसार प्राप्त भुगतान' },
    entity: PAYMENT,
    dateField: 'date',
    columns: [],
    filters: [thisYear],
    groupBy: [{ path: 'date', bucket: 'month' }, { path: 'mode' }],
    aggregates: [{ fn: 'sum', path: 'amount', label: RECEIVED }],
    chart: { type: 'stacked_bar' },
  },
  {
    key: 'svc_quotation_pipeline',
    label: { en: 'Quotations by status', hi: 'स्थिति अनुसार कोटेशन' },
    entity: QUOTATION,
    dateField: 'date',
    columns: [],
    filters: [thisYear],
    groupBy: [{ path: 'status' }],
    aggregates: [
      { fn: 'count', label: { en: 'Quotations', hi: 'कोटेशन' } },
      { fn: 'sum', path: 'total', label: { en: 'Value', hi: 'मूल्य' } },
    ],
    chart: { type: 'pie' },
  },
  // KPIs for the dashboard (one number each; the dashboard's date range applies).
  {
    key: 'svc_kpi_invoiced',
    label: { en: 'Invoiced', hi: 'चालान राशि' },
    entity: INVOICE,
    dateField: 'date',
    columns: [],
    filters: [notCancelled],
    aggregates: [{ fn: 'sum', path: 'grand_total', label: INVOICED }],
  },
  {
    key: 'svc_kpi_received',
    label: { en: 'Received', hi: 'प्राप्त' },
    entity: PAYMENT,
    dateField: 'date',
    columns: [],
    filters: [],
    aggregates: [{ fn: 'sum', path: 'amount', label: RECEIVED }],
  },
  {
    key: 'svc_kpi_outstanding',
    label: { en: 'Outstanding dues', hi: 'कुल बकाया' },
    entity: INVOICE,
    columns: [],
    filters: outstanding,
    aggregates: [{ fn: 'sum', path: 'balance', label: DUE }],
  },
  {
    key: 'svc_kpi_open_quotes',
    label: { en: 'Quotations awaiting the client', hi: 'क्लाइंट के उत्तर की प्रतीक्षा में कोटेशन' },
    entity: QUOTATION,
    columns: [],
    filters: [{ path: 'status', op: 'in', value: ['approved', 'sent'] }],
    aggregates: [{ fn: 'sum', path: 'total', label: { en: 'Value', hi: 'मूल्य' } }],
  },
];

// ---- dashboard ----

const DASHBOARDS: DashboardDef[] = [
  {
    key: 'svc_owner',
    label: { en: 'Owner', hi: 'मालिक' },
    roleKeys: ['svc_owner'],
    home: true,
    filters: { dateRange: true, orgUnit: true },
    widgets: [
      {
        id: 'invoiced',
        type: 'kpi',
        title: INVOICED,
        report: 'svc_kpi_invoiced',
        kpi: { compare: true },
        x: 0,
        y: 0,
        w: 3,
        h: 2,
      },
      {
        id: 'received',
        type: 'kpi',
        title: RECEIVED,
        report: 'svc_kpi_received',
        kpi: { compare: true },
        x: 3,
        y: 0,
        w: 3,
        h: 2,
      },
      {
        id: 'outstanding',
        type: 'kpi',
        title: { en: 'Outstanding', hi: 'बकाया' },
        report: 'svc_kpi_outstanding',
        x: 6,
        y: 0,
        w: 3,
        h: 2,
      },
      {
        id: 'open_quotes',
        type: 'kpi',
        title: { en: 'Quotations out', hi: 'भेजे गए कोटेशन' },
        report: 'svc_kpi_open_quotes',
        x: 9,
        y: 0,
        w: 3,
        h: 2,
      },
      {
        id: 'by_month',
        type: 'chart',
        title: { en: 'Invoiced by month', hi: 'माह अनुसार चालान' },
        report: 'svc_invoiced_by_month',
        x: 0,
        y: 2,
        w: 8,
        h: 4,
      },
      {
        id: 'ageing',
        type: 'chart',
        title: { en: 'Ageing of dues', hi: 'बकाया की अवधि' },
        report: 'svc_dues_ageing',
        x: 8,
        y: 2,
        w: 4,
        h: 4,
      },
      {
        id: 'clients',
        type: 'chart',
        title: { en: 'Invoiced vs paid by client', hi: 'क्लाइंट अनुसार चालान बनाम भुगतान' },
        report: 'svc_invoiced_vs_paid',
        x: 0,
        y: 6,
        w: 8,
        h: 4,
      },
      {
        id: 'approvals',
        type: 'approvals',
        title: { en: 'Waiting for my approval', hi: 'मेरी स्वीकृति की प्रतीक्षा में' },
        x: 8,
        y: 6,
        w: 4,
        h: 4,
      },
      {
        id: 'overdue',
        type: 'list',
        title: { en: 'Overdue invoices', hi: 'अतिदेय चालान' },
        report: 'svc_overdue_invoices',
        limit: 10,
        x: 0,
        y: 10,
        w: 8,
        h: 4,
      },
      {
        id: 'links',
        type: 'links',
        title: { en: 'Quick links', hi: 'त्वरित लिंक' },
        links: [
          { label: { en: 'New quotation', hi: 'नया कोटेशन' }, href: `/r/${QUOTATION}/new` },
          { label: { en: 'New invoice', hi: 'नया चालान' }, href: `/r/${INVOICE}/new` },
          { label: { en: 'Record a payment', hi: 'भुगतान दर्ज करें' }, href: `/r/${PAYMENT}/new` },
          { label: { en: 'Clients', hi: 'क्लाइंट' }, href: `/r/${CLIENT}` },
        ],
        x: 8,
        y: 10,
        w: 4,
        h: 4,
      },
    ],
  },
];

// ---- roles ----

const can = (entity: string, ...actions: ('read' | 'create' | 'update' | 'delete' | '*')[]) =>
  actions.map((a) => `records.${entity}.${a}`);

const ROLE_TEMPLATES: PackRole[] = [
  {
    key: 'svc_owner',
    name: { en: 'Owner', hi: 'मालिक' },
    description: {
      en: 'Runs the business: everything in the Services pack, approvals and reports',
      hi: 'व्यवसाय चलाते हैं: सेवा पैक में सब कुछ, स्वीकृतियाँ और रिपोर्ट',
    },
    permissions: [
      ...[CLIENT, CONTACT, SERVICE, QUOTATION, INVOICE, PAYMENT].flatMap((e) => can(e, '*')),
      'reports.personal',
      'reports.share',
      'reports.export',
      'workflow.automation.manage',
    ],
  },
  {
    key: 'svc_sales',
    name: { en: 'Sales', hi: 'बिक्री' },
    description: {
      en: 'Looks after clients and prepares quotations',
      hi: 'क्लाइंट संभालते हैं और कोटेशन बनाते हैं',
    },
    permissions: [
      ...can(CLIENT, 'read', 'create', 'update'),
      ...can(CONTACT, 'read', 'create', 'update', 'delete'),
      ...can(SERVICE, 'read'),
      ...can(QUOTATION, 'read', 'create', 'update'),
      ...can(INVOICE, 'read'),
      'reports.personal',
    ],
  },
  {
    key: 'svc_accounts',
    name: { en: 'Accounts', hi: 'लेखा' },
    description: {
      en: 'Raises invoices, records payments and follows up dues',
      hi: 'चालान बनाते हैं, भुगतान दर्ज करते हैं और बकाया की वसूली देखते हैं',
    },
    permissions: [
      ...can(CLIENT, 'read', 'update'),
      ...can(CONTACT, 'read'),
      ...can(SERVICE, 'read', 'create', 'update'),
      ...can(QUOTATION, 'read'),
      ...can(INVOICE, 'read', 'create', 'update'),
      ...can(PAYMENT, 'read', 'create', 'update'),
      'reports.personal',
      'reports.export',
    ],
  },
];

// ---- sample data ----

const SAMPLES: PackSample[] = [
  {
    ref: 'svc_web',
    entity: SERVICE,
    data: {
      name: 'Website design and build',
      code: 'WEB',
      unit: 'fixed',
      price: '150000',
      active: true,
    },
  },
  {
    ref: 'svc_seo',
    entity: SERVICE,
    data: { name: 'SEO retainer', code: 'SEO', unit: 'month', price: '40000', active: true },
  },
  {
    ref: 'svc_consult',
    entity: SERVICE,
    data: { name: 'Consulting', code: 'CONS', unit: 'hour', price: '3000', active: true },
  },
  {
    ref: 'client_deccan',
    entity: CLIENT,
    data: {
      name: 'Deccan Foods Pvt Ltd',
      email: 'accounts@deccanfoods.example',
      phone: '+914023456789',
      address: 'Plot 12, HITEC City, Hyderabad 500081',
      city: 'Hyderabad',
      payment_terms: 30,
    },
  },
  {
    ref: 'client_nimbus',
    entity: CLIENT,
    data: {
      name: 'Nimbus Software LLP',
      email: 'finance@nimbus.example',
      phone: '+918041234567',
      address: '4th Floor, Koramangala, Bengaluru 560034',
      city: 'Bengaluru',
      payment_terms: 15,
    },
  },
  {
    ref: 'contact_priya',
    entity: CONTACT,
    data: {
      name: 'Priya Reddy',
      client: '@client_deccan',
      designation: 'Marketing Manager',
      email: 'priya@deccanfoods.example',
      phone: '+919876543210',
      primary: true,
    },
  },
  {
    ref: 'quote_deccan',
    entity: QUOTATION,
    data: {
      customer: '@client_deccan',
      client_email: 'accounts@deccanfoods.example',
      date: '2026-09-01',
      valid_until: '2026-09-30',
      subject: 'Website redesign and search marketing',
      lines: [
        { item: '@svc_web', description: 'Website design and build', qty: 1, rate: '150000' },
        { item: '@svc_seo', description: 'SEO retainer (first month)', qty: 1, rate: '40000' },
      ],
      terms: '50% on signing, 50% on launch.',
    },
  },
  {
    ref: 'invoice_deccan',
    entity: INVOICE,
    data: {
      customer: '@client_deccan',
      quotation: '@quote_deccan',
      client_email: 'accounts@deccanfoods.example',
      date: '2026-09-10',
      terms_days: 30,
      lines: [
        {
          item: '@svc_web',
          description: 'Website design and build (50% advance)',
          qty: 1,
          rate: '75000',
        },
      ],
      amount_paid: '50000',
    },
  },
  {
    ref: 'invoice_nimbus',
    entity: INVOICE,
    data: {
      customer: '@client_nimbus',
      client_email: 'finance@nimbus.example',
      date: '2026-09-15',
      terms_days: 15,
      lines: [
        {
          item: '@svc_consult',
          description: 'Consulting, architecture review',
          qty: 12,
          rate: '3000',
        },
      ],
    },
  },
  {
    ref: 'payment_deccan',
    entity: PAYMENT,
    data: {
      invoice: '@invoice_deccan',
      customer: '@client_deccan',
      client_email: 'accounts@deccanfoods.example',
      date: '2026-09-20',
      amount: '50000',
      mode: 'bank_transfer',
      reference: 'UTR HDFC260920001234',
    },
  },
];

export const SERVICES: PackManifest = {
  id: 'industry.services',
  type: 'industry',
  version: '1.0.0',
  name: { en: 'Services', hi: 'सेवाएँ' },
  description: {
    en: 'For agencies and professional services firms: clients and contacts, a service catalogue, quotations with approval above an amount, invoices emailed to the client, payments and receipts, ageing of dues and an Owner dashboard.',
    hi: 'एजेंसियों और पेशेवर सेवा फ़र्मों के लिए: क्लाइंट और संपर्क, सेवा सूची, एक राशि से ऊपर स्वीकृति वाले कोटेशन, क्लाइंट को ईमेल होने वाले चालान, भुगतान और रसीदें, बकाया की अवधि और मालिक डैशबोर्ड।',
  },
  suggestFor: ['services', 'agency', 'consulting'],
  uses: ['tax'],
  layer: {
    entities: ENTITIES,
    picklists: PICKLISTS,
    forms: FORMS,
    listViews: LIST_VIEWS,
    numbering: NUMBERING,
    workflows: WORKFLOWS,
    rules: [],
    automations: AUTOMATIONS,
    templates: TEMPLATES,
    printTemplates: PRINT_TEMPLATES,
    reports: REPORTS,
    dashboards: DASHBOARDS,
  },
  roles: ROLE_TEMPLATES,
  samples: SAMPLES,
};
