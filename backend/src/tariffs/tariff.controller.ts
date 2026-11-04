import { Controller, Get, Param, Query } from '@nestjs/common';
import { Authorize } from '../auth/authorize';
import { isDate, wibToday } from '../common/fields';
import { entityParam } from '../registry/registry.controller';
import { CHARGE_TYPES } from './tariff-entities';
import { TariffReadService } from './tariff-read.service';

const dateOr = (d: string | undefined) => (d && isDate(d) ? d : wibToday());

/** Technical Design §5.1 "Reference data" and schedules: published data only. Dates are WIB business dates. */
@Controller()
export class TariffController {
  constructor(private readonly tariffs: TariffReadService) {}

  @Get('ref-series')
  @Authorize({ permissions: ['catalogue.read'] })
  series(@Query('date') date?: string) {
    return this.tariffs.series(dateOr(date));
  }

  @Get('ref-series/:entityId')
  @Authorize({ permissions: ['catalogue.read'] })
  values(@Param('entityId') id: string) {
    return this.tariffs.values(entityParam(id, 'Series'));
  }

  @Get('band-tables')
  @Authorize({ permissions: ['catalogue.read'] })
  bandTables() {
    return this.tariffs.bandTables();
  }

  @Get('schedules')
  @Authorize({ permissions: ['catalogue.read'] })
  schedules(@Query('chargeType') chargeType?: string) {
    return this.tariffs.schedules(CHARGE_TYPES.includes(chargeType as never) ? chargeType : undefined);
  }

  @Get('schedules/:entityId')
  @Authorize({ permissions: ['catalogue.read'] })
  schedule(@Param('entityId') id: string) {
    return this.tariffs.schedule(entityParam(id, 'Schedule'));
  }

  /** Duty and levy per tonne for one product, as of a date (default today). */
  @Get('products/:entityId/charges')
  @Authorize({ permissions: ['catalogue.read'] })
  charges(@Param('entityId') id: string, @Query('date') date?: string) {
    return this.tariffs.productCharges(entityParam(id, 'Product'), dateOr(date));
  }
}
