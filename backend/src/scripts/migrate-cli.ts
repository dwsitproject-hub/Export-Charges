import { resolve } from 'node:path';
import { loadDotEnv } from '../config';
import { databaseUrl, describeDatabase } from '../db/database-url';
import { createPool } from '../db/db.service';
import { migrate } from '../db/migrate';

/** What usually causes a failed migration on a new server, by error code (PostgreSQL SQLSTATE or Node). */
const HINTS: Record<string, string> = {
  ECONNREFUSED: 'nothing accepts connections at that host and port — check the database host and port',
  ETIMEDOUT: 'no answer from the database — the network or the RDS whitelist blocks this server',
  ENOTFOUND: 'the host name does not resolve — check the database host and the server\'s DNS',
  EAI_AGAIN: 'the host name does not resolve — check the server\'s DNS',
  '28P01': 'wrong user name or password',
  '28000': 'the database refuses this client — add this server to the RDS whitelist, or set DB_SSLMODE=require if it needs SSL',
  '3D000': 'the database does not exist — create it first',
  '42501': 'the account lacks a permission — for "create extension", create citext and btree_gist with the high-privilege account',
  '58P01': 'an extension is not installed on the server — enable citext and btree_gist for this instance',
  '42883': 'a function is missing — uuidv7() needs PostgreSQL 18',
};

async function main() {
  loadDotEnv(resolve(process.cwd(), '../.env'));
  const url = databaseUrl();
  console.log(`Migrating ${describeDatabase(url)} ...`);
  const pool = createPool(url);
  try {
    const applied = await migrate(pool);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
  } finally {
    await pool.end();
  }
}

main().catch((err: Error & { code?: string; errors?: (Error & { code?: string })[] }) => {
  // A refused or timed-out connection is often an AggregateError with an empty message; its causes are in errors[].
  const causes = [err, ...(err.errors ?? [])];
  const code = causes.map((e) => e.code).find(Boolean);
  const text = causes.map((e) => [e.code, e.message].filter(Boolean).join(' ')).filter(Boolean).join('; ') || String(err);
  console.error(`Migration failed: ${text}`);
  try {
    console.error(`Database: ${describeDatabase(databaseUrl())}`);
  } catch {
    // The settings themselves are the problem; the message above says which.
  }
  if (code && HINTS[code]) console.error(`Likely cause: ${HINTS[code]}.`);
  process.exit(1);
});
