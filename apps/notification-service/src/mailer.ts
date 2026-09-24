import nodemailer, { type Transporter } from 'nodemailer';
import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@erp/service-kit';

export const notificationEnvSchema = baseEnvSchema.extend({
  /** `smtp` for real delivery (Hostinger mail, SES, etc.), `json` to log messages without sending. */
  MAIL_TRANSPORT: z.enum(['smtp', 'json']).default('smtp'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('global-erp <no-reply@localhost>'),
});

export type NotificationEnv = z.infer<typeof notificationEnvSchema>;

export const MAILER = Symbol('MAILER');

export interface Mailer {
  send(msg: {
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<{ messageId: string }>;
}

export function createMailer(): Mailer {
  const env = loadEnv(notificationEnvSchema);
  const transport: Transporter =
    env.MAIL_TRANSPORT === 'json'
      ? nodemailer.createTransport({ jsonTransport: true })
      : nodemailer.createTransport({
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          secure: env.SMTP_SECURE,
          auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
        });
  return {
    async send(msg) {
      const info = await transport.sendMail({ from: env.MAIL_FROM, ...msg });
      return { messageId: String(info.messageId) };
    },
  };
}
