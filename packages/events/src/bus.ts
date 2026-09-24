import type { EventEnvelope } from '@erp/contracts';

export type EventHandler = (event: EventEnvelope) => Promise<void>;

export interface Subscription {
  /** Durable consumer name; unique per service and purpose, e.g. `audit-service-recorder`. */
  durable: string;
  /** Stream to read from. */
  stream: string;
  /** Subject filters, NATS syntax (`erp.>`, `erp.org.unit.*`). */
  subjects: string[];
  handler: EventHandler;
}

export interface EventBus {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** `msgId` makes publishing idempotent within the bus dedupe window. */
  publish(subject: string, event: EventEnvelope, msgId: string): Promise<void>;
  subscribe(sub: Subscription): Promise<void>;
  isHealthy(): boolean;
}

/** NATS-style subject match: `*` is one token, `>` is the rest. */
export function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split('.');
  const s = subject.split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '>') return s.length > i;
    if (i >= s.length) return false;
    if (p[i] !== '*' && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

/**
 * In-process bus for tests and single-process development. Delivery is
 * at-least-once like NATS: a failing handler gets the event again on the next
 * `drain()`.
 */
export class InMemoryEventBus implements EventBus {
  private readonly subs: Subscription[] = [];
  private readonly seen = new Set<string>();
  private queue: { subject: string; event: EventEnvelope; attempts: Map<string, number> }[] = [];
  private draining?: Promise<void>;
  private retryTimer?: NodeJS.Timeout;
  readonly published: EventEnvelope[] = [];

  /** With `autoDrain`, events are delivered in the background as in a real broker. */
  constructor(private readonly opts: { autoDrain?: boolean; maxAttempts?: number } = {}) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }
  isHealthy(): boolean {
    return true;
  }

  async publish(subject: string, event: EventEnvelope, msgId: string): Promise<void> {
    if (this.seen.has(msgId)) return;
    this.seen.add(msgId);
    this.published.push(event);
    this.queue.push({ subject, event, attempts: new Map() });
    if (this.opts.autoDrain) setImmediate(() => void this.drain());
  }

  async subscribe(sub: Subscription): Promise<void> {
    this.subs.push(sub);
  }

  /** Deliver everything queued. Events that fail stay queued. */
  async drain(): Promise<void> {
    while (this.draining) await this.draining;
    this.draining = this.drainOnce();
    try {
      await this.draining;
    } finally {
      this.draining = undefined;
    }
  }

  /** Resolves when nothing is queued (or only events that have exhausted their retries). */
  async idle(timeoutMs = 10_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      await this.drain();
      // An item can be in flight (queue empty) or waiting for a retry timer.
      if (this.queue.length === 0 && !this.draining && !this.retryTimer) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(
      `Event bus not idle after ${timeoutMs}ms: ${this.queue.map((q) => q.event.type).join(', ')}`,
    );
  }

  private async drainOnce(): Promise<void> {
    const max = this.opts.maxAttempts ?? 20;
    const pending = this.queue;
    this.queue = [];
    let retry = false;
    for (const item of pending) {
      let failed = false;
      for (const sub of this.subs) {
        if (!sub.subjects.some((p) => subjectMatches(p, item.subject))) continue;
        const attempts = item.attempts.get(sub.durable) ?? 0;
        if (attempts === -1 || attempts >= max) continue;
        try {
          await sub.handler(item.event);
          item.attempts.set(sub.durable, -1);
        } catch {
          item.attempts.set(sub.durable, attempts + 1);
          failed = attempts + 1 < max;
        }
      }
      if (failed) {
        this.queue.push(item);
        retry = true;
      }
    }
    if (retry && this.opts.autoDrain && !this.retryTimer) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        void this.drain();
      }, 100);
    }
  }
}
