import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import {
  notificationPreferencesSchema,
  paginationSchema,
  pushSubscriptionSchema,
  type NotificationPreferences,
  type PushSubscriptionInput,
} from '@erp/contracts';
import { AppError, ApiZodBody, TENANT_DATABASES, ZodPipe } from '@erp/service-kit';
import { requireContext, type TenantDatabases } from '@erp/tenancy';
import { InboxModel, PreferenceModel, PushModel } from './inbox.models';
import { PUSH, type PushSender } from './push';
import { inboxDto, LiveHub } from './user-notify';

const listQuery = paginationSchema.extend({
  unread: z.enum(['true', 'false']).optional(),
});

/** The signed-in user's notifications, preferences and push subscriptions. */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('api/v1/notifications')
export class InboxController {
  constructor(
    @Inject(TENANT_DATABASES) private readonly dbs: TenantDatabases,
    @Inject(PUSH) private readonly push: PushSender,
    private readonly hub: LiveHub,
  ) {}

  private me() {
    return requireContext().actor!.id;
  }

  @Get()
  async list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    const Inbox = await this.dbs.model(InboxModel);
    const filter = { userId: this.me(), ...(q.unread === 'true' ? { readAt: null } : {}) };
    const [items, total, unread] = await Promise.all([
      Inbox.find(filter)
        .sort({ createdAt: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean(),
      Inbox.countDocuments(filter),
      Inbox.countDocuments({ userId: this.me(), readAt: null }),
    ]);
    return { items: items.map(inboxDto), total, unread, page: q.page, pageSize: q.pageSize };
  }

  @Get('unread-count')
  async unreadCount() {
    const Inbox = await this.dbs.model(InboxModel);
    return { unread: await Inbox.countDocuments({ userId: this.me(), readAt: null }) };
  }

  @Post(':id/read')
  @HttpCode(200)
  async read(@Param('id') id: string) {
    if (!Types.ObjectId.isValid(id)) throw AppError.notFound('Notification');
    const Inbox = await this.dbs.model(InboxModel);
    await Inbox.updateOne(
      { _id: id, userId: this.me(), readAt: null },
      { $set: { readAt: new Date() } },
    );
    return { ok: true };
  }

  @Post('read-all')
  @HttpCode(200)
  async readAll() {
    const Inbox = await this.dbs.model(InboxModel);
    const res = await Inbox.updateMany(
      { userId: this.me(), readAt: null },
      { $set: { readAt: new Date() } },
    );
    return { updated: res.modifiedCount };
  }

  /**
   * Live updates as server-sent events. Browsers read it with fetch (so the access token
   * travels in the Authorization header); a comment every 25 s keeps proxies from closing it.
   */
  @Get('stream')
  stream(@Req() req: Request, @Res() res: Response) {
    const ctx = requireContext();
    res.status(200);
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders();
    res.write(': connected\n\n');
    const remove = this.hub.add(ctx.tenantId!, ctx.actor!.id, res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      remove();
    });
  }

  // ---- preferences ----

  @Get('preferences')
  async preferences(): Promise<NotificationPreferences> {
    const Prefs = await this.dbs.model(PreferenceModel);
    const p = await Prefs.findOne({ userId: this.me() }).lean();
    return { disabled: p?.disabled ?? [], digest: p?.digest ?? false };
  }

  @Put('preferences')
  @ApiZodBody(notificationPreferencesSchema)
  async setPreferences(
    @Body(new ZodPipe(notificationPreferencesSchema)) body: NotificationPreferences,
  ): Promise<NotificationPreferences> {
    const Prefs = await this.dbs.model(PreferenceModel);
    await Prefs.updateOne(
      { userId: this.me() },
      { $set: { disabled: [...new Set(body.disabled)], digest: body.digest } },
      { upsert: true },
    );
    return this.preferences();
  }

  // ---- web push ----

  @Get('push/key')
  pushKey() {
    return { publicKey: this.push.publicKey };
  }

  @Post('push/subscriptions')
  @ApiZodBody(pushSubscriptionSchema)
  async subscribe(
    @Body(new ZodPipe(pushSubscriptionSchema)) body: PushSubscriptionInput,
    @Req() req: Request,
  ) {
    if (!this.push.publicKey)
      throw new AppError(
        503,
        'PUSH_NOT_CONFIGURED',
        'Push notifications are not set up on this server',
      );
    const Subs = await this.dbs.model(PushModel);
    await Subs.updateOne(
      { endpoint: body.endpoint },
      {
        $set: {
          userId: this.me(),
          keys: body.keys,
          userAgent: req.header('user-agent')?.slice(0, 300),
        },
      },
      { upsert: true },
    );
    return { ok: true };
  }

  @Delete('push/subscriptions')
  async unsubscribe(@Query('endpoint') endpoint: string) {
    const Subs = await this.dbs.model(PushModel);
    await Subs.deleteOne({ endpoint: String(endpoint ?? ''), userId: this.me() });
    return { ok: true };
  }
}
