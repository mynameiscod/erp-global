import { Inject, Injectable } from '@nestjs/common';
import type { Connection } from 'mongoose';
import { EventTypes, type OtpChannel } from '@erp/contracts';
import { OutboxWriter } from '@erp/events';
import { AppError, MONGO_CONNECTION } from '@erp/service-kit';
import { requireContext } from '@erp/tenancy';
import { AuthService, mfaMethodOf } from './auth.service';
import { toUserDto, type User } from './models';
import { invalidCode, maskTarget, OtpService } from './otp.service';

const isDuplicateKey = (e: unknown) => (e as { code?: number })?.code === 11000;

/** The signed-in user's mobile number and code-based two-step verification. */
@Injectable()
export class AccountService {
  constructor(
    private readonly auth: AuthService,
    private readonly otp: OtpService,
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    private readonly outbox: OutboxWriter,
  ) {}

  private async current(): Promise<User> {
    const user = await (await this.auth.users()).findById(requireContext().actor!.id).lean();
    if (!user) throw AppError.notFound('User');
    return user;
  }

  // ---- mobile number ----

  async requestPhone(phone: string) {
    const user = await this.current();
    if (user.phone === phone) throw AppError.conflict('This number is already verified');
    const Users = await this.auth.users();
    if (await Users.exists({ phone, _id: { $ne: user._id } })) {
      throw AppError.conflict('This number is used by another account in your company');
    }
    const sent = await this.otp.issue({
      purpose: 'phone_verify',
      channel: 'whatsapp',
      target: phone,
      rateKey: `user:${String(user._id)}:phone`,
      locale: user.language,
      userId: String(user._id),
      name: user.name,
    });
    return { sentTo: sent.sentTo, expiresIn: sent.expiresIn, resendAfter: sent.resendAfter };
  }

  async verifyPhone(code: string) {
    const user = await this.current();
    const challenge = await this.otp.latestFor(String(user._id), 'phone_verify');
    if (!(await this.otp.consume(challenge, code))) throw invalidCode();
    const phone = challenge!.target;
    const Users = await this.auth.users();
    try {
      await this.conn.transaction(async (session) => {
        await Users.updateOne({ _id: user._id }, { $set: { phone } }, { session });
        await this.outbox.record(
          EventTypes.PhoneVerified,
          { userId: String(user._id), phone: maskTarget(phone), replaced: !!user.phone },
          { session },
        );
      });
    } catch (e) {
      if (isDuplicateKey(e)) {
        throw AppError.conflict('This number is used by another account in your company');
      }
      throw e;
    }
    return toUserDto({ ...user, phone });
  }

  async removePhone() {
    const user = await this.current();
    if (!user.phone) return toUserDto(user);
    if (user.mfa?.enabled && mfaMethodOf(user) === 'whatsapp') {
      throw AppError.badRequest('Switch two-step verification to another method first');
    }
    const Users = await this.auth.users();
    await this.conn.transaction(async (session) => {
      await Users.updateOne({ _id: user._id }, { $unset: { phone: '' } }, { session });
      await this.outbox.record(
        EventTypes.PhoneRemoved,
        { userId: String(user._id), phone: maskTarget(user.phone!) },
        { session },
      );
    });
    const { phone: _p, ...rest } = user;
    return toUserDto(rest as User);
  }

  // ---- two-step verification by WhatsApp or email code ----

  /** Sends a code on the chosen channel; entering it turns the method on. */
  async otpMfaSetup(method: OtpChannel) {
    const user = await this.current();
    if (user.mfa?.enabled) {
      throw AppError.conflict('Turn off two-step verification before changing the method');
    }
    if (method === 'whatsapp' && !user.phone) {
      throw AppError.badRequest('Add and verify a mobile number first');
    }
    const sent = await this.otp.issue({
      purpose: 'mfa_manage',
      channel: method,
      method,
      target: method === 'whatsapp' ? user.phone! : user.email,
      rateKey: `user:${String(user._id)}:manage`,
      locale: user.language,
      userId: String(user._id),
      name: user.name,
    });
    return { sentTo: sent.sentTo, expiresIn: sent.expiresIn, resendAfter: sent.resendAfter };
  }

  async otpMfaEnable(code: string) {
    const user = await this.current();
    if (user.mfa?.enabled) throw AppError.conflict('Two-factor authentication is already on');
    const challenge = await this.otp.latestFor(String(user._id), 'mfa_manage');
    if (!challenge?.method) throw AppError.badRequest('Start two-factor setup first');
    if (!(await this.otp.consume(challenge, code))) {
      throw new AppError(400, 'INVALID_MFA_CODE', 'The code is not correct');
    }
    const Users = await this.auth.users();
    await this.conn.transaction(async (session) => {
      await Users.updateOne(
        { _id: user._id },
        {
          $set: { 'mfa.enabled': true, 'mfa.method': challenge.method },
          $unset: { 'mfa.secretEnc': '', 'mfa.pendingSecretEnc': '' },
        },
        { session },
      );
      await this.outbox.record(
        EventTypes.MfaEnabled,
        { userId: String(user._id), method: challenge.method },
        { session },
      );
    });
    return { mfaEnabled: true, mfaMethod: challenge.method };
  }

  /** A code to confirm turning off WhatsApp/email two-step verification. */
  async mfaManageCode() {
    const user = await this.current();
    const method = mfaMethodOf(user);
    if (!user.mfa?.enabled || method === 'totp') {
      throw AppError.badRequest('Use the code from your authenticator app');
    }
    const channel: OtpChannel = method === 'whatsapp' && user.phone ? 'whatsapp' : 'email';
    const sent = await this.otp.issue({
      purpose: 'mfa_manage',
      channel,
      target: channel === 'whatsapp' ? user.phone! : user.email,
      rateKey: `user:${String(user._id)}:manage`,
      locale: user.language,
      userId: String(user._id),
      name: user.name,
    });
    return {
      channel,
      sentTo: sent.sentTo,
      expiresIn: sent.expiresIn,
      resendAfter: sent.resendAfter,
    };
  }
}
