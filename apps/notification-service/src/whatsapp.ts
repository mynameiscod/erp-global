import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@erp/service-kit';

export const whatsappEnvSchema = baseEnvSchema.extend({
  /**
   * `meta`: WhatsApp Cloud API. `console`: development only, codes appear in the log.
   * `disabled`: nothing is sent (users use the email fallback). Defaults to console in
   * development and disabled in production until credentials are configured.
   */
  WHATSAPP_PROVIDER: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['meta', 'console', 'disabled']).optional(),
  ),
  WHATSAPP_API_URL: z.string().url().default('https://graph.facebook.com/v21.0'),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  /** Name of the approved Authentication template, e.g. `otp_code`. */
  WHATSAPP_OTP_TEMPLATE: z.string().default('otp_code'),
  /** Languages the template is approved in, first is the default, e.g. `en_US,hi,ar`. */
  WHATSAPP_TEMPLATE_LANGUAGES: z.string().default('en_US'),
  /** Authentication templates with a copy-code button need the code as a button parameter too. */
  WHATSAPP_OTP_BUTTON: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export const WHATSAPP = Symbol('WHATSAPP');

export interface WhatsappSender {
  readonly provider: string;
  sendOtp(to: string, code: string, locale: string): Promise<{ messageId: string }>;
}

export class WhatsappDisabledError extends Error {
  constructor() {
    super('WhatsApp is not configured');
  }
}

/** Picks an approved template language for the user's locale: exact, then base language, then the default. */
export function templateLanguage(locale: string, approved: string[]): string {
  const norm = (s: string) => s.toLowerCase().replace('-', '_');
  const l = norm(locale);
  return (
    approved.find((a) => norm(a) === l) ??
    approved.find((a) => norm(a).split('_')[0] === l.split('_')[0]) ??
    approved[0]
  );
}

class MetaWhatsapp implements WhatsappSender {
  readonly provider = 'meta';
  constructor(private readonly env: z.infer<typeof whatsappEnvSchema>) {}

  async sendOtp(to: string, code: string, locale: string) {
    const langs = this.env.WHATSAPP_TEMPLATE_LANGUAGES.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const components: object[] = [{ type: 'body', parameters: [{ type: 'text', text: code }] }];
    if (this.env.WHATSAPP_OTP_BUTTON) {
      components.push({
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: code }],
      });
    }
    const res = await fetch(
      `${this.env.WHATSAPP_API_URL}/${this.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.env.WHATSAPP_ACCESS_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: to.replace(/^\+/, ''),
          type: 'template',
          template: {
            name: this.env.WHATSAPP_OTP_TEMPLATE,
            language: { code: templateLanguage(locale, langs) },
            components,
          },
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      messages?: { id: string }[];
      error?: { message?: string };
    };
    if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${body.error?.message ?? 'error'}`);
    return { messageId: body.messages?.[0]?.id ?? '' };
  }
}

/** Development only: prints the code so sign-in can be tested without WhatsApp. */
export class ConsoleWhatsapp implements WhatsappSender {
  readonly provider = 'console';
  readonly sent: { to: string; code: string; locale: string }[] = [];
  private readonly log = new Logger('WhatsApp(console)');

  async sendOtp(to: string, code: string, locale: string) {
    this.sent.push({ to, code, locale });
    this.log.warn(`WhatsApp code for ${to}: ${code}`);
    return { messageId: `console-${this.sent.length}` };
  }
}

class DisabledWhatsapp implements WhatsappSender {
  readonly provider = 'disabled';
  async sendOtp(): Promise<{ messageId: string }> {
    throw new WhatsappDisabledError();
  }
}

export function createWhatsapp(): WhatsappSender {
  const env = loadEnv(whatsappEnvSchema);
  const configured = !!env.WHATSAPP_PHONE_NUMBER_ID && !!env.WHATSAPP_ACCESS_TOKEN;
  const provider =
    env.WHATSAPP_PROVIDER ??
    (configured ? 'meta' : env.NODE_ENV === 'production' ? 'disabled' : 'console');
  if (provider === 'console' && env.NODE_ENV === 'production') {
    throw new Error(
      'WHATSAPP_PROVIDER=console would write sign-in codes to the logs; not allowed in production',
    );
  }
  if (provider === 'meta' && !configured) {
    throw new Error(
      'WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN are required for the meta provider',
    );
  }
  if (provider === 'meta') return new MetaWhatsapp(env);
  if (provider === 'console') return new ConsoleWhatsapp();
  return new DisabledWhatsapp();
}
