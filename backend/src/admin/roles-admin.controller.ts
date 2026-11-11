import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import { actorOf } from '../auth/actor';
import { Authorize, AuthorizedRequest } from '../auth/authorize';
import { PageAccessService } from './page-access';

/** Users → Roles and access: which pages each role may view or edit. */
@Controller('admin/roles')
export class RolesAdminController {
  constructor(private readonly access: PageAccessService) {}

  /** The pages, their access levels and every role's current level (read by user administrators). */
  @Get('access')
  @Authorize({ permissions: ['user.manage'] })
  matrix() {
    return this.access.matrix();
  }

  /** Body { access: { <page>: <level> }, reason }. Super Admins only (role.manage); audited as ROLE_ACCESS_CHANGED. */
  @Put(':code/access')
  @Authorize({ permissions: ['role.manage'], stepUp: true })
  save(@Param('code') code: string, @Body() body: unknown, @Req() req: AuthorizedRequest) {
    return this.access.save(actorOf(req), code.slice(0, 40), body && typeof body === 'object' ? (body as Record<string, unknown>) : {});
  }
}
