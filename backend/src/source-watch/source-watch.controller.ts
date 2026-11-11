import { Controller, Get, HttpCode, Param, Post, Query, Req, Body } from '@nestjs/common';
import { actorOf } from '../auth/actor';
import { Authorize, AuthorizedRequest } from '../auth/authorize';
import { entityParam } from '../registry/registry.controller';
import { SourceWatchService } from './source-watch.service';

/** PRD FR-SRC-03 / FR-SRC-04: what the daily source watch found on the official publishers. */
@Controller('source-watch')
export class SourceWatchController {
  constructor(private readonly watch: SourceWatchService) {}

  /** Items (open first) and the last run; anyone who reads change sets. */
  @Get()
  @Authorize({ permissions: ['page.source_watch'] })
  list(@Query('status') status?: string) {
    return this.watch.list(status);
  }

  /** `{status: "DONE" | "DISMISSED", note}`; a note is required to dismiss. */
  @Post(':id/resolve')
  @HttpCode(200)
  @Authorize({ permissions: ['changeset.create'] })
  resolve(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthorizedRequest) {
    return this.watch.resolve(actorOf(req), entityParam(id, 'Source watch item'), body);
  }
}
