import type { Queryable } from '../db/db.service';

export interface Publisher {
  id: string;
  name: string;
  domain: string;
  isOfficial: boolean;
}

/** Host of an http(s) URL, lower-case; null when the text is not such a URL. */
export function urlHost(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The allow-listed publisher whose domain is the URL's host or a parent of it (PRD 13.1, BR-SRC-01). */
export async function publisherForUrl(q: Queryable, url: string): Promise<Publisher | null> {
  const host = urlHost(url);
  if (!host) return null;
  const { rows } = await q.query<Publisher>(
    `SELECT id, name, domain, is_official AS "isOfficial"
       FROM ecr.source_publisher
      WHERE $1 = domain OR $1 LIKE '%.' || domain
      ORDER BY length(domain) DESC
      LIMIT 1`,
    [host],
  );
  return rows[0] ?? null;
}
