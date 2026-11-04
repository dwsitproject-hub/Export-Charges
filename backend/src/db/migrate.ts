import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';

export function defaultMigrationsDir(): string {
  return process.env.ECR_MIGRATIONS_DIR ?? resolve(process.cwd(), 'migrations');
}

/** Applies pending NNNN_name.sql files in order, each in its own transaction. Returns the names applied. */
export async function migrate(pool: Pool, dir = defaultMigrationsDir()): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.ecr_schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const done = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM public.ecr_schema_migrations')).rows.map((r) => r.name),
  );

  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO public.ecr_schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      // Keep the PostgreSQL error code (SQLSTATE) so the caller can explain it.
      throw Object.assign(new Error(`Migration ${file} failed: ${(err as Error).message}`), { code: (err as { code?: string }).code });
    } finally {
      client.release();
    }
  }
  return applied;
}
