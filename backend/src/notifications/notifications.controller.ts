import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { actorOf } from '../auth/actor';
import { Authorize, AuthorizedRequest } from '../auth/authorize';
import { ApiError } from '../common/api-error';
import { UUID_RE } from '../common/fields';
import { entityParam } from '../registry/registry.controller';
import { NotificationsService } from './notifications.service';

/** In-app notifications, change subscriptions (F-48) and change bulletins (Technical Design §5.1 "Notifications"). */
@Controller()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** Every signed-in person has their own notifications; no permission beyond a session. */
  @Get('notifications')
  @Authorize()
  list(@Query('unread') unread: string | undefined, @Req() req: AuthorizedRequest) {
    return this.notifications.list(req.ecr!.user.id, unread === 'true');
  }

  @Get('notifications/unread-count')
  @Authorize()
  unreadCount(@Req() req: AuthorizedRequest) {
    return this.notifications.unreadCount(req.ecr!.user.id);
  }

  /** Body: { id } marks one notification read; no id marks all read. */
  @Post('notifications/read')
  @HttpCode(200)
  @Authorize()
  markRead(@Body() body: { id?: unknown } | undefined, @Req() req: AuthorizedRequest) {
    const id = typeof body?.id === 'string' && UUID_RE.test(body.id) ? body.id.toLowerCase() : null;
    if (body?.id !== undefined && !id) throw new ApiError(400, 'INVALID_INPUT', 'id must be a notification id.');
    return this.notifications.markRead(req.ecr!.user.id, id);
  }

  @Get('subscriptions')
  @Authorize({ permissions: ['catalogue.read'] })
  subscriptions(@Req() req: AuthorizedRequest) {
    return this.notifications.subscriptions(req.ecr!.user.id);
  }

  /** Body: { scopeType: COMMODITY | PRODUCT_GROUP | PRODUCT, scopeEntityId }. */
  @Post('subscriptions')
  @HttpCode(200)
  @Authorize({ permissions: ['catalogue.read'] })
  subscribe(@Body() body: unknown, @Req() req: AuthorizedRequest) {
    return this.notifications.subscribe(actorOf(req), body);
  }

  @Delete('subscriptions/:id')
  @Authorize({ permissions: ['catalogue.read'] })
  unsubscribe(@Param('id') id: string, @Req() req: AuthorizedRequest) {
    return this.notifications.unsubscribe(actorOf(req), entityParam(id, 'Subscription'));
  }

  /** One-click unsubscribe from an email link; the signed token replaces the session (US-48-N1 AC1). */
  @Post('subscriptions/unsubscribe')
  @HttpCode(200)
  unsubscribeByToken(@Body() body: { token?: unknown } | undefined) {
    return this.notifications.unsubscribeByToken(body?.token);
  }

  @Get('data-versions/:versionNo/bulletin')
  @Authorize({ permissions: ['catalogue.read'] })
  bulletin(@Param('versionNo') versionNo: string) {
    const v = Number(versionNo);
    if (!Number.isInteger(v) || v < 1) throw new ApiError(404, 'NOT_FOUND', 'Data version not found.');
    return this.notifications.bulletin(v);
  }
}
