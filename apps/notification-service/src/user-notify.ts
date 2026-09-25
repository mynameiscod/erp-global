import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import type { EventEnvelope, NotifyChannel, UserNotifyPayload } from '@erp/contracts';
import { BUILTIN_TEMPLATES, fillTemplate, pickText, type MessageTemplate } from '@erp/metadata';
import { TENANT_DATABASES } from '@erp/service-kit';
import { runAsTenant, type TenantDatabases } from '@erp/tenancy';
import { CLIENTS, type Clients, type UserInfo } from './clients';
import {
  InboxModel,
  PreferenceModel,
  PushModel,
  SentModel,
  type InboxItem,
  type Preference,
} from './inbox.models';
import { MAILER, type Mailer } from './mailer';
import { appUrl, PUSH, type PushSender } from './push';
import { renderMessage } from './templates';
import { WHATSAPP, WhatsappDisabledError, type WhatsappSender } from './whatsapp';

const SYSTEM = { type: 'system' as const, id: 'notification-service' };

/** With the daily digest on, these arrive in the digest instead of one email each. */
const DIGESTED = new Set(['approval.requested', 'approval.reminder']);

export function inboxDto(i: InboxItem) {
  return {
    id: String(i._id),
    template: i.template,
    title: i.title,
    body: i.body,
    link: i.link ?? null,
    read: !!i.readAt,
    createdAt: i.createdAt,
  };
}

/**
 * Open live streams (server-sent events) per user in this process. The bell updates at
 * once when the notification is created here; other replicas' users see it on their
 * next poll.
 */
@Injectable()
export class LiveHub {
  private readonly streams = new Map<string, Set<Response>>();

  add(tenantId: string, userId: string, res: Response): () => void {
    const key = `${tenantId}:${userId}`;
    let set = this.streams.get(key);
    if (!set) this.streams.set(key, (set = new Set()));
    set.add(res);
    return () => {
      set!.delete(res);
      if (!set!.size) this.streams.delete(key);
    };
  }

  emit(tenantId: string, userId: string, data: unknown): void {
    for (const res of this.streams.get(`${tenantId}:${userId}`) ?? []) {
      res.write(`event: notification\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }
}

/** Localizes label objects in the variables (e.g. the entity name) for one language. */
function localize(vars: Record<string, unknown>, lang: string, fallback: string) {
  const out: Record<string, unknown> = { ...vars };
  for (const k of ['entity', 'state', 'level']) {
    const v = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = pickText(v as Record<string, string>, lang, fallback);
    }
  }
  return out;
}

/**
 * Delivers `notify.user.requested`: renders the message template in each user's
 * language and sends it on the channels the user allows. Each (request, user, channel)
 * is delivered once; if one channel fails the request is retried and only what is
 * missing is sent again.
 */
@Injectable()
export class UserNotifier {
  constructor(
    @Inject(TENANT_DATABASES) private readonly dbs: TenantDatabases,
    @Inject(CLIENTS) private readonly clients: Clients,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(WHATSAPP) private readonly whatsapp: WhatsappSender,
    @Inject(PUSH) private readonly push: PushSender,
    private readonly hub: LiveHub,
    private readonly log: PinoLogger,
  ) {}

  handle(event: EventEnvelope): Promise<void> {
    return runAsTenant(event.tenantId, SYSTEM, () => this.deliver(event));
  }

  private async template(key: string, orgPath?: string) {
    const cfg = await this.clients.config
      .effective(orgPath && orgPath !== '/' ? orgPath : undefined)
      .catch(() => undefined);
    const tpl: MessageTemplate | undefined =
      cfg?.templates?.find((t) => t.key === key) ?? BUILTIN_TEMPLATES.find((t) => t.key === key);
    return { tpl, defaultLanguage: cfg?.tenant.defaultLanguage ?? 'en' };
  }

  private async deliver(event: EventEnvelope): Promise<void> {
    const p = event.payload as UserNotifyPayload;
    const { tpl, defaultLanguage } = await this.template(p.template, p.orgPath);
    if (!tpl) {
      this.log.warn({ template: p.template }, 'unknown message template; nothing sent');
      return;
    }
    const users = (
      await this.clients.identity.post<UserInfo[]>('/internal/users/batch', { ids: p.userIds })
    ).filter((u) => u.status === 'active');
    if (!users.length) return;
    const Prefs = await this.dbs.model(PreferenceModel);
    const prefs = new Map(
      (await Prefs.find({ userId: { $in: users.map((u) => u.id) } }).lean()).map((x) => [
        x.userId,
        x,
      ]),
    );
    const failures: unknown[] = [];
    for (const user of users) {
      const lang = user.language || defaultLanguage;
      const vars = localize(p.vars, lang, defaultLanguage);
      const message = {
        title: fillTemplate(pickText(tpl.title, lang, defaultLanguage), vars),
        body: fillTemplate(pickText(tpl.body, lang, defaultLanguage), vars),
      };
      for (const channel of p.channels) {
        if (!this.allowed(p, channel, prefs.get(user.id))) continue;
        try {
          await this.send(event, p, tpl, user, channel, lang, vars, message);
        } catch (e) {
          if (e instanceof WhatsappDisabledError) continue;
          this.log.warn({ err: e, channel, userId: user.id }, 'notification delivery failed');
          failures.push(e);
        }
      }
    }
    if (failures.length) throw failures[0];
  }

  private allowed(p: UserNotifyPayload, channel: NotifyChannel, pref?: Preference): boolean {
    if (p.template === 'approval.digest') return channel === 'email' && !!pref?.digest;
    if (channel === 'inapp' && p.essential) return true;
    if (channel === 'email' && pref?.digest && DIGESTED.has(p.template)) return false;
    return !pref?.disabled.includes(`${p.template}:${channel}`);
  }

  private async send(
    event: EventEnvelope,
    p: UserNotifyPayload,
    tpl: MessageTemplate,
    user: UserInfo,
    channel: NotifyChannel,
    lang: string,
    vars: Record<string, unknown>,
    message: { title: string; body: string },
  ): Promise<void> {
    const key = `${event.eventId}:${user.id}:${channel}`;
    if (channel === 'inapp') {
      const Inbox = await this.dbs.model(InboxModel);
      try {
        const [item] = await Inbox.create([
          { userId: user.id, dedupeKey: key, template: p.template, ...message, link: p.link },
        ]);
        this.hub.emit(event.tenantId, user.id, inboxDto(item.toObject()));
      } catch (e) {
        if ((e as { code?: number }).code !== 11000) throw e;
      }
      return;
    }
    const Sent = await this.dbs.model(SentModel);
    if (await Sent.exists({ key })) return;
    const link = p.link ? `${appUrl()}${p.link}` : undefined;
    if (channel === 'email') {
      await this.mailer.send({
        to: user.email,
        ...renderMessage(message.title, message.body, link, lang),
      });
    } else if (channel === 'whatsapp') {
      // WhatsApp needs a template approved by Meta; without one (or a number) it is skipped.
      if (!tpl.whatsapp || !user.phone) return;
      const params = tpl.whatsapp.params.map((ph) => fillTemplate(`{{${ph}}}`, { ...vars, link }));
      await this.whatsapp.sendTemplate(user.phone, tpl.whatsapp.template, lang, params);
    } else if (channel === 'push') {
      const Subs = await this.dbs.model(PushModel);
      const subs = await Subs.find({ userId: user.id }).lean();
      for (const s of subs) {
        const alive = await this.push.send(s, { ...message, url: p.link, tag: p.template });
        if (!alive) await Subs.deleteOne({ _id: s._id });
      }
    }
    await Sent.create([{ key }]).catch((e: { code?: number }) => {
      if (e.code !== 11000) throw e;
    });
  }
}
