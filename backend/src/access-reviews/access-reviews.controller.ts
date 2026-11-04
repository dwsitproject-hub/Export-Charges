import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { actorOf } from '../auth/actor';
import { Authorize, AuthorizedRequest } from '../auth/authorize';
import { sendFile } from '../exports/exports.controller';
import { entityParam } from '../registry/registry.controller';
import { AccessReviewsService } from './access-reviews.service';

/** Technical Design §4.1.7 and §5.1 "Admin": quarterly access reviews (PRD F-12). */
@Controller('admin/reviews')
export class AccessReviewsController {
  constructor(private readonly reviews: AccessReviewsService) {}

  /** Campaigns with their progress (User Admins, Super Admins, Auditors). */
  @Get()
  @Authorize({ permissions: ['accessreview.read'] })
  list(@Req() req: AuthorizedRequest) {
    return this.reviews.list(actorOf(req));
  }

  @Get(':id')
  @Authorize({ permissions: ['accessreview.read'] })
  get(@Param('id') id: string, @Req() req: AuthorizedRequest) {
    return this.reviews.get(actorOf(req), entityParam(id, 'Access review'));
  }

  /** Keep or revoke one assignment (fresh authenticator code). Revoking removes the role and ends the user's sessions. */
  @Post(':id/items/:itemId')
  @HttpCode(200)
  @Authorize({ permissions: ['user.manage'], stepUp: true })
  decide(@Param('id') id: string, @Param('itemId') itemId: string, @Body() body: { decision?: unknown; reason?: unknown }, @Req() req: AuthorizedRequest) {
    return this.reviews.decide(actorOf(req), entityParam(id, 'Access review'), entityParam(itemId, 'Review item'), body ?? {});
  }

  /** The signed PDF/A report of a completed review. */
  @Get(':id/report')
  @Authorize({ permissions: ['accessreview.read'] })
  async report(@Param('id') id: string, @Req() req: AuthorizedRequest, @Res() res: Response) {
    const { body, filename } = await this.reviews.reportFile(actorOf(req), entityParam(id, 'Access review'));
    sendFile(res, { body, filename, contentType: 'application/pdf' });
  }

  @Get(':id/report/verify')
  @Authorize({ permissions: ['accessreview.read'] })
  verify(@Param('id') id: string) {
    return this.reviews.verifyReport(entityParam(id, 'Access review'));
  }
}
