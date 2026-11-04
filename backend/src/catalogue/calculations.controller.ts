import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { actorOf } from '../auth/actor';
import { Authorize, AuthorizedRequest } from '../auth/authorize';
import { isDate, wibToday } from '../common/fields';
import { entityParam } from '../registry/registry.controller';
import { CalculationsService } from './calculations.service';

/**
 * Technical Design §5.1 "Calculator". Body: { lines: [{ productId, quantityMt }], pebDate?, paymentDate?,
 * refPriceOverride?, versionNo? }. Preview is not stored; POST /calculations saves a replayable result.
 */
@Controller('calculations')
export class CalculationsController {
  constructor(private readonly calcs: CalculationsService) {}

  @Post('preview')
  @HttpCode(200)
  @Authorize({ permissions: ['calc.run'] })
  preview(@Body() body: unknown) {
    return this.calcs.preview(body);
  }

  @Post()
  @Authorize({ permissions: ['calc.run'] })
  save(@Body() body: unknown, @Req() req: AuthorizedRequest) {
    return this.calcs.save(actorOf(req), body);
  }

  @Get()
  @Authorize({ permissions: ['calc.run'] })
  list(@Req() req: AuthorizedRequest) {
    return this.calcs.list(actorOf(req));
  }

  /** Products to choose from, as of a date. Declared before :id. */
  @Get('products')
  @Authorize({ permissions: ['calc.run'] })
  products(@Query('date') date?: string) {
    return this.calcs.products(date && isDate(date) ? date : wibToday());
  }

  @Get(':id')
  @Authorize({ permissions: ['calc.run'] })
  get(@Param('id') id: string, @Req() req: AuthorizedRequest) {
    return this.calcs.get(actorOf(req), entityParam(id, 'Calculation'));
  }

  @Get(':id/verify')
  @Authorize({ permissions: ['calc.run'] })
  verify(@Param('id') id: string, @Req() req: AuthorizedRequest) {
    return this.calcs.verify(actorOf(req), entityParam(id, 'Calculation'));
  }
}
