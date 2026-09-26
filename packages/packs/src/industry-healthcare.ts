import type {
  AutomationDef,
  DashboardDef,
  EntityPatch,
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
  RuleDef,
  WorkflowDef,
} from '@erp/metadata';
import { ROLES } from './conventions';

/**
 * Healthcare Industry Pack: a clinic or polyclinic. Patients (with a UHID), doctors,
 * appointments, consultations with a prescription, bills with line items from a service
 * (charge) master, and payments.
 *
 * Roles for Country Packs: the patient is the `customer`, the service master the `item`,
 * the bill a `sales_invoice`. Services are also `tax_exempt`: in India, health care
 * services by a clinical establishment or a registered practitioner are exempt from GST,
 * so the India pack defaults each service to "Exempt" (a company can set a GST rate on
 * services that are not, e.g. cosmetic procedures or medicines it sells).
 */

// ---- option lists ----

const PICKLISTS: PicklistDef[] = [
  {
    key: 'hc_gender',
    label: { en: 'Gender', hi: 'लिंग' },
    options: [
      { value: 'male', label: { en: 'Male', hi: 'पुरुष' } },
      { value: 'female', label: { en: 'Female', hi: 'महिला' } },
      { value: 'other', label: { en: 'Other', hi: 'अन्य' } },
    ],
  },
  {
    key: 'hc_blood_groups',
    label: { en: 'Blood groups', hi: 'रक्त समूह' },
    options: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((g) => ({
      value: g,
      label: { en: g },
    })),
  },
  {
    key: 'hc_service_categories',
    label: { en: 'Service categories', hi: 'सेवा श्रेणियाँ' },
    options: [
      { value: 'consultation', label: { en: 'Consultation', hi: 'परामर्श' } },
      { value: 'procedure', label: { en: 'Procedure', hi: 'प्रक्रिया' } },
      { value: 'diagnostic', label: { en: 'Diagnostics / lab', hi: 'जाँच / लैब' } },
      { value: 'pharmacy', label: { en: 'Pharmacy', hi: 'फ़ार्मेसी' } },
      { value: 'other', label: { en: 'Other', hi: 'अन्य' } },
    ],
  },
  {
    key: 'hc_payment_modes',
    label: { en: 'Payment modes', hi: 'भुगतान के तरीके' },
    options: [
      { value: 'cash', label: { en: 'Cash', hi: 'नकद' } },
      { value: 'upi', label: { en: 'UPI', hi: 'यूपीआई' } },
      { value: 'card', label: { en: 'Card', hi: 'कार्ड' } },
      { value: 'bank', label: { en: 'Bank transfer', hi: 'बैंक ट्रांसफ़र' } },
      { value: 'insurance', label: { en: 'Insurance / TPA', hi: 'बीमा / टीपीए' } },
    ],
  },
  {
    key: 'hc_frequencies',
    label: { en: 'Dose frequency', hi: 'खुराक की आवृत्ति' },
    options: [
      { value: 'od', label: { en: 'Once a day (1-0-0)', hi: 'दिन में एक बार (1-0-0)' } },
      { value: 'bd', label: { en: 'Twice a day (1-0-1)', hi: 'दिन में दो बार (1-0-1)' } },
      { value: 'tds', label: { en: 'Three times a day (1-1-1)', hi: 'दिन में तीन बार (1-1-1)' } },
      { value: 'qid', label: { en: 'Four times a day', hi: 'दिन में चार बार' } },
      { value: 'hs', label: { en: 'At bedtime (0-0-1)', hi: 'सोते समय (0-0-1)' } },
      { value: 'sos', label: { en: 'When needed (SOS)', hi: 'ज़रूरत पड़ने पर (SOS)' } },
      { value: 'stat', label: { en: 'Immediately, once', hi: 'तुरंत, एक बार' } },
    ],
  },
];

// ---- number series ----

const NUMBERING: NumberingSeries[] = [
  {
    key: 'hc_uhid',
    label: { en: 'Patient UHID', hi: 'रोगी यूएचआईडी' },
    pattern: 'UHID/{BRANCH}/{SEQ:6}',
    reset: 'never',
    scope: 'org_unit',
  },
  {
    key: 'hc_appointment',
    label: { en: 'Appointment number', hi: 'अपॉइंटमेंट संख्या' },
    pattern: 'APT/{YY}{MM}/{SEQ:5}',
    reset: 'monthly',
    scope: 'org_unit',
  },
  {
    key: 'hc_visit',
    label: { en: 'Consultation number', hi: 'परामर्श संख्या' },
    pattern: 'OPD/{FY}/{SEQ:6}',
    reset: 'yearly',
    scope: 'org_unit',
  },
  {
    // Invoice-style numbering (unique per financial year and branch), as GST expects.
    key: 'hc_bill',
    label: { en: 'Bill number', hi: 'बिल संख्या' },
    pattern: 'BILL/{BRANCH}/{FY}/{SEQ:5}',
    reset: 'yearly',
    scope: 'org_unit',
  },
  {
    key: 'hc_payment',
    label: { en: 'Receipt number', hi: 'रसीद संख्या' },
    pattern: 'RCPT/{BRANCH}/{FY}/{SEQ:5}',
    reset: 'yearly',
    scope: 'org_unit',
  },
];

// ---- entities ----

/*
 * Patient data is sensitive (phone, date of birth, clinical notes). The metadata has no
 * field-level sensitivity or masking yet, so clinical notes live on the Visit, which
 * the Front desk role cannot read; demographics stay on the Patient.
 */
const ENTITIES: EntityPatch[] = [
  {
    key: 'hc_patient',
    kind: 'custom',
    label: { en: 'Patient', hi: 'रोगी' },
    pluralLabel: { en: 'Patients', hi: 'रोगी' },
    icon: 'person-heart',
    titleField: 'name',
    orgScoped: true,
    roles: [ROLES.customer],
    fields: [
      {
        key: 'uhid',
        type: 'autonumber',
        label: { en: 'UHID', hi: 'यूएचआईडी' },
        numbering: 'hc_uhid',
        help: { en: 'Unique health identification number', hi: 'अद्वितीय स्वास्थ्य पहचान संख्या' },
      },
      {
        key: 'name',
        type: 'text',
        label: { en: 'Name', hi: 'नाम' },
        required: true,
        searchable: true,
        maxLength: 200,
      },
      {
        key: 'gender',
        type: 'select',
        picklist: 'hc_gender',
        label: { en: 'Gender', hi: 'लिंग' },
      },
      { key: 'date_of_birth', type: 'date', label: { en: 'Date of birth', hi: 'जन्म तिथि' } },
      {
        key: 'phone',
        type: 'phone',
        label: { en: 'Mobile', hi: 'मोबाइल' },
        required: true,
        searchable: true,
      },
      { key: 'email', type: 'email', label: { en: 'Email', hi: 'ईमेल' } },
      { key: 'address', type: 'longtext', label: { en: 'Address', hi: 'पता' } },
      { key: 'city', type: 'text', label: { en: 'City', hi: 'शहर' } },
      {
        key: 'blood_group',
        type: 'select',
        picklist: 'hc_blood_groups',
        label: { en: 'Blood group', hi: 'रक्त समूह' },
      },
      { key: 'allergies', type: 'longtext', label: { en: 'Allergies', hi: 'एलर्जी' } },
      {
        key: 'emergency_contact',
        type: 'text',
        label: { en: 'Emergency contact', hi: 'आपातकालीन संपर्क' },
      },
      {
        key: 'emergency_phone',
        type: 'phone',
        label: { en: 'Emergency phone', hi: 'आपातकालीन फ़ोन' },
      },
      {
        key: 'abha_id',
        type: 'text',
        label: { en: 'ABHA number', hi: 'आभा संख्या' },
        help: {
          en: 'Ayushman Bharat Health Account number, 14 digits',
          hi: 'आयुष्मान भारत स्वास्थ्य खाता संख्या, 14 अंक',
        },
        pattern: '^[0-9]{2}-?[0-9]{4}-?[0-9]{4}-?[0-9]{4}$',
      },
    ],
  },
  {
    key: 'hc_doctor',
    kind: 'custom',
    label: { en: 'Doctor', hi: 'डॉक्टर' },
    pluralLabel: { en: 'Doctors', hi: 'डॉक्टर' },
    icon: 'person-badge',
    titleField: 'name',
    orgScoped: true,
    fields: [
      {
        key: 'name',
        type: 'text',
        label: { en: 'Name', hi: 'नाम' },
        required: true,
        searchable: true,
      },
      {
        key: 'specialisation',
        type: 'text',
        label: { en: 'Specialisation', hi: 'विशेषज्ञता' },
      },
      { key: 'qualification', type: 'text', label: { en: 'Qualification', hi: 'योग्यता' } },
      {
        key: 'registration_no',
        type: 'text',
        label: { en: 'Medical registration no.', hi: 'चिकित्सा पंजीकरण संख्या' },
      },
      { key: 'phone', type: 'phone', label: { en: 'Mobile', hi: 'मोबाइल' } },
      { key: 'email', type: 'email', label: { en: 'Email', hi: 'ईमेल' } },
      {
        key: 'user',
        type: 'lookup',
        target: 'user',
        label: { en: 'User account', hi: 'उपयोगकर्ता खाता' },
        help: {
          en: 'The doctor’s login, to receive notifications',
          hi: 'सूचनाएँ पाने के लिए डॉक्टर का लॉगिन',
        },
      },
      {
        key: 'consultation_fee',
        type: 'currency',
        label: { en: 'Consultation fee', hi: 'परामर्श शुल्क' },
        min: 0,
      },
      { key: 'active', type: 'boolean', label: { en: 'Active', hi: 'सक्रिय' }, default: true },
    ],
  },
  {
    // The charge master: consultations, procedures, tests and items billed.
    key: 'hc_service',
    kind: 'custom',
    label: { en: 'Service', hi: 'सेवा' },
    pluralLabel: { en: 'Services and charges', hi: 'सेवाएँ और शुल्क' },
    icon: 'list-check',
    titleField: 'name',
    orgScoped: false,
    roles: [ROLES.item, ROLES.taxExempt],
    fields: [
      {
        key: 'name',
        type: 'text',
        label: { en: 'Name', hi: 'नाम' },
        required: true,
        searchable: true,
      },
      { key: 'code', type: 'text', label: { en: 'Code', hi: 'कोड' }, unique: true },
      {
        key: 'category',
        type: 'select',
        picklist: 'hc_service_categories',
        label: { en: 'Category', hi: 'श्रेणी' },
      },
      {
        key: 'price',
        type: 'currency',
        label: { en: 'Charge', hi: 'शुल्क' },
        required: true,
        min: 0,
      },
      { key: 'active', type: 'boolean', label: { en: 'Active', hi: 'सक्रिय' }, default: true },
    ],
  },
  {
    key: 'hc_appointment',
    kind: 'custom',
    label: { en: 'Appointment', hi: 'अपॉइंटमेंट' },
    pluralLabel: { en: 'Appointments', hi: 'अपॉइंटमेंट' },
    icon: 'calendar-check',
    titleField: 'appointment_no',
    orgScoped: true,
    fields: [
      {
        key: 'appointment_no',
        type: 'autonumber',
        label: { en: 'Appointment no.', hi: 'अपॉइंटमेंट संख्या' },
        numbering: 'hc_appointment',
      },
      {
        key: 'patient',
        type: 'lookup',
        target: 'hc_patient',
        label: { en: 'Patient', hi: 'रोगी' },
        required: true,
      },
      {
        key: 'doctor',
        type: 'lookup',
        target: 'hc_doctor',
        label: { en: 'Doctor', hi: 'डॉक्टर' },
        required: true,
      },
      { key: 'date', type: 'date', label: { en: 'Date', hi: 'तारीख' }, required: true },
      { key: 'slot_time', type: 'time', label: { en: 'Time', hi: 'समय' }, required: true },
      { key: 'reason', type: 'text', label: { en: 'Reason for visit', hi: 'आने का कारण' } },
      {
        key: 'patient_phone',
        type: 'phone',
        label: { en: 'Patient mobile', hi: 'रोगी का मोबाइल' },
        defaultFrom: 'patient.phone',
      },
      {
        key: 'patient_email',
        type: 'email',
        label: { en: 'Patient email', hi: 'रोगी का ईमेल' },
        defaultFrom: 'patient.email',
      },
      {
        key: 'doctor_user',
        type: 'lookup',
        target: 'user',
        label: { en: 'Doctor’s user account', hi: 'डॉक्टर का उपयोगकर्ता खाता' },
        defaultFrom: 'doctor.user',
      },
      { key: 'notes', type: 'longtext', label: { en: 'Notes', hi: 'टिप्पणी' } },
    ],
  },
  {
    // One consultation: vitals, clinical notes and the prescription.
    key: 'hc_visit',
    kind: 'custom',
    label: { en: 'Consultation', hi: 'परामर्श' },
    pluralLabel: { en: 'Consultations', hi: 'परामर्श' },
    icon: 'clipboard2-pulse',
    titleField: 'visit_no',
    orgScoped: true,
    fields: [
      {
        key: 'visit_no',
        type: 'autonumber',
        label: { en: 'OPD no.', hi: 'ओपीडी संख्या' },
        numbering: 'hc_visit',
      },
      {
        key: 'patient',
        type: 'lookup',
        target: 'hc_patient',
        label: { en: 'Patient', hi: 'रोगी' },
        required: true,
      },
      {
        key: 'doctor',
        type: 'lookup',
        target: 'hc_doctor',
        label: { en: 'Doctor', hi: 'डॉक्टर' },
        required: true,
      },
      {
        key: 'appointment',
        type: 'lookup',
        target: 'hc_appointment',
        label: { en: 'Appointment', hi: 'अपॉइंटमेंट' },
      },
      { key: 'date', type: 'date', label: { en: 'Date', hi: 'तारीख' }, required: true },
      {
        key: 'bp',
        type: 'text',
        label: { en: 'Blood pressure (mmHg)', hi: 'रक्तचाप (mmHg)' },
        pattern: '^[0-9]{2,3}/[0-9]{2,3}$',
      },
      {
        key: 'pulse',
        type: 'integer',
        label: { en: 'Pulse (/min)', hi: 'नाड़ी (/मिनट)' },
        min: 20,
        max: 250,
      },
      {
        key: 'temperature',
        type: 'decimal',
        label: { en: 'Temperature (°F)', hi: 'तापमान (°F)' },
        scale: 1,
        min: 90,
        max: 110,
      },
      {
        key: 'spo2',
        type: 'integer',
        label: { en: 'SpO₂ (%)', hi: 'SpO₂ (%)' },
        min: 50,
        max: 100,
      },
      {
        key: 'weight',
        type: 'decimal',
        label: { en: 'Weight (kg)', hi: 'वज़न (किग्रा)' },
        scale: 1,
        min: 0,
        max: 400,
      },
      {
        key: 'complaints',
        type: 'longtext',
        label: { en: 'Chief complaints', hi: 'मुख्य शिकायतें' },
      },
      {
        key: 'findings',
        type: 'longtext',
        label: { en: 'Examination findings', hi: 'जाँच के निष्कर्ष' },
      },
      { key: 'diagnosis', type: 'longtext', label: { en: 'Diagnosis', hi: 'निदान' } },
      {
        key: 'prescription',
        type: 'table',
        label: { en: 'Prescription', hi: 'पर्चा' },
        maxRows: 50,
        columns: [
          {
            key: 'medicine',
            type: 'text',
            label: { en: 'Medicine', hi: 'दवा' },
            required: true,
          },
          { key: 'dose', type: 'text', label: { en: 'Dose', hi: 'खुराक' } },
          {
            key: 'frequency',
            type: 'select',
            picklist: 'hc_frequencies',
            label: { en: 'Frequency', hi: 'आवृत्ति' },
          },
          {
            key: 'days',
            type: 'integer',
            label: { en: 'Days', hi: 'दिन' },
            min: 1,
            max: 365,
          },
          { key: 'instructions', type: 'text', label: { en: 'Instructions', hi: 'निर्देश' } },
        ],
      },
      {
        key: 'investigations',
        type: 'longtext',
        label: { en: 'Tests advised', hi: 'सुझाई गई जाँचें' },
      },
      { key: 'advice', type: 'longtext', label: { en: 'Advice', hi: 'सलाह' } },
      {
        key: 'follow_up_date',
        type: 'date',
        label: { en: 'Follow-up on', hi: 'अगली जाँच की तारीख' },
      },
      {
        key: 'private_notes',
        type: 'longtext',
        label: { en: 'Doctor’s private notes', hi: 'डॉक्टर के निजी नोट' },
        help: { en: 'Not printed on the prescription', hi: 'पर्चे पर नहीं छपते' },
      },
    ],
  },
  {
    key: 'hc_bill',
    kind: 'custom',
    label: { en: 'Bill', hi: 'बिल' },
    pluralLabel: { en: 'Bills', hi: 'बिल' },
    icon: 'receipt',
    titleField: 'bill_no',
    orgScoped: true,
    roles: [ROLES.salesInvoice],
    tax: { lines: 'lines', amount: 'amount', document: 'invoice' },
    fields: [
      {
        key: 'bill_no',
        type: 'autonumber',
        label: { en: 'Bill no.', hi: 'बिल संख्या' },
        numbering: 'hc_bill',
      },
      {
        key: 'customer',
        type: 'lookup',
        target: 'hc_patient',
        label: { en: 'Patient', hi: 'रोगी' },
        required: true,
      },
      { key: 'date', type: 'date', label: { en: 'Date', hi: 'तारीख' }, required: true },
      {
        key: 'doctor',
        type: 'lookup',
        target: 'hc_doctor',
        label: { en: 'Doctor', hi: 'डॉक्टर' },
      },
      {
        key: 'visit',
        type: 'lookup',
        target: 'hc_visit',
        label: { en: 'Consultation', hi: 'परामर्श' },
      },
      {
        key: 'lines',
        type: 'table',
        label: { en: 'Services', hi: 'सेवाएँ' },
        columns: [
          {
            key: 'item',
            type: 'lookup',
            target: 'hc_service',
            label: { en: 'Service', hi: 'सेवा' },
          },
          { key: 'description', type: 'text', label: { en: 'Description', hi: 'विवरण' } },
          {
            key: 'qty',
            type: 'integer',
            label: { en: 'Qty', hi: 'मात्रा' },
            required: true,
            min: 1,
            default: 1,
          },
          {
            key: 'rate',
            type: 'currency',
            label: { en: 'Rate', hi: 'दर' },
            defaultFrom: 'item.price',
            min: 0,
          },
          {
            key: 'amount',
            type: 'formula',
            label: { en: 'Amount', hi: 'राशि' },
            formula: 'qty * rate',
            resultType: 'number',
          },
        ],
      },
      {
        key: 'payment_mode',
        type: 'select',
        picklist: 'hc_payment_modes',
        label: { en: 'Paid by', hi: 'भुगतान का तरीका' },
      },
      {
        key: 'patient_email',
        type: 'email',
        label: { en: 'Email the bill to', hi: 'बिल ईमेल करें' },
        defaultFrom: 'customer.email',
      },
      { key: 'notes', type: 'longtext', label: { en: 'Notes', hi: 'टिप्पणी' } },
    ],
  },
  {
    key: 'hc_payment',
    kind: 'custom',
    label: { en: 'Payment', hi: 'भुगतान' },
    pluralLabel: { en: 'Payments', hi: 'भुगतान' },
    icon: 'cash-coin',
    titleField: 'receipt_no',
    orgScoped: true,
    fields: [
      {
        key: 'receipt_no',
        type: 'autonumber',
        label: { en: 'Receipt no.', hi: 'रसीद संख्या' },
        numbering: 'hc_payment',
      },
      { key: 'bill', type: 'lookup', target: 'hc_bill', label: { en: 'Bill', hi: 'बिल' } },
      {
        key: 'patient',
        type: 'lookup',
        target: 'hc_patient',
        label: { en: 'Patient', hi: 'रोगी' },
        required: true,
        defaultFrom: 'bill.customer',
      },
      { key: 'date', type: 'date', label: { en: 'Date', hi: 'तारीख' }, required: true },
      {
        key: 'amount',
        type: 'currency',
        label: { en: 'Amount', hi: 'राशि' },
        required: true,
        min: 0.01,
      },
      {
        key: 'mode',
        type: 'select',
        picklist: 'hc_payment_modes',
        label: { en: 'Mode', hi: 'तरीका' },
        required: true,
      },
      {
        key: 'reference',
        type: 'text',
        label: {
          en: 'Reference (UPI / card / claim no.)',
          hi: 'संदर्भ (यूपीआई / कार्ड / दावा सं.)',
        },
      },
      { key: 'notes', type: 'text', label: { en: 'Notes', hi: 'टिप्पणी' } },
    ],
  },
];

// ---- forms and lists (only for entities no Country Pack extends, so no field is hidden) ----

const FORMS: FormLayout[] = [
  {
    entity: 'hc_appointment',
    sections: [
      {
        key: 'booking',
        label: { en: 'Booking', hi: 'बुकिंग' },
        columns: 2,
        fields: ['patient', 'doctor', 'date', 'slot_time', 'reason'],
      },
      {
        key: 'contact',
        label: { en: 'Contact for reminders', hi: 'अनुस्मारक के लिए संपर्क' },
        columns: 2,
        fields: ['patient_phone', 'patient_email', 'doctor_user', 'notes'],
      },
    ],
  },
  {
    entity: 'hc_visit',
    sections: [
      {
        key: 'visit',
        label: { en: 'Consultation', hi: 'परामर्श' },
        columns: 2,
        fields: ['patient', 'doctor', 'appointment', 'date'],
      },
      {
        key: 'vitals',
        label: { en: 'Vitals', hi: 'जीवन संकेत' },
        columns: 3,
        fields: ['bp', 'pulse', 'temperature', 'spo2', 'weight'],
      },
      {
        key: 'clinical',
        label: { en: 'Clinical notes', hi: 'नैदानिक नोट' },
        columns: 1,
        fields: ['complaints', 'findings', 'diagnosis'],
      },
      {
        key: 'rx',
        label: { en: 'Prescription', hi: 'पर्चा' },
        columns: 1,
        fields: ['prescription', 'investigations', 'advice', 'follow_up_date'],
      },
      {
        key: 'private',
        label: { en: 'Private', hi: 'निजी' },
        columns: 1,
        fields: ['private_notes'],
      },
    ],
  },
];

const LIST_VIEWS: ListView[] = [
  {
    entity: 'hc_patient',
    columns: ['uhid', 'name', 'gender', 'phone', 'city', 'createdAt'],
    sort: { field: 'createdAt', dir: 'desc' },
  },
  {
    entity: 'hc_doctor',
    columns: ['name', 'specialisation', 'phone', 'consultation_fee', 'active'],
  },
  { entity: 'hc_service', columns: ['code', 'name', 'category', 'price', 'active'] },
  {
    entity: 'hc_appointment',
    columns: ['date', 'slot_time', 'appointment_no', 'patient', 'doctor', 'reason', 'status'],
    sort: { field: 'date', dir: 'desc' },
  },
  {
    entity: 'hc_visit',
    columns: ['date', 'visit_no', 'patient', 'doctor', 'diagnosis', 'follow_up_date'],
    sort: { field: 'date', dir: 'desc' },
  },
  {
    entity: 'hc_bill',
    columns: ['date', 'bill_no', 'customer', 'doctor', 'payment_mode', 'status'],
    sort: { field: 'date', dir: 'desc' },
  },
  {
    entity: 'hc_payment',
    columns: ['date', 'receipt_no', 'patient', 'bill', 'amount', 'mode'],
    sort: { field: 'date', dir: 'desc' },
  },
];

// ---- workflows and rules ----

const WORKFLOWS: WorkflowDef[] = [
  {
    entity: 'hc_appointment',
    initialState: 'booked',
    states: [
      { key: 'booked', label: { en: 'Booked', hi: 'बुक' }, color: '#0d6efd' },
      { key: 'checked_in', label: { en: 'Checked in', hi: 'पहुँच गए' }, color: '#fd7e14' },
      {
        key: 'completed',
        label: { en: 'Completed', hi: 'पूर्ण' },
        color: '#198754',
        locked: true,
      },
      {
        key: 'cancelled',
        label: { en: 'Cancelled', hi: 'रद्द' },
        color: '#6c757d',
        locked: true,
      },
      {
        key: 'no_show',
        label: { en: 'Did not come', hi: 'नहीं आए' },
        color: '#dc3545',
        locked: true,
      },
    ],
    actions: [
      {
        key: 'check_in',
        label: { en: 'Check in', hi: 'चेक इन' },
        from: ['booked'],
        to: 'checked_in',
        roleKeys: ['front_desk'],
      },
      {
        key: 'complete',
        label: { en: 'Mark seen', hi: 'देख लिया' },
        from: ['checked_in'],
        to: 'completed',
        roleKeys: ['doctor', 'front_desk'],
      },
      {
        key: 'cancel',
        label: { en: 'Cancel', hi: 'रद्द करें' },
        from: ['booked', 'checked_in'],
        to: 'cancelled',
        roleKeys: ['front_desk'],
        commentRequired: true,
      },
      {
        key: 'no_show',
        label: { en: 'Did not come', hi: 'नहीं आए' },
        from: ['booked'],
        to: 'no_show',
        roleKeys: ['front_desk'],
      },
      {
        key: 'rebook',
        label: { en: 'Book again', hi: 'फिर से बुक करें' },
        from: ['cancelled', 'no_show'],
        to: 'booked',
        roleKeys: ['front_desk'],
      },
    ],
  },
  {
    entity: 'hc_bill',
    initialState: 'draft',
    states: [
      { key: 'draft', label: { en: 'Draft', hi: 'मसौदा' }, color: '#6c757d' },
      {
        key: 'issued',
        label: { en: 'Issued', hi: 'जारी' },
        color: '#198754',
        locked: true,
        editableFields: ['payment_mode', 'notes'],
      },
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
        roleKeys: ['billing', 'front_desk'],
      },
      {
        key: 'cancel',
        label: { en: 'Cancel', hi: 'रद्द करें' },
        from: ['draft', 'issued'],
        to: 'cancelled',
        roleKeys: ['billing'],
        commentRequired: true,
      },
    ],
  },
];

const RULES: RuleDef[] = [
  {
    key: 'hc_follow_up_after_visit',
    entity: 'hc_visit',
    on: 'save',
    condition: 'AND(NOT(IS_EMPTY(follow_up_date)), follow_up_date < date)',
    effect: 'block',
    message: {
      en: 'The follow-up date cannot be before the consultation',
      hi: 'अगली जाँच की तारीख परामर्श से पहले नहीं हो सकती',
    },
  },
  {
    key: 'hc_bill_needs_lines',
    entity: 'hc_bill',
    on: 'save',
    condition: 'COUNT(lines.qty) = 0',
    effect: 'block',
    message: { en: 'Add at least one service to the bill', hi: 'बिल में कम से कम एक सेवा जोड़ें' },
  },
];

// ---- notifications and automations ----

const TEMPLATES: MessageTemplate[] = [
  {
    key: 'hc.appointment_booked',
    label: { en: 'Appointment booked (to the doctor)', hi: 'अपॉइंटमेंट बुक (डॉक्टर को)' },
    title: {
      en: 'New appointment {{record.appointment_no}}',
      hi: 'नया अपॉइंटमेंट {{record.appointment_no}}',
    },
    body: {
      en: '{{record.patient}} is booked with you on {{record.date}} at {{record.slot_time}}. Reason: {{record.reason}}',
      hi: '{{record.patient}} आपके साथ {{record.date}} को {{record.slot_time}} बजे बुक हैं। कारण: {{record.reason}}',
    },
  },
  {
    key: 'hc.appointment_cancelled',
    label: { en: 'Appointment cancelled (to the doctor)', hi: 'अपॉइंटमेंट रद्द (डॉक्टर को)' },
    title: {
      en: 'Cancelled: appointment {{record.appointment_no}}',
      hi: 'रद्द: अपॉइंटमेंट {{record.appointment_no}}',
    },
    body: {
      en: 'The appointment of {{record.patient}} on {{record.date}} at {{record.slot_time}} was cancelled.',
      hi: '{{record.patient}} का {{record.date}} को {{record.slot_time}} बजे का अपॉइंटमेंट रद्द हो गया।',
    },
  },
];

const AUTOMATIONS: AutomationDef[] = [
  {
    // The evening before: the appointment slip is emailed to the patient as a reminder.
    key: 'hc_appointment_reminder',
    entity: 'hc_appointment',
    label: { en: 'Appointment reminder the day before', hi: 'एक दिन पहले अपॉइंटमेंट अनुस्मारक' },
    trigger: { type: 'schedule', every: 'day', at: '18:00' },
    condition:
      'AND(date = ADD_DAYS(TODAY(), 1), STATUS() = "booked", NOT(IS_EMPTY(patient_email)))',
    actions: [
      {
        type: 'document',
        template: 'hc_appointment_slip',
        emailFields: ['patient_email'],
        subject: 'Reminder: your appointment tomorrow',
        message:
          'This is a reminder of your appointment tomorrow. The appointment slip with the time and the doctor is attached. Please come 10 minutes early and bring your previous prescriptions and reports. To reschedule, call the front desk.',
      },
    ],
  },
  {
    key: 'hc_appointment_to_doctor',
    entity: 'hc_appointment',
    label: {
      en: 'Tell the doctor about a new appointment',
      hi: 'नए अपॉइंटमेंट की सूचना डॉक्टर को',
    },
    trigger: { type: 'created' },
    condition: 'NOT(IS_EMPTY(doctor_user))',
    actions: [
      {
        type: 'notify',
        template: 'hc.appointment_booked',
        recipients: [{ type: 'field', field: 'doctor_user' }],
        channels: ['inapp', 'push'],
      },
    ],
  },
  {
    key: 'hc_appointment_cancelled',
    entity: 'hc_appointment',
    label: {
      en: 'Tell the doctor and the front desk about a cancellation',
      hi: 'रद्द होने की सूचना डॉक्टर और फ्रंट डेस्क को',
    },
    trigger: { type: 'status_changed', to: 'cancelled' },
    actions: [
      {
        type: 'notify',
        template: 'hc.appointment_cancelled',
        recipients: [
          { type: 'field', field: 'doctor_user' },
          { type: 'role', roleKey: 'front_desk' },
        ],
        channels: ['inapp'],
      },
    ],
  },
  {
    key: 'hc_bill_email',
    entity: 'hc_bill',
    label: { en: 'Email the bill when issued', hi: 'जारी होने पर बिल ईमेल करें' },
    trigger: { type: 'status_changed', to: 'issued' },
    condition: 'NOT(IS_EMPTY(patient_email))',
    actions: [
      {
        type: 'document',
        template: 'hc_bill_receipt',
        emailFields: ['patient_email'],
        subject: 'Your bill',
        message: 'Thank you for visiting us. Your bill is attached.',
      },
    ],
  },
];

// ---- print templates ----

const letterhead = {
  id: 'head',
  type: 'letterhead' as const,
  lines: [{ en: '{{company.name}}' }, { en: '{{unit.name}}' }],
};

const PRINT_TEMPLATES: PrintTemplateDef[] = [
  {
    key: 'hc_appointment_slip',
    entity: 'hc_appointment',
    label: { en: 'Appointment slip', hi: 'अपॉइंटमेंट पर्ची' },
    page: { size: 'A5' },
    mode: 'blocks',
    fileName: 'Appointment-{{number}}',
    watermarks: [{ text: { en: 'CANCELLED', hi: 'रद्द' }, condition: 'STATUS() = "cancelled"' }],
    blocks: [
      letterhead,
      { id: 'title', type: 'title', text: { en: 'Appointment slip', hi: 'अपॉइंटमेंट पर्ची' } },
      {
        id: 'details',
        type: 'fields',
        columns: 2,
        items: [
          { path: 'appointment_no' },
          { path: 'date', format: 'date' },
          { path: 'slot_time' },
          { path: 'patient.name', label: { en: 'Patient', hi: 'रोगी' } },
          { path: 'patient.uhid', label: { en: 'UHID', hi: 'यूएचआईडी' } },
          { path: 'doctor.name', label: { en: 'Doctor', hi: 'डॉक्टर' } },
          { path: 'doctor.specialisation', label: { en: 'Department', hi: 'विभाग' } },
          { path: 'reason' },
        ],
      },
      { id: 'qr', type: 'qr', value: '{{number}}', size: 25, align: 'center' },
      {
        id: 'note',
        type: 'text',
        size: 9,
        text: {
          en: 'Please arrive 10 minutes early and bring your previous prescriptions and reports.',
          hi: 'कृपया 10 मिनट पहले आएँ और पिछले पर्चे व रिपोर्ट साथ लाएँ।',
        },
      },
    ],
  },
  {
    key: 'hc_prescription',
    entity: 'hc_visit',
    label: { en: 'Prescription', hi: 'पर्चा' },
    page: { size: 'A4' },
    mode: 'blocks',
    fileName: 'Prescription-{{number}}',
    auditPrints: true,
    footer: {
      text: {
        en: 'Consult your doctor before changing any medicine.',
        hi: 'कोई भी दवा बदलने से पहले अपने डॉक्टर से सलाह लें।',
      },
      pageNumbers: true,
    },
    blocks: [
      letterhead,
      {
        id: 'doctor',
        type: 'text',
        bold: true,
        text: {
          en: '{{doctor.name}}, {{doctor.qualification}} · {{doctor.specialisation}} · Reg. no. {{doctor.registration_no}}',
          hi: '{{doctor.name}}, {{doctor.qualification}} · {{doctor.specialisation}} · पंजीकरण सं. {{doctor.registration_no}}',
        },
      },
      { id: 'd1', type: 'divider' },
      {
        id: 'patient',
        type: 'fields',
        columns: 3,
        items: [
          { path: 'patient.name', label: { en: 'Patient', hi: 'रोगी' } },
          { path: 'patient.uhid', label: { en: 'UHID', hi: 'यूएचआईडी' } },
          { path: 'date', format: 'date' },
          { path: 'patient.gender', label: { en: 'Gender', hi: 'लिंग' } },
          { path: 'patient.date_of_birth', label: { en: 'Date of birth', hi: 'जन्म तिथि' } },
          { path: 'visit_no' },
        ],
      },
      {
        id: 'vitals',
        type: 'fields',
        columns: 3,
        items: [
          { path: 'bp' },
          { path: 'pulse' },
          { path: 'temperature' },
          { path: 'spo2' },
          { path: 'weight' },
        ],
      },
      {
        id: 'allergies',
        type: 'text',
        bold: true,
        text: { en: 'Allergies: {{patient.allergies}}', hi: 'एलर्जी: {{patient.allergies}}' },
      },
      {
        id: 'clinical',
        type: 'fields',
        columns: 1,
        items: [{ path: 'complaints' }, { path: 'findings' }, { path: 'diagnosis' }],
      },
      { id: 'rx', type: 'title', text: { en: 'Rx' }, align: 'left', size: 16 },
      {
        id: 'medicines',
        type: 'table',
        source: 'prescription',
        numbered: true,
        columns: [
          { path: 'medicine', width: 34 },
          { path: 'dose', width: 14 },
          { path: 'frequency', width: 18 },
          { path: 'days', width: 8, format: 'number' },
          { path: 'instructions', width: 26 },
        ],
      },
      {
        id: 'advice',
        type: 'fields',
        columns: 1,
        items: [
          { path: 'investigations' },
          { path: 'advice' },
          { path: 'follow_up_date', format: 'date' },
        ],
      },
      {
        id: 'sign',
        type: 'signature',
        align: 'right',
        name: { en: '{{doctor.name}}' },
        title: { en: 'Signature', hi: 'हस्ताक्षर' },
      },
    ],
  },
  {
    key: 'hc_bill_receipt',
    entity: 'hc_bill',
    label: { en: 'Bill / receipt', hi: 'बिल / रसीद' },
    page: { size: 'A5' },
    mode: 'blocks',
    fileName: 'Bill-{{number}}',
    watermarks: [
      { text: { en: 'CANCELLED', hi: 'रद्द' }, condition: 'STATUS() = "cancelled"' },
      { text: { en: 'DRAFT', hi: 'मसौदा' }, condition: 'STATUS() = "draft"' },
    ],
    blocks: [
      letterhead,
      { id: 'title', type: 'title', text: { en: 'Bill / Receipt', hi: 'बिल / रसीद' } },
      {
        id: 'parties',
        type: 'fields',
        columns: 2,
        items: [
          { path: 'bill_no' },
          { path: 'date', format: 'date' },
          { path: 'customer.name', label: { en: 'Patient', hi: 'रोगी' } },
          { path: 'customer.uhid', label: { en: 'UHID', hi: 'यूएचआईडी' } },
          { path: 'doctor.name', label: { en: 'Doctor', hi: 'डॉक्टर' } },
          { path: 'payment_mode' },
        ],
      },
      {
        id: 'lines',
        type: 'table',
        source: 'lines',
        numbered: true,
        columns: [
          { path: 'item', width: 30 },
          { path: 'description', width: 30 },
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
          { label: { en: 'Subtotal', hi: 'उप-योग' }, value: 'subtotal', format: 'currency' },
          { label: { en: 'Tax', hi: 'कर' }, value: 'tax_total', format: 'currency' },
          { label: { en: 'Round off', hi: 'पूर्णांकन' }, value: 'round_off', format: 'currency' },
          {
            label: { en: 'Total', hi: 'कुल' },
            value: 'grand_total',
            format: 'currency',
            bold: true,
          },
        ],
        words: { value: 'grand_total', label: { en: 'Amount in words:', hi: 'राशि शब्दों में:' } },
      },
      {
        id: 'sign',
        type: 'signature',
        align: 'right',
        name: { en: 'For {{company.name}}', hi: '{{company.name}} के लिए' },
        title: { en: 'Cashier', hi: 'कैशियर' },
      },
    ],
  },
  {
    key: 'hc_payment_receipt',
    entity: 'hc_payment',
    label: { en: 'Payment receipt', hi: 'भुगतान रसीद' },
    page: { size: 'A5' },
    mode: 'blocks',
    fileName: 'Receipt-{{number}}',
    blocks: [
      letterhead,
      { id: 'title', type: 'title', text: { en: 'Payment receipt', hi: 'भुगतान रसीद' } },
      {
        id: 'details',
        type: 'fields',
        columns: 2,
        items: [
          { path: 'receipt_no' },
          { path: 'date', format: 'date' },
          { path: 'patient.name', label: { en: 'Received from', hi: 'प्राप्त किया' } },
          { path: 'patient.uhid', label: { en: 'UHID', hi: 'यूएचआईडी' } },
          { path: 'bill.bill_no', label: { en: 'Against bill', hi: 'बिल के विरुद्ध' } },
          { path: 'mode' },
          { path: 'reference' },
        ],
      },
      {
        id: 'amount',
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
        id: 'sign',
        type: 'signature',
        align: 'right',
        name: { en: 'For {{company.name}}', hi: '{{company.name}} के लिए' },
        title: { en: 'Cashier', hi: 'कैशियर' },
      },
    ],
  },
];

// ---- reports ----

const today = (path = 'date'): ReportFilter => ({
  path,
  op: 'relative',
  relative: { period: 'today' },
  prompt: true,
});
const thisMonth: ReportFilter = {
  path: 'date',
  op: 'relative',
  relative: { period: 'this_month' },
  prompt: true,
};
const notCancelled: ReportFilter = { path: 'status', op: 'ne', value: 'cancelled' };

const REPORTS: ReportDef[] = [
  {
    key: 'hc_appointments_today',
    label: { en: 'Today’s appointments', hi: 'आज के अपॉइंटमेंट' },
    entity: 'hc_appointment',
    dateField: 'date',
    columns: [
      { path: 'slot_time' },
      { path: 'appointment_no' },
      { path: 'patient.name', label: { en: 'Patient', hi: 'रोगी' } },
      { path: 'patient.phone', label: { en: 'Mobile', hi: 'मोबाइल' } },
      { path: 'doctor.name', label: { en: 'Doctor', hi: 'डॉक्टर' } },
      { path: 'reason' },
      { path: 'status' },
    ],
    filters: [today()],
    sort: [{ path: 'slot_time', dir: 'asc' }],
  },
  {
    key: 'hc_appointments_count',
    label: { en: 'Appointments today', hi: 'आज के अपॉइंटमेंट (संख्या)' },
    entity: 'hc_appointment',
    dateField: 'date',
    columns: [],
    filters: [today(), notCancelled],
    aggregates: [{ fn: 'count', label: { en: 'Appointments', hi: 'अपॉइंटमेंट' } }],
  },
  {
    key: 'hc_appointments_by_doctor',
    label: { en: 'Appointments by doctor', hi: 'डॉक्टर अनुसार अपॉइंटमेंट' },
    entity: 'hc_appointment',
    dateField: 'date',
    columns: [],
    filters: [thisMonth],
    groupBy: [{ path: 'doctor' }],
    aggregates: [{ fn: 'count', label: { en: 'Appointments', hi: 'अपॉइंटमेंट' } }],
    chart: { type: 'bar' },
  },
  {
    key: 'hc_appointments_by_status',
    label: { en: 'Appointments by doctor and outcome', hi: 'डॉक्टर व परिणाम अनुसार अपॉइंटमेंट' },
    entity: 'hc_appointment',
    dateField: 'date',
    columns: [],
    filters: [thisMonth],
    groupBy: [{ path: 'doctor' }, { path: 'status' }],
    aggregates: [{ fn: 'count', label: { en: 'Appointments', hi: 'अपॉइंटमेंट' } }],
    chart: { type: 'stacked_bar' },
  },
  {
    key: 'hc_visits_by_doctor',
    label: { en: 'Consultations by doctor', hi: 'डॉक्टर अनुसार परामर्श' },
    entity: 'hc_visit',
    dateField: 'date',
    columns: [],
    filters: [thisMonth],
    groupBy: [{ path: 'doctor' }],
    aggregates: [
      { fn: 'count', label: { en: 'Consultations', hi: 'परामर्श' } },
      { fn: 'count_distinct', path: 'patient', label: { en: 'Patients', hi: 'रोगी' } },
    ],
    chart: { type: 'bar' },
  },
  {
    key: 'hc_follow_ups_due',
    label: { en: 'Follow-ups due this week', hi: 'इस सप्ताह की अगली जाँचें' },
    entity: 'hc_visit',
    dateField: 'follow_up_date',
    columns: [
      { path: 'follow_up_date' },
      { path: 'patient.name', label: { en: 'Patient', hi: 'रोगी' } },
      { path: 'patient.phone', label: { en: 'Mobile', hi: 'मोबाइल' } },
      { path: 'doctor.name', label: { en: 'Doctor', hi: 'डॉक्टर' } },
      { path: 'visit_no' },
    ],
    filters: [
      {
        path: 'follow_up_date',
        op: 'relative',
        relative: { period: 'next_n_days', n: 7 },
        prompt: true,
      },
    ],
    sort: [{ path: 'follow_up_date', dir: 'asc' }],
  },
  {
    key: 'hc_revenue_by_service',
    label: { en: 'Revenue by service', hi: 'सेवा अनुसार आय' },
    entity: 'hc_bill',
    lines: 'lines',
    dateField: 'date',
    columns: [],
    filters: [thisMonth, notCancelled],
    groupBy: [{ path: 'lines.item' }],
    aggregates: [
      { fn: 'sum', path: 'lines.amount', label: { en: 'Amount', hi: 'राशि' } },
      { fn: 'sum', path: 'lines.qty', label: { en: 'Quantity', hi: 'मात्रा' } },
    ],
    chart: { type: 'bar' },
    roleKeys: ['billing', 'doctor'],
  },
  {
    key: 'hc_revenue_by_day',
    label: { en: 'Billing by day', hi: 'दिन अनुसार बिलिंग' },
    entity: 'hc_bill',
    dateField: 'date',
    columns: [],
    filters: [thisMonth, notCancelled],
    groupBy: [{ path: 'date', bucket: 'day' }],
    aggregates: [
      { fn: 'sum', path: 'grand_total', label: { en: 'Billed', hi: 'बिल राशि' } },
      { fn: 'count', label: { en: 'Bills', hi: 'बिल' } },
    ],
    chart: { type: 'line' },
    roleKeys: ['billing'],
  },
  {
    key: 'hc_revenue_by_doctor',
    label: { en: 'Billing by doctor', hi: 'डॉक्टर अनुसार बिलिंग' },
    entity: 'hc_bill',
    dateField: 'date',
    columns: [],
    filters: [thisMonth, notCancelled],
    groupBy: [{ path: 'doctor' }],
    aggregates: [
      { fn: 'sum', path: 'grand_total', label: { en: 'Billed', hi: 'बिल राशि' } },
      { fn: 'count', label: { en: 'Bills', hi: 'बिल' } },
    ],
    chart: { type: 'bar' },
    roleKeys: ['billing'],
  },
  {
    key: 'hc_collections_today',
    label: { en: 'Collected today', hi: 'आज का संग्रह' },
    entity: 'hc_payment',
    dateField: 'date',
    columns: [],
    filters: [today()],
    aggregates: [{ fn: 'sum', path: 'amount', label: { en: 'Collected', hi: 'संग्रह' } }],
    roleKeys: ['billing', 'front_desk'],
  },
  {
    key: 'hc_collections_by_mode',
    label: { en: 'Collections by payment mode', hi: 'भुगतान तरीके अनुसार संग्रह' },
    entity: 'hc_payment',
    dateField: 'date',
    columns: [],
    filters: [thisMonth],
    groupBy: [{ path: 'mode' }],
    aggregates: [
      { fn: 'sum', path: 'amount', label: { en: 'Collected', hi: 'संग्रह' } },
      { fn: 'count', label: { en: 'Receipts', hi: 'रसीदें' } },
    ],
    chart: { type: 'donut' },
    roleKeys: ['billing', 'front_desk'],
  },
];

// ---- dashboards ----

const DASHBOARDS: DashboardDef[] = [
  {
    key: 'hc_front_desk',
    label: { en: 'Front desk', hi: 'फ्रंट डेस्क' },
    roleKeys: ['front_desk'],
    home: true,
    filters: { orgUnit: true },
    widgets: [
      {
        id: 'appts',
        type: 'kpi',
        title: { en: 'Appointments today', hi: 'आज के अपॉइंटमेंट' },
        report: 'hc_appointments_count',
        x: 0,
        y: 0,
        w: 3,
        h: 2,
      },
      {
        id: 'collected',
        type: 'kpi',
        title: { en: 'Collected today', hi: 'आज का संग्रह' },
        report: 'hc_collections_today',
        x: 3,
        y: 0,
        w: 3,
        h: 2,
      },
      {
        id: 'links',
        type: 'links',
        title: { en: 'Quick actions', hi: 'त्वरित कार्य' },
        x: 6,
        y: 0,
        w: 6,
        h: 2,
        links: [
          { label: { en: 'New patient', hi: 'नया रोगी' }, href: '/r/hc_patient/new' },
          {
            label: { en: 'Book appointment', hi: 'अपॉइंटमेंट बुक करें' },
            href: '/r/hc_appointment/new',
          },
          { label: { en: 'New bill', hi: 'नया बिल' }, href: '/r/hc_bill/new' },
          { label: { en: 'Take payment', hi: 'भुगतान लें' }, href: '/r/hc_payment/new' },
        ],
      },
      {
        id: 'today',
        type: 'list',
        title: { en: 'Today’s appointments', hi: 'आज के अपॉइंटमेंट' },
        report: 'hc_appointments_today',
        limit: 30,
        x: 0,
        y: 2,
        w: 8,
        h: 6,
      },
      {
        id: 'by_doctor',
        type: 'chart',
        report: 'hc_appointments_by_doctor',
        x: 8,
        y: 2,
        w: 4,
        h: 6,
      },
      {
        id: 'follow_ups',
        type: 'list',
        report: 'hc_follow_ups_due',
        limit: 20,
        x: 0,
        y: 8,
        w: 12,
        h: 4,
      },
    ],
  },
  {
    key: 'hc_doctor',
    label: { en: 'Doctor', hi: 'डॉक्टर' },
    roleKeys: ['doctor'],
    home: true,
    widgets: [
      {
        id: 'appts',
        type: 'kpi',
        title: { en: 'Appointments today', hi: 'आज के अपॉइंटमेंट' },
        report: 'hc_appointments_count',
        x: 0,
        y: 0,
        w: 4,
        h: 2,
      },
      {
        id: 'links',
        type: 'links',
        x: 4,
        y: 0,
        w: 8,
        h: 2,
        links: [
          { label: { en: 'New consultation', hi: 'नया परामर्श' }, href: '/r/hc_visit/new' },
          { label: { en: 'Patients', hi: 'रोगी' }, href: '/r/hc_patient' },
        ],
      },
      {
        id: 'today',
        type: 'list',
        title: { en: 'Today’s appointments', hi: 'आज के अपॉइंटमेंट' },
        report: 'hc_appointments_today',
        limit: 30,
        x: 0,
        y: 2,
        w: 8,
        h: 6,
      },
      {
        id: 'visits',
        type: 'chart',
        report: 'hc_visits_by_doctor',
        x: 8,
        y: 2,
        w: 4,
        h: 6,
      },
      {
        id: 'follow_ups',
        type: 'list',
        report: 'hc_follow_ups_due',
        limit: 20,
        x: 0,
        y: 8,
        w: 12,
        h: 4,
      },
    ],
  },
  {
    key: 'hc_billing',
    label: { en: 'Billing', hi: 'बिलिंग' },
    roleKeys: ['billing'],
    home: true,
    filters: { dateRange: true, orgUnit: true },
    widgets: [
      {
        id: 'collected',
        type: 'kpi',
        title: { en: 'Collected today', hi: 'आज का संग्रह' },
        report: 'hc_collections_today',
        x: 0,
        y: 0,
        w: 4,
        h: 2,
      },
      {
        id: 'by_day',
        type: 'chart',
        report: 'hc_revenue_by_day',
        x: 0,
        y: 2,
        w: 8,
        h: 5,
      },
      {
        id: 'by_mode',
        type: 'chart',
        report: 'hc_collections_by_mode',
        x: 8,
        y: 2,
        w: 4,
        h: 5,
      },
      {
        id: 'by_service',
        type: 'chart',
        report: 'hc_revenue_by_service',
        x: 0,
        y: 7,
        w: 6,
        h: 5,
      },
      {
        id: 'by_doctor',
        type: 'chart',
        report: 'hc_revenue_by_doctor',
        x: 6,
        y: 7,
        w: 6,
        h: 5,
      },
    ],
  },
];

// ---- roles ----

const crud = (entity: string, ...actions: ('read' | 'create' | 'update' | 'delete')[]) =>
  actions.map((a) => `records.${entity}.${a}`);

const ROLE_TEMPLATES: PackRole[] = [
  {
    key: 'doctor',
    name: { en: 'Doctor', hi: 'डॉक्टर' },
    description: {
      en: 'Sees appointments and patients; writes consultations and prescriptions',
      hi: 'अपॉइंटमेंट और रोगी देखते हैं; परामर्श और पर्चे लिखते हैं',
    },
    permissions: [
      ...crud('hc_patient', 'read', 'update'),
      ...crud('hc_doctor', 'read'),
      ...crud('hc_service', 'read'),
      ...crud('hc_appointment', 'read', 'update'),
      ...crud('hc_visit', 'read', 'create', 'update'),
      ...crud('hc_bill', 'read'),
      'reports.personal',
    ],
  },
  {
    key: 'front_desk',
    name: { en: 'Front desk', hi: 'फ्रंट डेस्क' },
    description: {
      en: 'Registers patients, books appointments and takes payments; cannot read clinical notes',
      hi: 'रोगी पंजीकरण, अपॉइंटमेंट बुकिंग और भुगतान; नैदानिक नोट नहीं देख सकते',
    },
    permissions: [
      ...crud('hc_patient', 'read', 'create', 'update'),
      ...crud('hc_doctor', 'read'),
      ...crud('hc_service', 'read'),
      ...crud('hc_appointment', 'read', 'create', 'update'),
      ...crud('hc_bill', 'read', 'create', 'update'),
      ...crud('hc_payment', 'read', 'create'),
    ],
  },
  {
    key: 'billing',
    name: { en: 'Billing', hi: 'बिलिंग' },
    description: {
      en: 'Bills, payments and the service charge list',
      hi: 'बिल, भुगतान और सेवा शुल्क सूची',
    },
    permissions: [
      ...crud('hc_patient', 'read'),
      ...crud('hc_doctor', 'read'),
      ...crud('hc_service', 'read', 'create', 'update'),
      ...crud('hc_appointment', 'read'),
      ...crud('hc_bill', 'read', 'create', 'update'),
      ...crud('hc_payment', 'read', 'create', 'update'),
      'reports.personal',
      'reports.export',
    ],
  },
];

// ---- sample records ----

const SAMPLES: PackSample[] = [
  {
    ref: 'doc_general',
    entity: 'hc_doctor',
    data: {
      name: 'Dr. Anita Rao',
      specialisation: 'General medicine',
      qualification: 'MBBS, MD',
      registration_no: 'TSMC/2011/12345',
      phone: '+919800000101',
      consultation_fee: '500',
      active: true,
    },
  },
  {
    ref: 'doc_paeds',
    entity: 'hc_doctor',
    data: {
      name: 'Dr. Vikram Shah',
      specialisation: 'Paediatrics',
      qualification: 'MBBS, DCH',
      registration_no: 'TSMC/2014/23456',
      phone: '+919800000102',
      consultation_fee: '600',
      active: true,
    },
  },
  {
    ref: 'svc_consult',
    entity: 'hc_service',
    data: { code: 'CON-01', name: 'Consultation', category: 'consultation', price: '500' },
  },
  {
    ref: 'svc_follow_up',
    entity: 'hc_service',
    data: {
      code: 'CON-02',
      name: 'Follow-up consultation',
      category: 'consultation',
      price: '300',
    },
  },
  {
    ref: 'svc_ecg',
    entity: 'hc_service',
    data: { code: 'DX-01', name: 'ECG', category: 'diagnostic', price: '400' },
  },
  {
    ref: 'svc_dressing',
    entity: 'hc_service',
    data: { code: 'PR-01', name: 'Wound dressing', category: 'procedure', price: '250' },
  },
  {
    ref: 'pat_ravi',
    entity: 'hc_patient',
    data: {
      name: 'Ravi Kumar',
      gender: 'male',
      date_of_birth: '1984-04-12',
      phone: '+919876543210',
      email: 'ravi.kumar@example.com',
      city: 'Hyderabad',
      blood_group: 'B+',
      allergies: 'Penicillin',
    },
  },
  {
    ref: 'pat_meena',
    entity: 'hc_patient',
    data: {
      name: 'Meena Iyer',
      gender: 'female',
      date_of_birth: '2019-11-02',
      phone: '+919876500011',
      city: 'Hyderabad',
      blood_group: 'O+',
      emergency_contact: 'Suresh Iyer (father)',
      emergency_phone: '+919876500012',
    },
  },
  {
    ref: 'appt_ravi',
    entity: 'hc_appointment',
    data: {
      patient: '@pat_ravi',
      doctor: '@doc_general',
      date: '2026-10-01',
      slot_time: '10:30',
      reason: 'Fever and cough for three days',
    },
  },
  {
    ref: 'visit_ravi',
    entity: 'hc_visit',
    data: {
      patient: '@pat_ravi',
      doctor: '@doc_general',
      appointment: '@appt_ravi',
      date: '2026-10-01',
      bp: '124/82',
      pulse: 88,
      temperature: '100.4',
      spo2: 97,
      weight: '72.5',
      complaints: 'Fever, dry cough and body ache for three days',
      diagnosis: 'Acute upper respiratory tract infection',
      prescription: [
        {
          medicine: 'Paracetamol 650 mg',
          dose: '1 tablet',
          frequency: 'tds',
          days: 3,
          instructions: 'After food',
        },
        { medicine: 'Cetirizine 10 mg', dose: '1 tablet', frequency: 'hs', days: 5 },
      ],
      advice: 'Plenty of fluids and rest. Come back if the fever lasts beyond three days.',
      follow_up_date: '2026-10-06',
    },
  },
  {
    ref: 'bill_ravi',
    entity: 'hc_bill',
    data: {
      customer: '@pat_ravi',
      doctor: '@doc_general',
      visit: '@visit_ravi',
      date: '2026-10-01',
      payment_mode: 'upi',
      lines: [
        { item: '@svc_consult', qty: 1, rate: '500' },
        { item: '@svc_ecg', qty: 1, rate: '400' },
      ],
    },
  },
  {
    ref: 'pay_ravi',
    entity: 'hc_payment',
    data: {
      bill: '@bill_ravi',
      patient: '@pat_ravi',
      date: '2026-10-01',
      amount: '900',
      mode: 'upi',
      reference: 'UPI 6273 8812 0091',
    },
  },
];

export const HEALTHCARE: PackManifest = {
  id: 'industry.healthcare',
  type: 'industry',
  version: '1.0.0',
  name: { en: 'Healthcare (clinic)', hi: 'स्वास्थ्य सेवा (क्लिनिक)' },
  description: {
    en: 'Patients with UHID, doctors, appointments with day-before reminders, consultations with vitals and prescriptions, bills from a service charge list, payments; appointment slip, prescription, bill and receipt prints; front desk, doctor and billing dashboards.',
    hi: 'यूएचआईडी सहित रोगी, डॉक्टर, एक दिन पहले अनुस्मारक सहित अपॉइंटमेंट, जीवन संकेत व पर्चे सहित परामर्श, सेवा शुल्क सूची से बिल, भुगतान; अपॉइंटमेंट पर्ची, पर्चा, बिल और रसीद प्रिंट; फ्रंट डेस्क, डॉक्टर और बिलिंग डैशबोर्ड।',
  },
  suggestFor: ['healthcare', 'clinic', 'hospital'],
  layer: {
    entities: ENTITIES,
    picklists: PICKLISTS,
    numbering: NUMBERING,
    forms: FORMS,
    listViews: LIST_VIEWS,
    workflows: WORKFLOWS,
    rules: RULES,
    templates: TEMPLATES,
    automations: AUTOMATIONS,
    printTemplates: PRINT_TEMPLATES,
    reports: REPORTS,
    dashboards: DASHBOARDS,
  },
  roles: ROLE_TEMPLATES,
  samples: SAMPLES,
};
