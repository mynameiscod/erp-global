import type { MessageTemplate } from './automation-types';

/**
 * Messages the workflow engine sends by itself. A company can override any of them by
 * publishing a message template with the same key.
 */
export const BUILTIN_TEMPLATES: MessageTemplate[] = [
  {
    key: 'approval.requested',
    label: { en: 'Approval requested' },
    title: {
      en: 'Approval needed: {{entity}} {{record.title}}',
      hi: 'स्वीकृति आवश्यक: {{entity}} {{record.title}}',
      ar: 'مطلوب موافقة: {{entity}} {{record.title}}',
    },
    body: {
      en: '{{actor.name}} asks for your approval of {{entity}} {{record.title}}.',
      hi: '{{actor.name}} ने {{entity}} {{record.title}} के लिए आपकी स्वीकृति माँगी है।',
      ar: 'يطلب {{actor.name}} موافقتك على {{entity}} {{record.title}}.',
    },
  },
  {
    key: 'approval.reminder',
    label: { en: 'Approval reminder' },
    title: {
      en: 'Reminder: {{entity}} {{record.title}} is waiting for you',
      hi: 'अनुस्मारक: {{entity}} {{record.title}} आपकी प्रतीक्षा में है',
      ar: 'تذكير: {{entity}} {{record.title}} بانتظارك',
    },
    body: {
      en: '{{entity}} {{record.title}} is still waiting for your approval.',
      hi: '{{entity}} {{record.title}} अभी भी आपकी स्वीकृति की प्रतीक्षा में है।',
      ar: 'لا يزال {{entity}} {{record.title}} بانتظار موافقتك.',
    },
  },
  {
    key: 'approval.escalated',
    label: { en: 'Approval escalated' },
    title: {
      en: 'Escalated to you: {{entity}} {{record.title}}',
      hi: 'आपको आगे भेजा गया: {{entity}} {{record.title}}',
      ar: 'تم تصعيده إليك: {{entity}} {{record.title}}',
    },
    body: {
      en: 'No one acted on {{entity}} {{record.title}} in time, so it now needs your approval.',
      hi: '{{entity}} {{record.title}} पर समय पर कार्रवाई नहीं हुई, इसलिए अब इसे आपकी स्वीकृति चाहिए।',
      ar: 'لم يتخذ أحد إجراءً بشأن {{entity}} {{record.title}} في الوقت المحدد، لذا يحتاج الآن إلى موافقتك.',
    },
  },
  {
    key: 'approval.approved',
    label: { en: 'Request approved' },
    title: {
      en: 'Approved: {{entity}} {{record.title}}',
      hi: 'स्वीकृत: {{entity}} {{record.title}}',
      ar: 'تمت الموافقة: {{entity}} {{record.title}}',
    },
    body: {
      en: 'Your {{entity}} {{record.title}} was approved.',
      hi: 'आपका {{entity}} {{record.title}} स्वीकृत हो गया।',
      ar: 'تمت الموافقة على {{entity}} {{record.title}} الخاص بك.',
    },
  },
  {
    key: 'approval.rejected',
    label: { en: 'Request rejected' },
    title: {
      en: 'Not approved: {{entity}} {{record.title}}',
      hi: 'अस्वीकृत: {{entity}} {{record.title}}',
      ar: 'لم تتم الموافقة: {{entity}} {{record.title}}',
    },
    body: {
      en: '{{actor.name}} did not approve your {{entity}} {{record.title}}. {{comment}}',
      hi: '{{actor.name}} ने आपका {{entity}} {{record.title}} स्वीकृत नहीं किया। {{comment}}',
      ar: 'لم يوافق {{actor.name}} على {{entity}} {{record.title}} الخاص بك. {{comment}}',
    },
  },
  {
    key: 'approval.digest',
    label: { en: 'Daily approvals digest' },
    title: {
      en: '{{count}} approvals are waiting for you',
      hi: '{{count}} स्वीकृतियाँ आपकी प्रतीक्षा में हैं',
      ar: '{{count}} موافقات بانتظارك',
    },
    body: {
      en: 'You have {{count}} requests waiting for your approval.',
      hi: 'आपके पास स्वीकृति के लिए {{count}} अनुरोध हैं।',
      ar: 'لديك {{count}} طلبات بانتظار موافقتك.',
    },
  },
  {
    key: 'report.ready',
    label: { en: 'Report export ready' },
    title: {
      en: 'Your export is ready: {{report}}',
      hi: 'आपका निर्यात तैयार है: {{report}}',
      ar: 'التصدير جاهز: {{report}}',
    },
    body: {
      en: '{{report}} ({{format}}, {{rows}} rows) is ready to download.',
      hi: '{{report}} ({{format}}, {{rows}} पंक्तियाँ) डाउनलोड के लिए तैयार है।',
      ar: '{{report}} ({{format}}، {{rows}} صفوف) جاهز للتنزيل.',
    },
  },
];

export const BUILTIN_TEMPLATE_KEYS = BUILTIN_TEMPLATES.map((t) => t.key);

/** Replaces `{{a.b}}` placeholders; unknown ones become empty. Values are plain text. */
export function fillTemplate(text: string, vars: Record<string, unknown>): string {
  return text
    .replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, path: string) => {
      let v: unknown = vars;
      for (const part of path.split('.')) {
        v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined;
      }
      if (v === undefined || v === null) return '';
      if (typeof v === 'object' && 'amount' in (v as object))
        return String((v as { amount: unknown }).amount);
      return Array.isArray(v) ? v.join(', ') : String(v);
    })
    .replace(/[ \t]+$/gm, '')
    .trim();
}
