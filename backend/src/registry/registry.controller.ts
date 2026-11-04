import { Controller, Get, Param, Query } from '@nestjs/common';
import { Authorize } from '../auth/authorize';
import { ApiError } from '../common/api-error';
import { UUID_RE } from '../common/fields';
import { REG_STATUSES, REG_TYPES } from './entities';
import { RegistryReadService } from './registry-read.service';

export function entityParam(id: string, what: string): string {
  if (!UUID_RE.test(id)) throw new ApiError(404, 'NOT_FOUND', `${what} not found.`);
  return id.toLowerCase();
}

function optionalUuid(v: string | undefined): string | undefined {
  return v && UUID_RE.test(v) ? v.toLowerCase() : undefined;
}

/** Published regulation register and product master (Technical Design §5.1 "Regulations", "Catalogue"). */
@Controller()
export class RegistryController {
  constructor(private readonly registry: RegistryReadService) {}

  @Get('regulations')
  @Authorize({ permissions: ['catalogue.read'] })
  regulations(@Query() q: Record<string, string | undefined>) {
    return this.registry.regulations({
      q: q.q?.slice(0, 100) || undefined,
      status: REG_STATUSES.includes(q.status as never) ? q.status : undefined,
      type: REG_TYPES.includes(q.type as never) ? q.type : undefined,
    });
  }

  @Get('regulations/:entityId')
  @Authorize({ permissions: ['catalogue.read'] })
  regulation(@Param('entityId') id: string) {
    return this.registry.regulation(entityParam(id, 'Regulation'));
  }

  @Get('commodities')
  @Authorize({ permissions: ['catalogue.read'] })
  commodities() {
    return this.registry.commodities();
  }

  @Get('products')
  @Authorize({ permissions: ['catalogue.read'] })
  products(@Query() q: Record<string, string | undefined>) {
    return this.registry.products({ q: q.q?.slice(0, 100) || undefined, commodityId: optionalUuid(q.commodity), groupId: optionalUuid(q.group) });
  }

  @Get('products/:entityId')
  @Authorize({ permissions: ['catalogue.read'] })
  product(@Param('entityId') id: string) {
    return this.registry.product(entityParam(id, 'Product'));
  }

  @Get('hs-codes')
  @Authorize({ permissions: ['catalogue.read'] })
  hsCodes(@Query('q') q?: string) {
    return this.registry.hsCodes(q?.slice(0, 20));
  }

  @Get('data-versions')
  @Authorize({ permissions: ['changeset.read'] })
  dataVersions(@Query('limit') limit?: string) {
    return this.registry.dataVersions(Math.min(Math.max(Number(limit ?? 50) || 50, 1), 200));
  }
}
