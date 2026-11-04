/**
 * The PostgreSQL connection string: DATABASE_URL, or one built from DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
 * and DB_SSLMODE. The separate fields take a password exactly as issued (ApsaraDB passwords often contain characters
 * such as / ? # @ % that a URL needs encoded); DATABASE_URL must have them encoded already.
 */
export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL?.trim();
  if (url) {
    if (!URL.canParse(url)) {
      throw new Error('DATABASE_URL is not a valid URL: URL-encode special characters in the password (/ ? # @ % : and spaces), '
        + 'or set DB_HOST, DB_PORT, DB_NAME, DB_USER and DB_PASSWORD instead');
    }
    return url;
  }
  const host = env.DB_HOST?.trim();
  if (!host) throw new Error('Set DATABASE_URL, or DB_HOST, DB_PORT, DB_NAME, DB_USER and DB_PASSWORD');
  const missing = ['DB_NAME', 'DB_USER', 'DB_PASSWORD'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`${missing.join(', ')} not set (needed with DB_HOST)`);
  const sslmode = env.DB_SSLMODE?.trim();
  return `postgres://${encodeURIComponent(env.DB_USER!.trim())}:${encodeURIComponent(env.DB_PASSWORD!)}@${host}:${env.DB_PORT?.trim() || '5432'}`
    + `/${encodeURIComponent(env.DB_NAME!.trim())}${sslmode ? `?sslmode=${encodeURIComponent(sslmode)}` : ''}`;
}

/** Host, port, database and user of a connection string, for messages; never the password. */
export function describeDatabase(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}/${decodeURIComponent(u.pathname.slice(1))} as ${decodeURIComponent(u.username)}`;
  } catch {
    return 'the database';
  }
}
