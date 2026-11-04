import { resolve } from 'node:path';
import { loadDotEnv } from '../config';
import { createPool } from '../db/db.service';
import { migrate } from '../db/migrate';

async function main() {
  loadDotEnv(resolve(process.cwd(), '../.env'));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = createPool(url);
  try {
    const applied = await migrate(pool);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
