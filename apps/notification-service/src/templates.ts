import type { EmailTemplate } from '@erp/contracts';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

type Vars = Record<string, string>;
type Copy = {
  subject: (v: Vars) => string;
  lines: (v: Vars) => string[];
  action: string;
  dir?: 'rtl';
};

/**
 * Email copy per template and language. English is the fallback. Later these
 * move into Language Packs so tenants can add languages and edit wording.
 */
const COPY: Record<EmailTemplate, Record<string, Copy>> = {
  'user.invite': {
    en: {
      subject: (v) => `You're invited to ${v.company || 'your company'} on global-erp`,
      lines: (v) => [
        `Hello ${v.name},`,
        `${v.inviter || 'An administrator'} has invited you to join ${v.company || 'your company'}.`,
        'This link is valid for 7 days.',
      ],
      action: 'Accept invitation',
    },
    hi: {
      subject: (v) => `global-erp पर ${v.company || 'आपकी कंपनी'} में आमंत्रण`,
      lines: (v) => [
        `नमस्ते ${v.name},`,
        `${v.inviter || 'एक व्यवस्थापक'} ने आपको ${v.company || 'आपकी कंपनी'} से जुड़ने के लिए आमंत्रित किया है।`,
        'यह लिंक 7 दिनों तक मान्य है।',
      ],
      action: 'आमंत्रण स्वीकार करें',
    },
    ar: {
      subject: (v) => `دعوة للانضمام إلى ${v.company || 'شركتك'} على global-erp`,
      lines: (v) => [
        `مرحباً ${v.name}،`,
        `قام ${v.inviter || 'أحد المسؤولين'} بدعوتك للانضمام إلى ${v.company || 'شركتك'}.`,
        'هذا الرابط صالح لمدة 7 أيام.',
      ],
      action: 'قبول الدعوة',
      dir: 'rtl',
    },
  },
  'otp.code': {
    en: {
      subject: (v) => `${v.code} is your global-erp sign-in code`,
      lines: (v) => [
        `Your sign-in code is ${v.code}.`,
        'It expires in 5 minutes. Never share it with anyone, including our staff.',
        'If you did not try to sign in, you can ignore this email.',
      ],
      action: '',
    },
    hi: {
      subject: (v) => `${v.code} आपका global-erp साइन-इन कोड है`,
      lines: (v) => [
        `आपका साइन-इन कोड ${v.code} है।`,
        'यह 5 मिनट में समाप्त हो जाएगा। इसे किसी के साथ साझा न करें, हमारे कर्मचारियों के साथ भी नहीं।',
        'अगर आपने साइन इन करने की कोशिश नहीं की, तो इस ईमेल को अनदेखा करें।',
      ],
      action: '',
    },
    ar: {
      subject: (v) => `${v.code} هو رمز تسجيل الدخول إلى global-erp`,
      lines: (v) => [
        `رمز تسجيل الدخول الخاص بك هو ${v.code}.`,
        'تنتهي صلاحيته خلال 5 دقائق. لا تشاركه مع أي أحد، ولا حتى مع موظفينا.',
        'إذا لم تحاول تسجيل الدخول، يمكنك تجاهل هذه الرسالة.',
      ],
      action: '',
      dir: 'rtl',
    },
  },
  'password.reset': {
    en: {
      subject: () => 'Reset your global-erp password',
      lines: (v) => [
        `Hello ${v.name},`,
        'We received a request to reset your password. If this was not you, ignore this email.',
        'This link is valid for 1 hour.',
      ],
      action: 'Reset password',
    },
    hi: {
      subject: () => 'अपना global-erp पासवर्ड रीसेट करें',
      lines: (v) => [
        `नमस्ते ${v.name},`,
        'हमें आपका पासवर्ड रीसेट करने का अनुरोध मिला है। अगर यह आपने नहीं किया, तो इस ईमेल को अनदेखा करें।',
        'यह लिंक 1 घंटे तक मान्य है।',
      ],
      action: 'पासवर्ड रीसेट करें',
    },
    ar: {
      subject: () => 'إعادة تعيين كلمة المرور في global-erp',
      lines: (v) => [
        `مرحباً ${v.name}،`,
        'تلقينا طلباً لإعادة تعيين كلمة المرور. إذا لم تكن أنت من طلب ذلك، تجاهل هذه الرسالة.',
        'هذا الرابط صالح لمدة ساعة واحدة.',
      ],
      action: 'إعادة تعيين كلمة المرور',
      dir: 'rtl',
    },
  },
};

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export function render(template: EmailTemplate, locale: string, vars: Vars): RenderedEmail {
  const byLang = COPY[template];
  if (!byLang) throw new Error(`Unknown email template: ${template}`);
  const copy = byLang[locale] ?? byLang[locale.split('-')[0]] ?? byLang.en;
  const lines = copy.lines(vars);
  const link = vars.link ?? '';
  if (link && !/^https?:\/\//.test(link)) throw new Error('Email links must be http(s)');
  const dir = copy.dir ?? 'ltr';
  const html = `<!doctype html><html dir="${dir}"><body style="font-family:Arial,sans-serif;line-height:1.5;color:#1f2933">
${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n')}
${link ? `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#0d6efd;color:#fff;border-radius:6px;text-decoration:none">${escapeHtml(copy.action)}</a></p>` : ''}
</body></html>`;
  const text = [...lines, link ? `${copy.action}: ${link}` : ''].filter(Boolean).join('\n\n');
  return { subject: copy.subject(vars), text, html };
}
