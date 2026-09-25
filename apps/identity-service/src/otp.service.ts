import { Inject, Injectable } from '@nestjs/common';
import { createHmac, randomInt } from 'node:crypto';
import { Types, type Connection } from 'mongoose';
import {
  EventTypes,
  NotifyTypes,
  type EmailRequestedPayload,
  type OtpChannel,
  type WhatsappRequestedPayload,
} from '@erp/contracts';
import { OutboxWriter } from '@erp/events';
import { AppError, MONGO_CONNECTION, TENANT_DATABASES } from '@erp/service-kit';
import type { TenantDatabases } from '@erp/tenancy';
import { IDENTITY_ENV, type IdentityEnv } from './config';
import { randomToken, safeEqual, sha256 } from './crypto';
import { OtpChallengeModel, type MfaMethod, type OtpChallenge, type OtpPurpose } from './models';

export const OTP_TTL_MS = 5 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_SECONDS = 60;
export const OTP_PER_HOUR = 5;

export interface IssueOtp {
  purpose: OtpPurpose;
  channel: OtpChannel;
  /** Phone number (WhatsApp) or email address. */
  target: string;
  rateKey: string;
  locale: string;
  userId?: string;
  method?: MfaMethod;
  /** Returns a secret the public API can use to find this challenge again. */
  withToken?: boolean;
  /** Records the request but sends nothing: used for unknown numbers so they look the same. */
  decoy?: boolean;
  name?: string;
}

export interface IssuedOtp {
  /** Secret part of the `otpToken`, when `withToken` was set. */
  secret?: string;
  channel: OtpChannel;
  sentTo: string;
  expiresIn: number;
  resendAfter: number;
}

export const invalidCode = (status = 400) =>
  new AppError(status, 'INVALID_CODE', 'The code is not correct or has expired');

/** Shows enough of a number or address for the user to recognise it, and no more. */
export function maskTarget(target: string): string {
  if (target.startsWith('+'))
    return `${target.slice(0, 3)}${'•'.repeat(Math.max(target.length - 7, 2))}${target.slice(-4)}`;
  const [local = '', domain = ''] = target.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
}

@Injectable()
export class OtpService {
  constructor(
    @Inject(TENANT_DATABASES) private readonly dbs: TenantDatabases,
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    @Inject(IDENTITY_ENV) private readonly env: IdentityEnv,
    private readonly outbox: OutboxWriter,
  ) {}

  challenges() {
    return this.dbs.model(OtpChallengeModel);
  }

  private hash(id: Types.ObjectId, code: string): string {
    return createHmac('sha256', Buffer.from(this.env.DATA_ENC_KEY, 'base64'))
      .update(`${String(id)}:${code}`)
      .digest('hex');
  }

  /**
   * Five codes per hour for each number or user, and a minute between them while the last
   * one is still unused (a used code does not hold up the next sign-in).
   */
  private async checkRate(rateKey: string): Promise<void> {
    const Challenges = await this.challenges();
    const now = Date.now();
    const recent = await Challenges.find({ rateKey, createdAt: { $gt: new Date(now - 3_600_000) } })
      .select({ createdAt: 1, usedAt: 1 })
      .sort({ createdAt: -1 })
      .lean();
    const last = recent[0] && !recent[0].usedAt ? recent[0].createdAt.getTime() : undefined;
    if (last && now - last < OTP_RESEND_SECONDS * 1000) {
      const wait = Math.ceil((OTP_RESEND_SECONDS * 1000 - (now - last)) / 1000);
      throw new AppError(
        429,
        'OTP_TOO_SOON',
        `Please wait ${wait} seconds before asking for a new code`,
        {
          retryAfter: wait,
        },
      );
    }
    if (recent.length >= OTP_PER_HOUR) {
      throw new AppError(429, 'OTP_TOO_MANY', 'Too many codes requested. Try again in an hour.');
    }
  }

  async issue(opts: IssueOtp): Promise<IssuedOtp> {
    await this.checkRate(opts.rateKey);
    const Challenges = await this.challenges();
    const _id = new Types.ObjectId();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const secret = opts.withToken ? randomToken() : undefined;

    await this.conn.transaction(async (session) => {
      // Asking for a new code retires the previous one.
      await Challenges.updateMany(
        { rateKey: opts.rateKey, purpose: opts.purpose, usedAt: null },
        { $set: { usedAt: new Date() } },
        { session },
      );
      await Challenges.create(
        [
          {
            _id,
            purpose: opts.purpose,
            userId: opts.userId,
            channel: opts.channel,
            target: opts.target,
            rateKey: opts.rateKey,
            tokenHash: secret ? sha256(secret) : undefined,
            method: opts.method,
            codeHash: this.hash(_id, code),
            expiresAt: new Date(Date.now() + OTP_TTL_MS),
          },
        ],
        { session },
      );
      await this.outbox.record(
        EventTypes.OtpRequested,
        { purpose: opts.purpose, channel: opts.channel, userId: opts.userId ?? null },
        { session },
      );
      if (opts.decoy) return;
      if (opts.channel === 'whatsapp') {
        await this.outbox.record<WhatsappRequestedPayload>(
          NotifyTypes.WhatsappRequested,
          { to: opts.target, template: 'otp', locale: opts.locale, code },
          { session },
        );
      } else {
        await this.outbox.record<EmailRequestedPayload>(
          NotifyTypes.EmailRequested,
          {
            to: opts.target,
            template: 'otp.code',
            locale: opts.locale,
            vars: { code, name: opts.name ?? '' },
          },
          { session },
        );
      }
    });
    return {
      secret,
      channel: opts.channel,
      sentTo: maskTarget(opts.target),
      expiresIn: OTP_TTL_MS / 1000,
      resendAfter: OTP_RESEND_SECONDS,
    };
  }

  /** Finds a challenge by the secret from `issue({ withToken })`, without using it up. */
  async byToken(secret: string, purpose: OtpPurpose): Promise<OtpChallenge | null> {
    return (await this.challenges())
      .findOne({ tokenHash: sha256(secret), purpose, usedAt: null, expiresAt: { $gt: new Date() } })
      .lean();
  }

  async latestFor(userId: string, purpose: OtpPurpose): Promise<OtpChallenge | null> {
    return (await this.challenges())
      .findOne({ userId, purpose, usedAt: null, expiresAt: { $gt: new Date() } })
      .sort({ createdAt: -1 })
      .lean();
  }

  /**
   * Checks a code and uses the challenge up if it matches. Every try counts, and after
   * five wrong ones the code is dead. Returns false for a wrong, expired or used code.
   */
  async consume(challenge: OtpChallenge | null, code: string): Promise<boolean> {
    if (!challenge) return false;
    const Challenges = await this.challenges();
    const c = await Challenges.findOneAndUpdate(
      {
        _id: challenge._id,
        usedAt: null,
        expiresAt: { $gt: new Date() },
        attempts: { $lt: OTP_MAX_ATTEMPTS },
      },
      { $inc: { attempts: 1 } },
      { new: true },
    ).lean();
    if (!c) return false;
    const ok = !!c.userId && safeEqual(this.hash(c._id, code), c.codeHash);
    if (ok) {
      const used = await Challenges.updateOne(
        { _id: c._id, usedAt: null },
        { $set: { usedAt: new Date() } },
      );
      return used.modifiedCount === 1;
    }
    await this.conn.transaction(async (session) => {
      await this.outbox.record(
        EventTypes.OtpFailed,
        { purpose: c.purpose, userId: c.userId ?? null, attempts: c.attempts },
        { session },
      );
    });
    return false;
  }
}
