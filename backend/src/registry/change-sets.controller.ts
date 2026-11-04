import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { actorOf } from '../auth/actor';
import { Authorize, AuthorizedRequest } from '../auth/authorize';
import { ApiError } from '../common/api-error';
import { isDate, wibToday } from '../common/fields';
import { ChangeSetsService } from './change-sets.service';
import { entityParam } from './registry.controller';

const STATUS_FILTER = /^[A-Z_]+(,[A-Z_]+)*$/;

/** Technical Design §5.1 "Change sets". Checker decisions need changeset.approve, SoD-1 and a fresh step-up. */
@Controller('change-sets')
export class ChangeSetsController {
  constructor(private readonly sets: ChangeSetsService) {}

  @Get()
  @Authorize({ permissions: ['changeset.read'] })
  list(@Query() q: Record<string, string | undefined>, @Req() req: AuthorizedRequest) {
    return this.sets.list({
      status: q.status && STATUS_FILTER.test(q.status) ? q.status : undefined,
      mine: q.mine === 'true' ? req.ecr!.user.id : undefined,
      limit: Math.min(Math.max(Number(q.limit ?? 100) || 100, 1), 200),
    });
  }

  @Post()
  @Authorize({ permissions: ['changeset.create'] })
  create(@Body() body: unknown, @Req() req: AuthorizedRequest) {
    return this.sets.create(actorOf(req), body);
  }

  @Get(':id')
  @Authorize({ permissions: ['changeset.read'] })
  get(@Param('id') id: string) {
    return this.sets.get(entityParam(id, 'Change set'));
  }

  /** ?date=YYYY-MM-DD (WIB), default today. */
  @Get(':id/impact')
  @Authorize({ permissions: ['changeset.read'] })
  impact(@Param('id') id: string, @Query('date') date?: string) {
    return this.sets.impact(entityParam(id, 'Change set'), date && isDate(date) ? date : wibToday());
  }

  @Put(':id/items')
  @Authorize({ permissions: ['changeset.create'] })
  saveItem(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthorizedRequest) {
    return this.sets.saveItem(actorOf(req), entityParam(id, 'Change set'), body);
  }

  @Delete(':id/items/:itemId')
  @Authorize({ permissions: ['changeset.create'] })
  removeItem(@Param('id') id: string, @Param('itemId') itemId: string, @Req() req: AuthorizedRequest) {
    return this.sets.removeItem(actorOf(req), entityParam(id, 'Change set'), entityParam(itemId, 'Change item'));
  }

  @Post(':id/submit')
  @HttpCode(200)
  @Authorize({ permissions: ['changeset.submit'] })
  submit(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthorizedRequest) {
    return this.sets.submit(actorOf(req), entityParam(id, 'Change set'), body);
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @Authorize({ permissions: ['changeset.submit'] })
  withdraw(@Param('id') id: string, @Req() req: AuthorizedRequest) {
    return this.sets.withdraw(actorOf(req), entityParam(id, 'Change set'));
  }

  @Post(':id/discard')
  @HttpCode(200)
  @Authorize({ permissions: ['changeset.create'] })
  discard(@Param('id') id: string, @Req() req: AuthorizedRequest) {
    return this.sets.discard(actorOf(req), entityParam(id, 'Change set'));
  }

  @Post(':id/start-review')
  @HttpCode(200)
  @Authorize({ permissions: ['changeset.approve'] })
  startReview(@Param('id') id: string, @Req() req: AuthorizedRequest) {
    return this.sets.startReview(actorOf(req), entityParam(id, 'Change set'));
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Authorize({ permissions: ['changeset.approve'], stepUp: true })
  approve(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthorizedRequest) {
    return this.sets.approve(actorOf(req), entityParam(id, 'Change set'), body);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Authorize({ permissions: ['changeset.approve'], stepUp: true })
  reject(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthorizedRequest) {
    return this.sets.reject(actorOf(req), entityParam(id, 'Change set'), body);
  }

  @Post(':id/cancel-schedule')
  @HttpCode(200)
  @Authorize({ permissions: ['changeset.approve'], stepUp: true })
  cancelSchedule(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthorizedRequest) {
    return this.sets.cancelSchedule(actorOf(req), entityParam(id, 'Change set'), body);
  }

  /** The initiating Checker abandons an open rollback (SUBMITTED, returned to DRAFT, or REJECTED). */
  @Post(':id/cancel-rollback')
  @HttpCode(200)
  @Authorize({ permissions: ['changeset.approve'] })
  cancelRollback(@Param('id') id: string, @Req() req: AuthorizedRequest) {
    return this.sets.cancelRollback(actorOf(req), entityParam(id, 'Change set'));
  }
}

/** Technical Design §4.2.6: rollback of a published data version, as a change set another Checker must approve. */
@Controller('data-versions')
export class RollbackController {
  constructor(private readonly sets: ChangeSetsService) {}

  /** Body: { reason }. 201 with the new ROLLBACK change set (SUBMITTED). */
  @Post(':versionNo/rollback')
  @Authorize({ permissions: ['changeset.approve'], stepUp: true })
  rollback(@Param('versionNo') versionNo: string, @Body() body: unknown, @Req() req: AuthorizedRequest) {
    const v = Number(versionNo);
    if (!Number.isInteger(v) || v < 1) throw new ApiError(404, 'NOT_FOUND', 'Data version not found.');
    return this.sets.rollback(actorOf(req), v, body);
  }
}
