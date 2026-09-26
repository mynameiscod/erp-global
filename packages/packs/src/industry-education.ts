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
  RuleDef,
  WorkflowDef,
} from '@erp/metadata';
import { ROLES } from './conventions';

/**
 * Education Industry Pack: schools and coaching institutes. Admissions with a
 * verification and approval workflow, students and guardians, classes, fee heads and
 * fee structures, fee receipts (a sales document: a Country Pack adds its taxes, and
 * fee heads are tax-exempt by default), fee dues with reminders, and the Principal and
 * Accountant dashboards.
 *
 * The fee receipt's `customer` is the student: fees are billed and receipted per student,
 * and reports by class follow the student's class.
 */

// ---- option lists ----

const PICKLISTS: PicklistDef[] = [
  {
    key: 'edu_gender',
    label: { en: 'Gender', hi: 'लिंग' },
    options: [
      { value: 'female', label: { en: 'Female', hi: 'महिला' } },
      { value: 'male', label: { en: 'Male', hi: 'पुरुष' } },
      { value: 'other', label: { en: 'Other', hi: 'अन्य' } },
    ],
  },
  {
    key: 'edu_relation',
    label: { en: 'Relation to student', hi: 'छात्र से संबंध' },
    options: [
      { value: 'father', label: { en: 'Father', hi: 'पिता' } },
      { value: 'mother', label: { en: 'Mother', hi: 'माता' } },
      { value: 'guardian', label: { en: 'Guardian', hi: 'अभिभावक' } },
      { value: 'other', label: { en: 'Other', hi: 'अन्य' } },
    ],
  },
  {
    key: 'edu_fee_frequency',
    label: { en: 'Fee frequency', hi: 'शुल्क की आवृत्ति' },
    options: [
      { value: 'one_time', label: { en: 'One time', hi: 'एक बार' } },
      { value: 'monthly', label: { en: 'Monthly', hi: 'मासिक' } },
      { value: 'quarterly', label: { en: 'Quarterly', hi: 'त्रैमासिक' } },
      { value: 'term', label: { en: 'Per term', hi: 'प्रति सत्र' } },
      { value: 'annual', label: { en: 'Annual', hi: 'वार्षिक' } },
    ],
  },
  {
    key: 'edu_payment_mode',
    label: { en: 'Payment mode', hi: 'भुगतान का तरीका' },
    options: [
      { value: 'cash', label: { en: 'Cash', hi: 'नकद' } },
      { value: 'upi', label: { en: 'UPI', hi: 'यूपीआई' } },
      { value: 'card', label: { en: 'Card', hi: 'कार्ड' } },
      { value: 'bank_transfer', label: { en: 'Bank transfer', hi: 'बैंक ट्रांसफ़र' } },
      { value: 'cheque', label: { en: 'Cheque', hi: 'चेक' } },
    ],
  },
  {
    key: 'edu_admission_source',
    label: { en: 'Enquiry source', hi: 'पूछताछ का स्रोत' },
    options: [
      { value: 'walk_in', label: { en: 'Walk-in', hi: 'स्वयं आए' } },
      { value: 'website', label: { en: 'Website', hi: 'वेबसाइट' } },
      { value: 'referral', label: { en: 'Referral', hi: 'संदर्भ' } },
      { value: 'advertisement', label: { en: 'Advertisement', hi: 'विज्ञापन' } },
      { value: 'other', label: { en: 'Other', hi: 'अन्य' } },
    ],
  },
  {
    key: 'edu_enrolment_status',
    label: { en: 'Enrolment status', hi: 'नामांकन स्थिति' },
    options: [
      { value: 'active', label: { en: 'Studying', hi: 'अध्ययनरत' }, color: '#198754' },
      { value: 'left', label: { en: 'Left', hi: 'छोड़ दिया' }, color: '#6c757d' },
      { value: 'alumni', label: { en: 'Passed out', hi: 'उत्तीर्ण' }, color: '#0d6efd' },
    ],
  },
];

// ---- entities ----

const ENTITIES: EntityPatch[] = [
  {
    key: 'edu_academic_year',
    kind: 'custom',
    label: { en: 'Academic year', hi: 'शैक्षणिक वर्ष' },
    pluralLabel: { en: 'Academic years', hi: 'शैक्षणिक वर्ष' },
    icon: 'calendar3',
    titleField: 'name',
    orgScoped: false,
    fields: [
      {
        key: 'name',
        type: 'text',
        label: { en: 'Name', hi: 'नाम' },
        help: { en: 'e.g. 2026-27', hi: 'जैसे 2026-27' },
        required: true,
        unique: true,
        maxLength: 40,
      },
      {
        key: 'start_date',
        type: 'date',
        label: { en: 'Starts on', hi: 'आरंभ तिथि' },
        required: true,
      },
      {
        key: 'end_date',
        type: 'date',
        label: { en: 'Ends on', hi: 'समाप्ति तिथि' },
        required: true,
      },
      { key: 'current', type: 'boolean', label: { en: 'Current year', hi: 'वर्तमान वर्ष' } },
    ],
  },
  {
    key: 'edu_class',
    kind: 'custom',
    label: { en: 'Class and section', hi: 'कक्षा और वर्ग' },
    pluralLabel: { en: 'Classes and sections', hi: 'कक्षाएँ और वर्ग' },
    icon: 'easel',
    titleField: 'name',
    orgScoped: true,
    fields: [
      {
        key: 'name',
        type: 'text',
        label: { en: 'Name', hi: 'नाम' },
        help: { en: 'e.g. Class 5 A', hi: 'जैसे कक्षा 5 अ' },
        required: true,
        searchable: true,
        maxLength: 60,
      },
      { key: 'grade', type: 'text', label: { en: 'Class / grade', hi: 'कक्षा' }, maxLength: 20 },
      { key: 'section', type: 'text', label: { en: 'Section', hi: 'वर्ग' }, maxLength: 10 },
      {
        key: 'academic_year',
        type: 'lookup',
        target: 'edu_academic_year',
        label: { en: 'Academic year', hi: 'शैक्षणिक वर्ष' },
      },
      {
        key: 'class_teacher',
        type: 'lookup',
        target: 'user',
        label: { en: 'Class teacher', hi: 'कक्षा अध्यापक' },
      },
      { key: 'capacity', type: 'integer', label: { en: 'Seats', hi: 'सीटें' }, min: 0 },
    ],
  },
  {
    key: 'edu_guardian',
    kind: 'custom',
    label: { en: 'Guardian', hi: 'अभिभावक' },
    pluralLabel: { en: 'Guardians', hi: 'अभिभावक' },
    icon: 'people',
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
        key: 'relation',
        type: 'select',
        picklist: 'edu_relation',
        label: { en: 'Relation', hi: 'संबंध' },
      },
      { key: 'phone', type: 'phone', label: { en: 'Mobile', hi: 'मोबाइल' }, searchable: true },
      { key: 'email', type: 'email', label: { en: 'Email', hi: 'ईमेल' } },
      { key: 'occupation', type: 'text', label: { en: 'Occupation', hi: 'व्यवसाय' } },
      { key: 'address', type: 'longtext', label: { en: 'Address', hi: 'पता' } },
    ],
  },
  {
    key: 'edu_student',
    kind: 'custom',
    label: { en: 'Student', hi: 'छात्र' },
    pluralLabel: { en: 'Students', hi: 'छात्र' },
    icon: 'mortarboard',
    titleField: 'name',
    orgScoped: true,
    // The fee receipt's customer: fees are receipted per student.
    roles: [ROLES.customer],
    fields: [
      {
        key: 'student_no',
        type: 'autonumber',
        numbering: 'edu_student',
        label: { en: 'Student ID', hi: 'छात्र आईडी' },
      },
      {
        key: 'name',
        type: 'text',
        label: { en: 'Name', hi: 'नाम' },
        required: true,
        searchable: true,
      },
      {
        key: 'class_section',
        type: 'lookup',
        target: 'edu_class',
        label: { en: 'Class', hi: 'कक्षा' },
        required: true,
      },
      { key: 'roll_no', type: 'text', label: { en: 'Roll no.', hi: 'अनुक्रमांक' }, maxLength: 20 },
      { key: 'date_of_birth', type: 'date', label: { en: 'Date of birth', hi: 'जन्म तिथि' } },
      {
        key: 'gender',
        type: 'select',
        picklist: 'edu_gender',
        label: { en: 'Gender', hi: 'लिंग' },
      },
      {
        key: 'guardian',
        type: 'lookup',
        target: 'edu_guardian',
        label: { en: 'Guardian', hi: 'अभिभावक' },
      },
      {
        key: 'guardian_phone',
        type: 'phone',
        label: { en: 'Guardian mobile', hi: 'अभिभावक का मोबाइल' },
        defaultFrom: 'guardian.phone',
      },
      {
        key: 'guardian_email',
        type: 'email',
        label: { en: 'Guardian email', hi: 'अभिभावक का ईमेल' },
        defaultFrom: 'guardian.email',
      },
      { key: 'joined_on', type: 'date', label: { en: 'Joined on', hi: 'प्रवेश तिथि' } },
      {
        key: 'enrolment_status',
        type: 'select',
        picklist: 'edu_enrolment_status',
        label: { en: 'Enrolment', hi: 'नामांकन' },
        default: 'active',
      },
      { key: 'photo', type: 'image', label: { en: 'Photo', hi: 'फ़ोटो' } },
      { key: 'address', type: 'longtext', label: { en: 'Address', hi: 'पता' } },
    ],
  },
  {
    key: 'edu_admission',
    kind: 'custom',
    label: { en: 'Admission', hi: 'प्रवेश' },
    pluralLabel: { en: 'Admissions', hi: 'प्रवेश' },
    icon: 'person-plus',
    titleField: 'applicant_name',
    orgScoped: true,
    fields: [
      {
        key: 'admission_no',
        type: 'autonumber',
        numbering: 'edu_admission',
        label: { en: 'Application no.', hi: 'आवेदन संख्या' },
      },
      {
        key: 'applicant_name',
        type: 'text',
        label: { en: 'Applicant name', hi: 'आवेदक का नाम' },
        required: true,
        searchable: true,
      },
      { key: 'date_of_birth', type: 'date', label: { en: 'Date of birth', hi: 'जन्म तिथि' } },
      {
        key: 'gender',
        type: 'select',
        picklist: 'edu_gender',
        label: { en: 'Gender', hi: 'लिंग' },
      },
      {
        key: 'class_applied',
        type: 'lookup',
        target: 'edu_class',
        label: { en: 'Class applied for', hi: 'आवेदित कक्षा' },
        required: true,
      },
      {
        key: 'academic_year',
        type: 'lookup',
        target: 'edu_academic_year',
        label: { en: 'Academic year', hi: 'शैक्षणिक वर्ष' },
      },
      { key: 'applied_on', type: 'date', label: { en: 'Applied on', hi: 'आवेदन तिथि' } },
      {
        key: 'source',
        type: 'select',
        picklist: 'edu_admission_source',
        label: { en: 'Source', hi: 'स्रोत' },
      },
      { key: 'guardian_name', type: 'text', label: { en: 'Guardian name', hi: 'अभिभावक का नाम' } },
      {
        key: 'guardian_phone',
        type: 'phone',
        label: { en: 'Guardian mobile', hi: 'अभिभावक का मोबाइल' },
        searchable: true,
      },
      {
        key: 'guardian_email',
        type: 'email',
        label: { en: 'Guardian email', hi: 'अभिभावक का ईमेल' },
      },
      {
        key: 'previous_school',
        type: 'text',
        label: { en: 'Previous school', hi: 'पिछला विद्यालय' },
      },
      {
        key: 'documents_verified',
        type: 'boolean',
        label: { en: 'Documents verified', hi: 'दस्तावेज़ सत्यापित' },
      },
      { key: 'admitted_on', type: 'date', label: { en: 'Admitted on', hi: 'प्रवेश दिया गया' } },
      { key: 'remarks', type: 'longtext', label: { en: 'Remarks', hi: 'टिप्पणी' } },
    ],
  },
  {
    key: 'edu_fee_head',
    kind: 'custom',
    label: { en: 'Fee head', hi: 'शुल्क मद' },
    pluralLabel: { en: 'Fee heads', hi: 'शुल्क मद' },
    icon: 'tags',
    titleField: 'name',
    orgScoped: false,
    // Sold on fee receipts; countries default it to their exempt tax category.
    roles: [ROLES.item, ROLES.taxExempt],
    fields: [
      { key: 'name', type: 'text', label: { en: 'Name', hi: 'नाम' }, required: true, unique: true },
      { key: 'code', type: 'text', label: { en: 'Code', hi: 'कोड' }, maxLength: 20 },
      { key: 'price', type: 'currency', label: { en: 'Standard amount', hi: 'मानक राशि' }, min: 0 },
      {
        key: 'frequency',
        type: 'select',
        picklist: 'edu_fee_frequency',
        label: { en: 'Frequency', hi: 'आवृत्ति' },
      },
      { key: 'refundable', type: 'boolean', label: { en: 'Refundable', hi: 'वापसी योग्य' } },
    ],
  },
  {
    key: 'edu_fee_structure',
    kind: 'custom',
    label: { en: 'Fee structure', hi: 'शुल्क संरचना' },
    pluralLabel: { en: 'Fee structures', hi: 'शुल्क संरचनाएँ' },
    icon: 'list-columns',
    titleField: 'name',
    orgScoped: true,
    fields: [
      { key: 'name', type: 'text', label: { en: 'Name', hi: 'नाम' }, required: true },
      {
        key: 'academic_year',
        type: 'lookup',
        target: 'edu_academic_year',
        label: { en: 'Academic year', hi: 'शैक्षणिक वर्ष' },
      },
      {
        key: 'class_section',
        type: 'lookup',
        target: 'edu_class',
        label: { en: 'Class', hi: 'कक्षा' },
      },
      {
        key: 'heads',
        type: 'table',
        label: { en: 'Fee heads', hi: 'शुल्क मद' },
        maxRows: 50,
        columns: [
          {
            key: 'fee_head',
            type: 'lookup',
            target: 'edu_fee_head',
            label: { en: 'Fee head', hi: 'शुल्क मद' },
            required: true,
          },
          {
            key: 'amount',
            type: 'currency',
            label: { en: 'Amount', hi: 'राशि' },
            defaultFrom: 'fee_head.price',
            min: 0,
          },
          {
            key: 'frequency',
            type: 'select',
            picklist: 'edu_fee_frequency',
            label: { en: 'Frequency', hi: 'आवृत्ति' },
            defaultFrom: 'fee_head.frequency',
          },
          { key: 'due_date', type: 'date', label: { en: 'First due on', hi: 'पहली देय तिथि' } },
        ],
      },
      {
        key: 'total',
        type: 'formula',
        label: { en: 'Total per period', hi: 'प्रति अवधि कुल' },
        formula: 'SUM(heads.amount)',
        resultType: 'number',
      },
    ],
  },
  {
    key: 'edu_fee_receipt',
    kind: 'custom',
    label: { en: 'Fee receipt', hi: 'शुल्क रसीद' },
    pluralLabel: { en: 'Fee receipts', hi: 'शुल्क रसीदें' },
    icon: 'receipt',
    orgScoped: true,
    roles: [ROLES.salesInvoice],
    tax: { lines: 'lines', amount: 'amount', document: 'invoice' },
    fields: [
      {
        key: 'receipt_no',
        type: 'autonumber',
        numbering: 'edu_fee_receipt',
        label: { en: 'Receipt no.', hi: 'रसीद संख्या' },
      },
      {
        key: 'customer',
        type: 'lookup',
        target: 'edu_student',
        label: { en: 'Student', hi: 'छात्र' },
        required: true,
      },
      { key: 'date', type: 'date', label: { en: 'Date', hi: 'दिनांक' }, required: true },
      {
        // The class at the time of payment, for reports by class.
        key: 'class_section',
        type: 'lookup',
        target: 'edu_class',
        label: { en: 'Class', hi: 'कक्षा' },
        defaultFrom: 'customer.class_section',
      },
      {
        key: 'academic_year',
        type: 'lookup',
        target: 'edu_academic_year',
        label: { en: 'Academic year', hi: 'शैक्षणिक वर्ष' },
      },
      {
        key: 'fee_due',
        type: 'lookup',
        target: 'edu_fee_due',
        label: { en: 'Against due', hi: 'बकाया के विरुद्ध' },
      },
      {
        key: 'lines',
        type: 'table',
        label: { en: 'Fees', hi: 'शुल्क' },
        maxRows: 50,
        columns: [
          {
            key: 'item',
            type: 'lookup',
            target: 'edu_fee_head',
            label: { en: 'Fee head', hi: 'शुल्क मद' },
          },
          { key: 'description', type: 'text', label: { en: 'Description', hi: 'विवरण' } },
          {
            key: 'period',
            type: 'text',
            label: { en: 'Period', hi: 'अवधि' },
            help: { en: 'e.g. April to June', hi: 'जैसे अप्रैल से जून' },
          },
          { key: 'qty', type: 'integer', label: { en: 'Qty', hi: 'मात्रा' }, min: 1 },
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
        picklist: 'edu_payment_mode',
        label: { en: 'Paid by', hi: 'भुगतान का तरीका' },
        required: true,
        default: 'cash',
      },
      {
        key: 'payment_ref',
        type: 'text',
        label: { en: 'Transaction / cheque no.', hi: 'लेन-देन / चेक संख्या' },
      },
      { key: 'remarks', type: 'longtext', label: { en: 'Remarks', hi: 'टिप्पणी' } },
    ],
  },
  {
    key: 'edu_fee_due',
    kind: 'custom',
    label: { en: 'Fee due', hi: 'देय शुल्क' },
    pluralLabel: { en: 'Fee dues', hi: 'देय शुल्क' },
    icon: 'hourglass-split',
    titleField: 'description',
    orgScoped: true,
    fields: [
      {
        key: 'student',
        type: 'lookup',
        target: 'edu_student',
        label: { en: 'Student', hi: 'छात्र' },
        required: true,
      },
      {
        key: 'class_section',
        type: 'lookup',
        target: 'edu_class',
        label: { en: 'Class', hi: 'कक्षा' },
        defaultFrom: 'student.class_section',
      },
      {
        key: 'academic_year',
        type: 'lookup',
        target: 'edu_academic_year',
        label: { en: 'Academic year', hi: 'शैक्षणिक वर्ष' },
      },
      {
        key: 'fee_head',
        type: 'lookup',
        target: 'edu_fee_head',
        label: { en: 'Fee head', hi: 'शुल्क मद' },
      },
      {
        key: 'description',
        type: 'text',
        label: { en: 'Description', hi: 'विवरण' },
        required: true,
        help: {
          en: 'e.g. Tuition fee, July to September',
          hi: 'जैसे शिक्षण शुल्क, जुलाई से सितंबर',
        },
      },
      { key: 'due_date', type: 'date', label: { en: 'Due on', hi: 'देय तिथि' }, required: true },
      {
        key: 'amount',
        type: 'currency',
        label: { en: 'Amount', hi: 'राशि' },
        required: true,
        min: 0,
      },
      { key: 'paid_amount', type: 'currency', label: { en: 'Paid', hi: 'भुगतान किया' }, min: 0 },
      {
        key: 'balance',
        type: 'formula',
        label: { en: 'Balance', hi: 'शेष' },
        formula: 'amount - paid_amount',
        resultType: 'number',
      },
      {
        key: 'payment_status',
        type: 'formula',
        label: { en: 'Payment', hi: 'भुगतान' },
        formula:
          'IF(amount - paid_amount <= 0, "Paid", IF(paid_amount > 0, "Part paid", "Unpaid"))',
        resultType: 'text',
      },
      {
        key: 'guardian_email',
        type: 'email',
        label: { en: 'Guardian email', hi: 'अभिभावक का ईमेल' },
        defaultFrom: 'student.guardian_email',
      },
      {
        key: 'guardian_phone',
        type: 'phone',
        label: { en: 'Guardian mobile', hi: 'अभिभावक का मोबाइल' },
        defaultFrom: 'student.guardian_phone',
      },
    ],
  },
];

// ---- forms and lists ----

// Forms only for entities without a role, so fields a Country Pack adds are never left off.
const FORMS: FormLayout[] = [
  {
    entity: 'edu_admission',
    sections: [
      {
        key: 'applicant',
        label: { en: 'Applicant', hi: 'आवेदक' },
        columns: 2,
        fields: [
          'admission_no',
          'applicant_name',
          'date_of_birth',
          'gender',
          'class_applied',
          'academic_year',
          'previous_school',
        ],
      },
      {
        key: 'guardian',
        label: { en: 'Guardian', hi: 'अभिभावक' },
        columns: 2,
        fields: ['guardian_name', 'guardian_phone', 'guardian_email'],
      },
      {
        key: 'office',
        label: { en: 'Office use', hi: 'कार्यालय उपयोग' },
        columns: 2,
        fields: ['applied_on', 'source', 'documents_verified', 'admitted_on', 'remarks'],
      },
    ],
  },
  {
    entity: 'edu_fee_due',
    sections: [
      {
        key: 'due',
        label: { en: 'Fee due', hi: 'देय शुल्क' },
        columns: 2,
        fields: [
          'student',
          'class_section',
          'academic_year',
          'fee_head',
          'description',
          'due_date',
          'amount',
          'paid_amount',
          'balance',
          'payment_status',
        ],
      },
      {
        key: 'contact',
        label: { en: 'Reminders go to', hi: 'अनुस्मारक किसे जाएँ' },
        columns: 2,
        fields: ['guardian_email', 'guardian_phone'],
      },
    ],
  },
];

const LIST_VIEWS: ListView[] = [
  {
    entity: 'edu_student',
    columns: [
      'student_no',
      'name',
      'class_section',
      'roll_no',
      'guardian_phone',
      'enrolment_status',
    ],
    sort: { field: 'name', dir: 'asc' },
  },
  {
    entity: 'edu_admission',
    columns: [
      'number',
      'applicant_name',
      'class_applied',
      'guardian_phone',
      'applied_on',
      'status',
    ],
    sort: { field: 'createdAt', dir: 'desc' },
  },
  {
    entity: 'edu_fee_receipt',
    columns: [
      'number',
      'date',
      'customer',
      'class_section',
      'grand_total',
      'payment_mode',
      'status',
    ],
    sort: { field: 'createdAt', dir: 'desc' },
  },
  {
    entity: 'edu_fee_due',
    columns: [
      'student',
      'class_section',
      'description',
      'due_date',
      'amount',
      'balance',
      'payment_status',
    ],
    sort: { field: 'due_date', dir: 'asc' },
  },
  {
    entity: 'edu_class',
    columns: ['name', 'grade', 'section', 'academic_year', 'class_teacher', 'capacity'],
    sort: { field: 'name', dir: 'asc' },
  },
];

const NUMBERING: NumberingSeries[] = [
  {
    key: 'edu_admission',
    label: { en: 'Admission applications', hi: 'प्रवेश आवेदन' },
    pattern: 'ADM/{FY}/{SEQ:5}',
    reset: 'yearly',
    scope: 'company',
  },
  {
    // At most 16 characters, as tax documents in India require.
    key: 'edu_fee_receipt',
    label: { en: 'Fee receipts', hi: 'शुल्क रसीदें' },
    pattern: 'FR/{FY}/{SEQ:5}',
    reset: 'yearly',
    scope: 'company',
  },
  {
    key: 'edu_student',
    label: { en: 'Student IDs', hi: 'छात्र आईडी' },
    pattern: 'STU{SEQ:6}',
    reset: 'never',
    scope: 'company',
  },
];

// ---- workflows, rules and automations ----

const WORKFLOWS: WorkflowDef[] = [
  {
    entity: 'edu_admission',
    initialState: 'applied',
    states: [
      { key: 'applied', label: { en: 'Applied', hi: 'आवेदित' }, color: '#6c757d' },
      { key: 'verified', label: { en: 'Verified', hi: 'सत्यापित' }, color: '#0dcaf0' },
      { key: 'approved', label: { en: 'Approved', hi: 'स्वीकृत' }, color: '#0d6efd' },
      {
        key: 'admitted',
        label: { en: 'Admitted', hi: 'प्रवेश दिया गया' },
        color: '#198754',
        locked: true,
        editableFields: ['admitted_on', 'remarks'],
      },
      {
        key: 'rejected',
        label: { en: 'Not admitted', hi: 'प्रवेश नहीं' },
        color: '#dc3545',
        locked: true,
      },
    ],
    actions: [
      {
        key: 'verify',
        label: { en: 'Documents verified', hi: 'दस्तावेज़ सत्यापित' },
        from: ['applied'],
        to: 'verified',
        condition: 'documents_verified',
      },
      {
        key: 'approve',
        label: { en: 'Approve', hi: 'स्वीकृत करें' },
        from: ['verified'],
        to: 'approved',
        roleKeys: ['principal'],
      },
      {
        key: 'admit',
        label: { en: 'Admit', hi: 'प्रवेश दें' },
        from: ['approved'],
        to: 'admitted',
      },
      {
        key: 'reject',
        label: { en: 'Do not admit', hi: 'प्रवेश न दें' },
        from: ['applied', 'verified', 'approved'],
        to: 'rejected',
        commentRequired: true,
      },
    ],
  },
  {
    entity: 'edu_fee_receipt',
    initialState: 'issued',
    states: [
      {
        key: 'issued',
        label: { en: 'Issued', hi: 'जारी' },
        color: '#198754',
        locked: true,
        editableFields: ['remarks'],
      },
      { key: 'cancelled', label: { en: 'Cancelled', hi: 'रद्द' }, color: '#dc3545', locked: true },
    ],
    actions: [
      {
        key: 'cancel',
        label: { en: 'Cancel receipt', hi: 'रसीद रद्द करें' },
        from: ['issued'],
        to: 'cancelled',
        roleKeys: ['accountant', 'principal'],
        commentRequired: true,
      },
    ],
  },
];

const RULES: RuleDef[] = [
  {
    key: 'edu_due_overpaid',
    entity: 'edu_fee_due',
    on: 'save',
    condition: 'paid_amount > amount',
    effect: 'block',
    message: {
      en: 'The amount paid is more than the amount due',
      hi: 'भुगतान की गई राशि देय राशि से अधिक है',
    },
  },
  {
    key: 'edu_receipt_ref',
    entity: 'edu_fee_receipt',
    on: 'save',
    condition: 'payment_mode != "cash"',
    effect: 'require',
    field: 'payment_ref',
  },
];

const AUTOMATIONS: AutomationDef[] = [
  {
    key: 'edu_admit_create_student',
    entity: 'edu_admission',
    label: { en: 'Create the student when admitted', hi: 'प्रवेश पर छात्र बनाएँ' },
    trigger: { type: 'status_changed', to: 'admitted' },
    actions: [
      { type: 'update', set: [{ field: 'admitted_on', value: 'TODAY()' }] },
      {
        type: 'create',
        entity: 'edu_student',
        orgUnit: 'same',
        set: [
          { field: 'name', value: 'applicant_name' },
          { field: 'class_section', value: 'class_applied' },
          { field: 'date_of_birth', value: 'date_of_birth' },
          { field: 'gender', value: 'gender' },
          { field: 'guardian_phone', value: 'guardian_phone' },
          { field: 'guardian_email', value: 'guardian_email' },
          { field: 'joined_on', value: 'TODAY()' },
          { field: 'enrolment_status', value: '"active"' },
        ],
      },
      {
        type: 'notify',
        template: 'edu.admitted',
        recipients: [{ type: 'creator' }, { type: 'role', roleKey: 'front_office' }],
        channels: ['inapp'],
      },
    ],
  },
  {
    key: 'edu_admission_letter_email',
    entity: 'edu_admission',
    label: { en: 'Email the admission letter', hi: 'प्रवेश पत्र ईमेल करें' },
    trigger: { type: 'status_changed', to: 'admitted' },
    condition: 'guardian_email != ""',
    actions: [
      {
        type: 'document',
        template: 'edu_admission_letter',
        emailFields: ['guardian_email'],
        subject: 'Admission letter',
        message: 'Please find the admission letter attached.',
      },
    ],
  },
  {
    key: 'edu_fee_due_reminder',
    entity: 'edu_fee_due',
    label: { en: 'Fee due reminder, 3 days before', hi: 'शुल्क देय अनुस्मारक, 3 दिन पहले' },
    trigger: { type: 'schedule', every: 'day', at: '09:00' },
    condition: 'balance > 0 && due_date = ADD_DAYS(TODAY(), 3)',
    actions: [
      {
        type: 'notify',
        template: 'edu.fee_due_reminder',
        recipients: [{ type: 'role', roleKey: 'accountant' }],
        channels: ['inapp'],
      },
    ],
  },
  {
    key: 'edu_fee_due_reminder_email',
    entity: 'edu_fee_due',
    label: {
      en: 'Fee due reminder to the guardian, 3 days before',
      hi: 'अभिभावक को शुल्क देय अनुस्मारक, 3 दिन पहले',
    },
    trigger: { type: 'schedule', every: 'day', at: '09:00' },
    condition: 'balance > 0 && guardian_email != "" && due_date = ADD_DAYS(TODAY(), 3)',
    actions: [
      {
        type: 'document',
        template: 'edu_fee_due_notice',
        emailFields: ['guardian_email'],
        subject: 'Fee reminder',
        message: 'A fee payment is due in 3 days. The notice is attached.',
      },
    ],
  },
];

const TEMPLATES: MessageTemplate[] = [
  {
    key: 'edu.fee_due_reminder',
    label: { en: 'Fee due reminder', hi: 'शुल्क देय अनुस्मारक' },
    title: {
      en: 'Fee due in 3 days: {{record.description}}',
      hi: '3 दिन में शुल्क देय: {{record.description}}',
    },
    body: {
      en: '{{record.description}} of {{record.balance}} is due on {{record.due_date}}. {{link}}',
      hi: '{{record.description}} के {{record.balance}} की देय तिथि {{record.due_date}} है। {{link}}',
    },
  },
  {
    key: 'edu.admitted',
    label: { en: 'Student admitted', hi: 'छात्र को प्रवेश' },
    title: {
      en: 'Admitted: {{record.applicant_name}}',
      hi: 'प्रवेश दिया गया: {{record.applicant_name}}',
    },
    body: {
      en: '{{record.applicant_name}} ({{record.number}}) was admitted and added as a student. {{link}}',
      hi: '{{record.applicant_name}} ({{record.number}}) को प्रवेश दिया गया और छात्र के रूप में जोड़ा गया। {{link}}',
    },
  },
];

// ---- documents ----

const letterhead = {
  id: 'head',
  type: 'letterhead' as const,
  lines: [{ en: '{{company.name}}' }, { en: '{{unit.name}}' }],
};

const PRINT_TEMPLATES: PrintTemplateDef[] = [
  {
    key: 'edu_fee_receipt',
    entity: 'edu_fee_receipt',
    label: { en: 'Fee receipt (A5, English and Hindi)', hi: 'शुल्क रसीद (ए5, अंग्रेज़ी और हिंदी)' },
    page: { size: 'A5', margin: 8 },
    languages: ['en', 'hi'],
    copies: [
      { en: 'Student copy', hi: 'छात्र प्रति' },
      { en: 'Office copy', hi: 'कार्यालय प्रति' },
    ],
    watermarks: [{ text: { en: 'CANCELLED', hi: 'रद्द' }, condition: 'STATUS() = "cancelled"' }],
    fontSize: 9,
    mode: 'blocks',
    fileName: 'FeeReceipt-{{number}}',
    auditPrints: true,
    blocks: [
      letterhead,
      { id: 'title', type: 'title', text: { en: 'Fee Receipt', hi: 'शुल्क रसीद' } },
      {
        id: 'details',
        type: 'fields',
        columns: 2,
        items: [
          { path: 'number' },
          { path: 'date' },
          { path: 'customer.name', label: { en: 'Student', hi: 'छात्र' } },
          { path: 'customer.student_no', label: { en: 'Student ID', hi: 'छात्र आईडी' } },
          { path: 'class_section' },
          { path: 'academic_year' },
        ],
      },
      {
        id: 'lines',
        type: 'table',
        source: 'lines',
        numbered: true,
        columns: [
          { path: 'item', width: 35 },
          { path: 'period' },
          { path: 'qty', format: 'number', align: 'right' },
          { path: 'rate', format: 'currency', align: 'right' },
          { path: 'amount', format: 'currency', align: 'right' },
        ],
        totals: ['amount'],
      },
      {
        id: 'totals',
        type: 'totals',
        rows: [
          {
            label: { en: 'Tax', hi: 'कर' },
            value: 'tax_total',
            format: 'currency',
          },
          { label: { en: 'Total received', hi: 'कुल प्राप्त' }, value: 'grand_total', bold: true },
        ],
        words: {
          value: 'grand_total',
          label: { en: 'Received in words:', hi: 'शब्दों में प्राप्त:' },
        },
      },
      {
        id: 'payment',
        type: 'fields',
        columns: 2,
        items: [{ path: 'payment_mode' }, { path: 'payment_ref' }],
      },
      {
        id: 'note',
        type: 'text',
        size: 7,
        text: {
          en: 'Fees once paid are not refundable except refundable deposits. Please keep this receipt.',
          hi: 'एक बार भुगतान किया गया शुल्क वापस नहीं होता, वापसी योग्य जमा को छोड़कर। कृपया यह रसीद सँभाल कर रखें।',
        },
      },
      {
        id: 'sign',
        type: 'signature',
        name: { en: 'For {{company.name}}', hi: '{{company.name}} के लिए' },
        title: { en: 'Accountant', hi: 'लेखाकार' },
        align: 'right',
      },
    ],
  },
  {
    key: 'edu_admission_letter',
    entity: 'edu_admission',
    label: { en: 'Admission letter', hi: 'प्रवेश पत्र' },
    page: { size: 'A4' },
    mode: 'blocks',
    watermarks: [{ text: { en: 'DRAFT', hi: 'प्रारूप' }, condition: 'STATUS() != "admitted"' }],
    fileName: 'AdmissionLetter-{{number}}',
    blocks: [
      letterhead,
      { id: 'title', type: 'title', text: { en: 'Letter of Admission', hi: 'प्रवेश पत्र' } },
      {
        id: 'ref',
        type: 'fields',
        columns: 2,
        items: [{ path: 'number' }, { path: 'admitted_on', format: 'date' }],
      },
      {
        id: 'to',
        type: 'text',
        text: {
          en: 'Dear {{guardian_name}},',
          hi: 'आदरणीय {{guardian_name}},',
        },
      },
      {
        id: 'body',
        type: 'text',
        text: {
          en: 'We are pleased to inform you that {{applicant_name}} has been admitted to {{class_applied.name}} for the academic year {{academic_year.name}}. Please complete the fee payment and submit the original documents at the school office within 7 days of this letter.',
          hi: 'हमें आपको सूचित करते हुए प्रसन्नता है कि {{applicant_name}} को शैक्षणिक वर्ष {{academic_year.name}} के लिए {{class_applied.name}} में प्रवेश दिया गया है। कृपया इस पत्र के 7 दिनों के भीतर शुल्क का भुगतान करें और मूल दस्तावेज़ विद्यालय कार्यालय में जमा करें।',
        },
      },
      {
        id: 'student',
        type: 'fields',
        columns: 2,
        items: [
          { path: 'applicant_name' },
          { path: 'date_of_birth', format: 'date' },
          { path: 'class_applied' },
          { path: 'academic_year' },
        ],
      },
      { id: 'space', type: 'spacer', height: 12 },
      {
        id: 'sign',
        type: 'signature',
        name: { en: 'For {{company.name}}', hi: '{{company.name}} के लिए' },
        title: { en: 'Principal', hi: 'प्रधानाचार्य' },
      },
    ],
  },
  {
    key: 'edu_fee_due_notice',
    entity: 'edu_fee_due',
    label: { en: 'Fee due notice', hi: 'शुल्क देय सूचना' },
    page: { size: 'A5' },
    languages: ['en', 'hi'],
    mode: 'blocks',
    fileName: 'FeeDue-{{student.name}}',
    blocks: [
      letterhead,
      { id: 'title', type: 'title', text: { en: 'Fee Due Notice', hi: 'शुल्क देय सूचना' } },
      {
        id: 'details',
        type: 'fields',
        columns: 2,
        items: [
          { path: 'student.name', label: { en: 'Student', hi: 'छात्र' } },
          { path: 'class_section' },
          { path: 'description' },
          { path: 'due_date', format: 'date' },
          { path: 'amount', format: 'currency' },
          { path: 'paid_amount', format: 'currency' },
        ],
      },
      {
        id: 'totals',
        type: 'totals',
        rows: [{ label: { en: 'Balance due', hi: 'शेष देय' }, value: 'balance', bold: true }],
      },
      {
        id: 'note',
        type: 'text',
        text: {
          en: 'Please pay by the due date at the school office or by UPI. Ignore this notice if already paid.',
          hi: 'कृपया देय तिथि तक विद्यालय कार्यालय में या यूपीआई से भुगतान करें। यदि भुगतान हो चुका है तो इस सूचना को अनदेखा करें।',
        },
      },
    ],
  },
];

// ---- reports and dashboards ----

const notCancelled = { path: 'status', op: 'ne' as const, value: 'cancelled' };

const REPORTS: ReportDef[] = [
  {
    key: 'edu_fees_by_class_month',
    label: { en: 'Fees collected by class and month', hi: 'कक्षा और माह के अनुसार शुल्क संग्रह' },
    entity: 'edu_fee_receipt',
    columns: [],
    filters: [notCancelled],
    groupBy: [{ path: 'date', bucket: 'month' }, { path: 'class_section' }],
    aggregates: [
      { fn: 'sum', path: 'grand_total', label: { en: 'Collected', hi: 'संग्रहित' } },
      { fn: 'count', label: { en: 'Receipts', hi: 'रसीदें' } },
    ],
    chart: { type: 'stacked_bar' },
    dateField: 'date',
    roleKeys: ['principal', 'accountant'],
  },
  {
    key: 'edu_fees_collected',
    label: { en: 'Fees collected', hi: 'शुल्क संग्रह' },
    entity: 'edu_fee_receipt',
    columns: [],
    filters: [notCancelled],
    aggregates: [
      { fn: 'sum', path: 'grand_total', label: { en: 'Collected', hi: 'संग्रहित' } },
      { fn: 'count', label: { en: 'Receipts', hi: 'रसीदें' } },
    ],
    dateField: 'date',
    roleKeys: ['principal', 'accountant'],
  },
  {
    key: 'edu_fees_by_head',
    label: { en: 'Fees collected by fee head', hi: 'शुल्क मद के अनुसार संग्रह' },
    entity: 'edu_fee_receipt',
    lines: 'lines',
    columns: [],
    filters: [notCancelled],
    groupBy: [{ path: 'lines.item' }],
    aggregates: [{ fn: 'sum', path: 'lines.amount', label: { en: 'Amount', hi: 'राशि' } }],
    chart: { type: 'donut' },
    dateField: 'date',
    roleKeys: ['principal', 'accountant'],
  },
  {
    key: 'edu_dues_by_class',
    label: { en: 'Fee dues by class', hi: 'कक्षा के अनुसार बकाया शुल्क' },
    entity: 'edu_fee_due',
    columns: [],
    filters: [{ path: 'balance', op: 'gt', value: 0 }],
    groupBy: [{ path: 'class_section' }],
    aggregates: [
      { fn: 'sum', path: 'balance', label: { en: 'Outstanding', hi: 'बकाया' } },
      { fn: 'count_distinct', path: 'student', label: { en: 'Students', hi: 'छात्र' } },
    ],
    chart: { type: 'bar' },
    dateField: 'due_date',
    roleKeys: ['principal', 'accountant'],
  },
  {
    key: 'edu_dues_outstanding',
    label: { en: 'Outstanding fees', hi: 'बकाया शुल्क' },
    entity: 'edu_fee_due',
    columns: [],
    filters: [{ path: 'balance', op: 'gt', value: 0 }],
    aggregates: [{ fn: 'sum', path: 'balance', label: { en: 'Outstanding', hi: 'बकाया' } }],
    dateField: 'due_date',
    roleKeys: ['principal', 'accountant'],
  },
  {
    key: 'edu_dues_upcoming',
    label: { en: 'Fees due in the next 7 days', hi: 'अगले 7 दिनों में देय शुल्क' },
    entity: 'edu_fee_due',
    columns: [
      { path: 'due_date' },
      { path: 'student.name', label: { en: 'Student', hi: 'छात्र' } },
      { path: 'class_section' },
      { path: 'description' },
      { path: 'balance' },
      { path: 'guardian_phone' },
    ],
    filters: [
      { path: 'balance', op: 'gt', value: 0 },
      { path: 'due_date', op: 'relative', relative: { period: 'next_n_days', n: 7 }, prompt: true },
    ],
    sort: [{ path: 'due_date', dir: 'asc' }],
    roleKeys: ['principal', 'accountant', 'front_office'],
  },
  {
    key: 'edu_admissions_funnel',
    label: { en: 'Admissions funnel', hi: 'प्रवेश फ़नल' },
    entity: 'edu_admission',
    columns: [],
    filters: [],
    groupBy: [{ path: 'status' }],
    aggregates: [{ fn: 'count', label: { en: 'Applications', hi: 'आवेदन' } }],
    chart: { type: 'bar' },
    dateField: 'applied_on',
    roleKeys: ['principal', 'front_office'],
  },
  {
    key: 'edu_admissions_by_class',
    label: { en: 'Applications by class', hi: 'कक्षा के अनुसार आवेदन' },
    entity: 'edu_admission',
    columns: [],
    filters: [],
    groupBy: [{ path: 'class_applied' }, { path: 'status' }],
    aggregates: [{ fn: 'count', label: { en: 'Applications', hi: 'आवेदन' } }],
    chart: { type: 'stacked_bar' },
    dateField: 'applied_on',
    roleKeys: ['principal', 'front_office'],
  },
  {
    key: 'edu_admissions_recent',
    label: { en: 'Recent applications', hi: 'हाल के आवेदन' },
    entity: 'edu_admission',
    columns: [
      { path: 'number' },
      { path: 'applicant_name' },
      { path: 'class_applied' },
      { path: 'applied_on' },
      { path: 'status' },
    ],
    filters: [],
    sort: [{ path: 'createdAt', dir: 'desc' }],
    dateField: 'applied_on',
    roleKeys: ['principal', 'front_office'],
  },
  {
    key: 'edu_students_by_class',
    label: { en: 'Students by class', hi: 'कक्षा के अनुसार छात्र' },
    entity: 'edu_student',
    columns: [],
    filters: [{ path: 'enrolment_status', op: 'eq', value: 'active' }],
    groupBy: [{ path: 'class_section' }],
    aggregates: [{ fn: 'count', label: { en: 'Students', hi: 'छात्र' } }],
    chart: { type: 'bar' },
  },
];

const DASHBOARDS: DashboardDef[] = [
  {
    key: 'edu_principal',
    label: { en: 'Principal', hi: 'प्रधानाचार्य' },
    roleKeys: ['principal'],
    home: true,
    filters: { dateRange: true, orgUnit: true },
    widgets: [
      {
        id: 'collected',
        type: 'kpi',
        title: { en: 'Fees collected', hi: 'शुल्क संग्रह' },
        report: 'edu_fees_collected',
        kpi: { compare: true },
        x: 0,
        y: 0,
        w: 4,
        h: 2,
      },
      {
        id: 'outstanding',
        type: 'kpi',
        title: { en: 'Outstanding fees', hi: 'बकाया शुल्क' },
        report: 'edu_dues_outstanding',
        x: 4,
        y: 0,
        w: 4,
        h: 2,
      },
      {
        id: 'students',
        type: 'kpi',
        title: { en: 'Students', hi: 'छात्र' },
        report: 'edu_students_by_class',
        x: 8,
        y: 0,
        w: 4,
        h: 2,
      },
      {
        id: 'funnel',
        type: 'chart',
        title: { en: 'Admissions funnel', hi: 'प्रवेश फ़नल' },
        report: 'edu_admissions_funnel',
        x: 0,
        y: 2,
        w: 6,
        h: 4,
      },
      {
        id: 'fees',
        type: 'chart',
        title: { en: 'Fees by class and month', hi: 'कक्षा और माह के अनुसार शुल्क' },
        report: 'edu_fees_by_class_month',
        x: 6,
        y: 2,
        w: 6,
        h: 4,
      },
      {
        id: 'dues',
        type: 'chart',
        title: { en: 'Dues by class', hi: 'कक्षा के अनुसार बकाया' },
        report: 'edu_dues_by_class',
        x: 0,
        y: 6,
        w: 6,
        h: 4,
      },
      {
        id: 'approvals',
        type: 'approvals',
        title: { en: 'Waiting for me', hi: 'मेरी प्रतीक्षा में' },
        x: 6,
        y: 6,
        w: 6,
        h: 4,
      },
      {
        id: 'recent',
        type: 'list',
        title: { en: 'Recent applications', hi: 'हाल के आवेदन' },
        report: 'edu_admissions_recent',
        limit: 10,
        x: 0,
        y: 10,
        w: 12,
        h: 4,
      },
    ],
  },
  {
    key: 'edu_accountant',
    label: { en: 'Accountant', hi: 'लेखाकार' },
    roleKeys: ['accountant'],
    home: true,
    filters: { dateRange: true, orgUnit: true },
    widgets: [
      {
        id: 'collected',
        type: 'kpi',
        title: { en: 'Fees collected', hi: 'शुल्क संग्रह' },
        report: 'edu_fees_collected',
        kpi: { compare: true },
        x: 0,
        y: 0,
        w: 4,
        h: 2,
      },
      {
        id: 'receipts',
        type: 'kpi',
        title: { en: 'Receipts issued', hi: 'जारी रसीदें' },
        report: 'edu_fees_collected',
        kpi: { aggregate: 1 },
        x: 4,
        y: 0,
        w: 4,
        h: 2,
      },
      {
        id: 'outstanding',
        type: 'kpi',
        title: { en: 'Outstanding fees', hi: 'बकाया शुल्क' },
        report: 'edu_dues_outstanding',
        x: 8,
        y: 0,
        w: 4,
        h: 2,
      },
      {
        id: 'by_month',
        type: 'chart',
        title: { en: 'Fees by class and month', hi: 'कक्षा और माह के अनुसार शुल्क' },
        report: 'edu_fees_by_class_month',
        x: 0,
        y: 2,
        w: 8,
        h: 4,
      },
      {
        id: 'by_head',
        type: 'chart',
        title: { en: 'By fee head', hi: 'शुल्क मद के अनुसार' },
        report: 'edu_fees_by_head',
        x: 8,
        y: 2,
        w: 4,
        h: 4,
      },
      {
        id: 'dues',
        type: 'chart',
        title: { en: 'Dues by class', hi: 'कक्षा के अनुसार बकाया' },
        report: 'edu_dues_by_class',
        x: 0,
        y: 6,
        w: 6,
        h: 4,
      },
      {
        id: 'upcoming',
        type: 'list',
        title: { en: 'Due in the next 7 days', hi: 'अगले 7 दिनों में देय' },
        report: 'edu_dues_upcoming',
        limit: 10,
        x: 6,
        y: 6,
        w: 6,
        h: 4,
      },
      {
        id: 'links',
        type: 'links',
        title: { en: 'Quick actions', hi: 'त्वरित कार्य' },
        links: [
          { label: { en: 'New fee receipt', hi: 'नई शुल्क रसीद' }, href: '/r/edu_fee_receipt/new' },
          { label: { en: 'New fee due', hi: 'नया देय शुल्क' }, href: '/r/edu_fee_due/new' },
        ],
        x: 0,
        y: 10,
        w: 12,
        h: 2,
      },
    ],
  },
];

// ---- roles ----

const crud = (entity: string, actions = ['read', 'create', 'update', 'delete']) =>
  actions.map((a) => `records.${entity}.${a}`);
const read = (...entities: string[]) => entities.map((e) => `records.${e}.read`);

const ROLES_: PackRole[] = [
  {
    key: 'principal',
    name: { en: 'Principal', hi: 'प्रधानाचार्य' },
    description: {
      en: 'Sees everything, approves admissions and cancels receipts',
      hi: 'सब कुछ देखते हैं, प्रवेश स्वीकृत करते हैं और रसीदें रद्द करते हैं',
    },
    permissions: [
      ...crud('edu_academic_year'),
      ...crud('edu_class'),
      ...crud('edu_admission', ['read', 'create', 'update']),
      ...crud('edu_student', ['read', 'create', 'update']),
      ...crud('edu_guardian', ['read', 'create', 'update']),
      ...crud('edu_fee_head', ['read', 'create', 'update']),
      ...crud('edu_fee_structure', ['read', 'create', 'update']),
      ...read('edu_fee_receipt', 'edu_fee_due'),
      'records.edu_fee_receipt.update',
      'reports.personal',
      'reports.share',
      'reports.export',
    ],
  },
  {
    key: 'accountant',
    name: { en: 'Accountant', hi: 'लेखाकार' },
    description: {
      en: 'Fee heads, fee structures, receipts and dues',
      hi: 'शुल्क मद, शुल्क संरचना, रसीदें और बकाया',
    },
    permissions: [
      ...crud('edu_fee_head', ['read', 'create', 'update']),
      ...crud('edu_fee_structure'),
      ...crud('edu_fee_receipt', ['read', 'create', 'update']),
      ...crud('edu_fee_due'),
      ...read('edu_student', 'edu_guardian', 'edu_class', 'edu_academic_year'),
      'reports.personal',
      'reports.export',
    ],
  },
  {
    key: 'front_office',
    name: { en: 'Front office', hi: 'फ्रंट ऑफिस' },
    description: {
      en: 'Enquiries, admissions, students and guardians; collects fees',
      hi: 'पूछताछ, प्रवेश, छात्र और अभिभावक; शुल्क जमा करता है',
    },
    permissions: [
      ...crud('edu_admission', ['read', 'create', 'update']),
      ...crud('edu_student', ['read', 'create', 'update']),
      ...crud('edu_guardian', ['read', 'create', 'update']),
      ...crud('edu_fee_receipt', ['read', 'create']),
      ...read('edu_fee_due', 'edu_fee_head', 'edu_fee_structure', 'edu_class', 'edu_academic_year'),
    ],
  },
  {
    key: 'teacher',
    name: { en: 'Teacher', hi: 'अध्यापक' },
    description: {
      en: 'Sees classes, students and guardians',
      hi: 'कक्षाएँ, छात्र और अभिभावक देखते हैं',
    },
    permissions: [...read('edu_class', 'edu_student', 'edu_guardian', 'edu_academic_year')],
  },
];

// ---- sample records ----

const SAMPLES: PackSample[] = [
  {
    ref: 'year',
    entity: 'edu_academic_year',
    data: { name: '2026-27', start_date: '2026-04-01', end_date: '2027-03-31', current: true },
  },
  {
    ref: 'class_5a',
    entity: 'edu_class',
    data: { name: 'Class 5 A', grade: '5', section: 'A', academic_year: '@year', capacity: 40 },
  },
  {
    ref: 'class_6a',
    entity: 'edu_class',
    data: { name: 'Class 6 A', grade: '6', section: 'A', academic_year: '@year', capacity: 40 },
  },
  {
    ref: 'fh_tuition',
    entity: 'edu_fee_head',
    data: { name: 'Tuition fee', code: 'TUI', price: '12000', frequency: 'quarterly' },
  },
  {
    ref: 'fh_admission',
    entity: 'edu_fee_head',
    data: { name: 'Admission fee', code: 'ADM', price: '5000', frequency: 'one_time' },
  },
  {
    ref: 'fh_transport',
    entity: 'edu_fee_head',
    data: { name: 'Transport fee', code: 'TRN', price: '1500', frequency: 'monthly' },
  },
  {
    ref: 'guardian_1',
    entity: 'edu_guardian',
    data: {
      name: 'Suresh Kumar',
      relation: 'father',
      phone: '+919876543210',
      email: 'suresh.kumar@example.com',
    },
  },
  {
    ref: 'student_1',
    entity: 'edu_student',
    data: {
      name: 'Ananya Kumar',
      class_section: '@class_5a',
      roll_no: '12',
      date_of_birth: '2015-06-14',
      gender: 'female',
      guardian: '@guardian_1',
      guardian_phone: '+919876543210',
      guardian_email: 'suresh.kumar@example.com',
      joined_on: '2024-04-01',
      enrolment_status: 'active',
    },
  },
  {
    ref: 'student_2',
    entity: 'edu_student',
    data: {
      name: 'Rohan Verma',
      class_section: '@class_6a',
      roll_no: '7',
      gender: 'male',
      guardian_phone: '+919812345678',
      joined_on: '2023-04-01',
      enrolment_status: 'active',
    },
  },
  {
    ref: 'structure_5',
    entity: 'edu_fee_structure',
    data: {
      name: 'Class 5, 2026-27',
      academic_year: '@year',
      class_section: '@class_5a',
      heads: [
        {
          fee_head: '@fh_admission',
          amount: '5000',
          frequency: 'one_time',
          due_date: '2026-04-10',
        },
        {
          fee_head: '@fh_tuition',
          amount: '12000',
          frequency: 'quarterly',
          due_date: '2026-04-10',
        },
        { fee_head: '@fh_transport', amount: '1500', frequency: 'monthly', due_date: '2026-04-10' },
      ],
    },
  },
  {
    ref: 'admission_1',
    entity: 'edu_admission',
    data: {
      applicant_name: 'Meera Iyer',
      date_of_birth: '2016-02-20',
      gender: 'female',
      class_applied: '@class_5a',
      academic_year: '@year',
      applied_on: '2026-09-20',
      source: 'website',
      guardian_name: 'Lakshmi Iyer',
      guardian_phone: '+919900112233',
      guardian_email: 'lakshmi.iyer@example.com',
      previous_school: 'Little Flower School',
    },
  },
  {
    ref: 'due_1',
    entity: 'edu_fee_due',
    data: {
      student: '@student_1',
      class_section: '@class_5a',
      academic_year: '@year',
      fee_head: '@fh_tuition',
      description: 'Tuition fee, July to September',
      due_date: '2026-07-10',
      amount: '12000',
      paid_amount: '12000',
      guardian_email: 'suresh.kumar@example.com',
    },
  },
  {
    ref: 'receipt_1',
    entity: 'edu_fee_receipt',
    data: {
      customer: '@student_1',
      date: '2026-07-05',
      class_section: '@class_5a',
      academic_year: '@year',
      fee_due: '@due_1',
      payment_mode: 'upi',
      payment_ref: '618204937125',
      lines: [
        {
          item: '@fh_tuition',
          description: 'Tuition fee',
          period: 'July to September',
          qty: 1,
          rate: '12000',
        },
      ],
    },
  },
];

export const EDUCATION: PackManifest = {
  id: 'industry.education',
  type: 'industry',
  version: '1.0.0',
  name: { en: 'Education', hi: 'शिक्षा' },
  description: {
    en: 'For schools and coaching institutes: admissions (applied, verified, approved, admitted), students and guardians, classes, fee heads and structures, bilingual A5 fee receipts, fee dues with reminders, admission letters, and Principal and Accountant dashboards.',
    hi: 'विद्यालयों और कोचिंग संस्थानों के लिए: प्रवेश (आवेदित, सत्यापित, स्वीकृत, प्रवेश), छात्र और अभिभावक, कक्षाएँ, शुल्क मद और संरचना, द्विभाषी ए5 शुल्क रसीदें, अनुस्मारक सहित बकाया शुल्क, प्रवेश पत्र, और प्रधानाचार्य व लेखाकार डैशबोर्ड।',
  },
  suggestFor: ['education'],
  layer: {
    entities: ENTITIES,
    picklists: PICKLISTS,
    forms: FORMS,
    listViews: LIST_VIEWS,
    numbering: NUMBERING,
    workflows: WORKFLOWS,
    rules: RULES,
    automations: AUTOMATIONS,
    templates: TEMPLATES,
    printTemplates: PRINT_TEMPLATES,
    reports: REPORTS,
    dashboards: DASHBOARDS,
  },
  roles: ROLES_,
  samples: SAMPLES,
};
