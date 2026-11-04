import { resolve } from 'node:path';
import { loadDotEnv } from '../config';
import { createPool } from '../db/db.service';
import { migrate } from '../db/migrate';

/** What usually causes a failed migration on a new server, by error code (PostgreSQL SQLSTATE or Node). */
const HINTS: Record<string, string> = {
  ECONNREFUSED: 'nothing accepts connections at that host and port — check the host and port in DATABASE_URL',
  ETIMEDOUT: 'no answer from the database — the network or the RDS whitelist blocks this server',
  ENOTFOUND: 'the host name does not resolve — check the host in DATABASE_URL and the server\'s DNS',
  EAI_AGAIN: 'the host name does not resolve — check the server\'s DNS',
  '28P01': 'wrong user name or password (URL-encode special characters in the password)',
  '28000': 'the database refuses this client — add this server to the RDS whitelist, or add ?sslmode=require if it needs SSL',
  '3D000': 'the database does not exist — create it first',
  '42501': 'the account lacks a permission — for "create extension", create citext and btree_gist with the high-privilege account',
  '58P01': 'an extension is not installed on the server — enable citext and btree_gist for this instance',
  '42883': 'a function is missing — uuidv7() needs PostgreSQL 18',
};

/** Host, port, database and user of the connection string, never the password. */
function target(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}/${u.pathname.slice(1)} as ${decodeURIComponent(u.username)}`;
  } catch {
    return 'the database (DATABASE_URL is not a valid URL)';
  }
}

async function main() {
  loadDotEnv(resolve(process.cwd(), '../.env'));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  console.log(`Migrating ${target(url)} ...`);
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
  if (process.env.DATABASE_URL) console.error(`Database: ${target(process.env.DATABASE_URL)}`);
  if (code && HINTS[code]) console.error(`Likely cause: ${HINTS[code]}.`);
  process.exit(1);
});
