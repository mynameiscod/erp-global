import webpush from 'web-push';
import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@erp/service-kit';

export const pushEnvSchema = baseEnvSchema.extend({
  /** VAPID keys (base64url). Without them web push is off. */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:no-reply@example.com'),
  /** Public web app URL, for links in emails and push messages. */
  APP_URL: z.string().url().default('http://localhost:5173'),
});

export const PUSH = Symbol('PUSH');

export interface PushMessage {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export interface PushSender {
  readonly publicKey: string | null;
  /** Returns false when the subscription is gone (the browser unsubscribed). */
  send(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    message: PushMessage,
  ): Promise<boolean>;
}

export class GoneError extends Error {}

export function createPush(): PushSender {
  const env = loadEnv(pushEnvSchema);
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    return { publicKey: null, send: async () => true };
  }
  const vapid = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    async send(subscription, message) {
      try {
        await webpush.sendNotification(subscription, JSON.stringify(message), {
          vapidDetails: vapid,
          TTL: 24 * 3600,
          timeout: 10_000,
        });
        return true;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) return false;
        throw e;
      }
    },
  };
}

export function appUrl(): string {
  return loadEnv(pushEnvSchema).APP_URL.replace(/\/$/, '');
}
