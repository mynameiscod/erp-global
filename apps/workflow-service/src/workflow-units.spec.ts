import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isPrivateAddress, sendWebhook } from './webhook';
import { nextRun } from './zoned-time';

describe('webhooks', () => {
  it('knows private and internal addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.5',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '172.32.0.1']) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });

  it('refuses http and internal addresses', async () => {
    await expect(
      sendWebhook({
        url: 'http://example.com/x',
        body: {},
        secret: 's',
        deliveryId: 'd',
        allowPrivate: false,
      }),
    ).rejects.toThrow(/https/);
    await expect(
      sendWebhook({
        url: 'https://127.0.0.1/x',
        body: {},
        secret: 's',
        deliveryId: 'd',
        allowPrivate: false,
      }),
    ).rejects.toThrow(/private/);
    await expect(
      sendWebhook({
        url: 'https://[::1]/x',
        body: {},
        secret: 's',
        deliveryId: 'd',
        allowPrivate: false,
      }),
    ).rejects.toThrow(/private/);
  });

  it('signs the body, keeps the delivery id on retries, and gives up on 4xx', async () => {
    const seen: { sig: string; delivery: string; body: string }[] = [];
    let answer = [503, 200];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen.push({
          sig: String(req.headers['x-erp-signature']),
          delivery: String(req.headers['x-erp-delivery']),
          body: raw,
        });
        res.writeHead(answer.shift() ?? 200);
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      const res = await sendWebhook({
        url,
        body: { a: 1 },
        secret: 'top',
        deliveryId: 'run-1:0',
        allowPrivate: true,
      });
      expect(res.status).toBe(200);
      expect(seen).toHaveLength(2);
      expect(new Set(seen.map((s) => s.delivery))).toEqual(new Set(['run-1:0']));
      expect(seen[0].sig).toBe(
        `sha256=${createHmac('sha256', 'top').update(seen[0].body).digest('hex')}`,
      );

      answer = [400, 200];
      await expect(
        sendWebhook({ url, body: {}, secret: 'top', deliveryId: 'run-2:0', allowPrivate: true }),
      ).rejects.toThrow(/400/);
      expect(seen.filter((s) => s.delivery === 'run-2:0')).toHaveLength(1);
    } finally {
      server.close();
    }
  });
});

describe('schedules', () => {
  it('runs daily at the local time of the company', () => {
    // 09:00 in Kolkata is 03:30 UTC.
    expect(
      nextRun(new Date('2026-09-25T01:00:00Z'), 'day', '09:00', 'Asia/Kolkata').toISOString(),
    ).toBe('2026-09-25T03:30:00.000Z');
    expect(
      nextRun(new Date('2026-09-25T03:30:00Z'), 'day', '09:00', 'Asia/Kolkata').toISOString(),
    ).toBe('2026-09-26T03:30:00.000Z');
    // Dubai is UTC+4.
    expect(
      nextRun(new Date('2026-09-25T10:00:00Z'), 'day', '08:00', 'Asia/Dubai').toISOString(),
    ).toBe('2026-09-26T04:00:00.000Z');
  });

  it('follows daylight saving time', () => {
    // New York: 09:00 is 13:00 UTC in summer and 14:00 UTC in winter (DST ends 1 Nov 2026).
    expect(
      nextRun(new Date('2026-10-31T20:00:00Z'), 'day', '09:00', 'America/New_York').toISOString(),
    ).toBe('2026-11-01T14:00:00.000Z');
    expect(
      nextRun(new Date('2026-07-01T00:00:00Z'), 'day', '09:00', 'America/New_York').toISOString(),
    ).toBe('2026-07-01T13:00:00.000Z');
  });

  it('runs hourly on the local hour and every quarter hour', () => {
    // Kolkata is UTC+5:30, so its hours start at :30 UTC.
    expect(
      nextRun(new Date('2026-09-25T01:10:00Z'), 'hour', undefined, 'Asia/Kolkata').toISOString(),
    ).toBe('2026-09-25T01:30:00.000Z');
    expect(nextRun(new Date('2026-09-25T01:10:00Z'), '15min', undefined, 'UTC').toISOString()).toBe(
      '2026-09-25T01:15:00.000Z',
    );
    expect(
      nextRun(new Date('2026-09-25T01:10:00Z'), 'day', '09:00', 'Not/AZone').toISOString(),
    ).toBe('2026-09-25T09:00:00.000Z');
  });
});
