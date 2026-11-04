import { Controller, Get } from '@nestjs/common';
import { ApiError } from './common/api-error';
import { DbService } from './db/db.service';

@Controller()
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    try {
      await this.db.query('SELECT 1');
    } catch {
      throw new ApiError(503, 'NOT_READY', 'Database unavailable.');
    }
    return { status: 'ready' };
  }
}
