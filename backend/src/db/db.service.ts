import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow, types } from 'pg';
import { APP_CONFIG, AppConfig } from '../config';

export type Queryable = Pool | PoolClient;

// DATE columns are business dates (WIB) and stay 'YYYY-MM-DD' strings; parsing them into Date would shift them.
types.setTypeParser(types.builtins.DATE, (value) => value);

export function createPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    options: '-c search_path=ecr,public -c timezone=UTC',
    max: 10,
  });
}

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = createPool(config.databaseUrl);
  }

  query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) {
    return this.pool.query<T>(text, params);
  }

  /** Runs fn in one transaction; any error rolls everything back, including audit rows. */
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
