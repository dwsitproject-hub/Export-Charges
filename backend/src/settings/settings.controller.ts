import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { actorOf } from '../auth/actor';
import { Authorize, AuthorizedRequest } from '../auth/authorize';
import { SettingsService } from './settings.service';

/** Technical Design §5.1 "Admin" and PRD F-52: the Configuration screen (Super Admins). */
@Controller('admin/config')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /** Each setting with its value, default, allowed range and last change; deployment-only settings read-only. */
  @Get()
  @Authorize({ permissions: ['config.manage'] })
  list() {
    return this.settings.list();
  }

  /** `{values: {key: value | null}, reason}`; null restores the default. Fresh authenticator code required. */
  @Put()
  @Authorize({ permissions: ['config.manage'], stepUp: true })
  save(@Body() body: { values?: unknown; reason?: unknown }, @Req() req: AuthorizedRequest) {
    return this.settings.save(actorOf(req), body ?? {});
  }
}
