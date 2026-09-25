import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Addresses a webhook may never reach: loopback, private networks, link-local, metadata. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    if (x.startsWith('::ffff:')) return isPrivateAddress(x.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x);
  }
  return true;
}

export class WebhookError extends Error {}

/**
 * Posts a signed JSON body. The receiver checks `X-Erp-Signature: sha256=<hex>`, the
 * HMAC-SHA256 of the raw body with the company's webhook secret. `X-Erp-Delivery` is the
 * same on retries, so the receiver can ignore duplicates.
 */
export async function sendWebhook(opts: {
  url: string;
  body: unknown;
  secret: string;
  deliveryId: string;
  allowPrivate: boolean;
  attempts?: number;
}): Promise<{ status: number }> {
  const url = new URL(opts.url);
  if (url.protocol !== 'https:' && !(opts.allowPrivate && url.protocol === 'http:')) {
    throw new WebhookError('Webhooks must use https://');
  }
  if (!opts.allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host)
      ? [host]
      : (await lookup(host, { all: true })).map((a) => a.address);
    if (!addresses.length || addresses.some(isPrivateAddress)) {
      throw new WebhookError('Webhooks cannot call internal or private network addresses');
    }
  }
  const raw = JSON.stringify(opts.body);
  const signature = createHmac('sha256', opts.secret).update(raw).digest('hex');
  const attempts = opts.attempts ?? 3;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, 500 * 4 ** (i - 1)));
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'global-erp-webhooks/1',
          'x-erp-signature': `sha256=${signature}`,
          'x-erp-delivery': opts.deliveryId,
        },
        body: raw,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status < 300) return { status: res.status };
      last = new WebhookError(`The receiver answered ${res.status}`);
      if (res.status < 500 && res.status !== 429) break; // a 4xx will not get better
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof WebhookError
    ? last
    : new WebhookError(`Could not reach the receiver: ${String((last as Error)?.message ?? last)}`);
}
