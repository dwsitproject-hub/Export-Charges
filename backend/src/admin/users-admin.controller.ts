import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { actorOf } from '../auth/actor';
import { Authorize, AuthorizedRequest } from '../auth/authorize';
import { ApiError } from '../common/api-error';
import { UsersAdminService } from './users-admin.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function targetId(id: string): string {
  if (!UUID.test(id)) throw new ApiError(404, 'NOT_FOUND', 'User not found.');
  return id;
}

function body(b: unknown): Record<string, unknown> {
  return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
}

/** Technical Design §5.1 "Users". Changes need user.manage plus a fresh TOTP step-up. */
@Controller('admin/users')
export class UsersAdminController {
  constructor(private readonly users: UsersAdminService) {}

  @Get()
  @Authorize({ permissions: ['user.manage'] })
  list(@Query() q: Record<string, string | undefined>) {
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
    return this.users.list({ q: q.q?.slice(0, 100) || undefined, status: q.status || undefined, role: q.role?.toUpperCase() || undefined, limit, offset });
  }

  @Get(':id')
  @Authorize({ permissions: ['user.manage'] })
  get(@Param('id') id: string) {
    return this.users.get(targetId(id));
  }

  @Put(':id/roles')
  @Authorize({ permissions: ['user.manage'], stepUp: true })
  setRoles(@Param('id') id: string, @Body() b: unknown, @Req() req: AuthorizedRequest) {
    return this.users.setRoles(actorOf(req), targetId(id), body(b).roles, body(b).reason);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @Authorize({ permissions: ['user.manage'], stepUp: true })
  deactivate(@Param('id') id: string, @Body() b: unknown, @Req() req: AuthorizedRequest) {
    return this.users.deactivate(actorOf(req), targetId(id), body(b).reason);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @Authorize({ permissions: ['user.manage'], stepUp: true })
  reactivate(@Param('id') id: string, @Body() b: unknown, @Req() req: AuthorizedRequest) {
    return this.users.reactivate(actorOf(req), targetId(id), body(b).reason);
  }

  /** Defensive action (e.g. suspected compromise), so no step-up is required. */
  @Post(':id/revoke-sessions')
  @HttpCode(200)
  @Authorize({ permissions: ['user.manage'] })
  revokeSessions(@Param('id') id: string, @Body() b: unknown, @Req() req: AuthorizedRequest) {
    return this.users.revokeSessions(actorOf(req), targetId(id), body(b).reason);
  }

  @Post(':id/reset-totp')
  @HttpCode(200)
  @Authorize({ permissions: ['user.manage'], stepUp: true })
  resetTotp(@Param('id') id: string, @Body() b: unknown, @Req() req: AuthorizedRequest) {
    return this.users.resetTotp(actorOf(req), targetId(id), body(b).reason);
  }
}
