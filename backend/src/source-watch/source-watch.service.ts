import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { ApiError } from '../common/api-error';
import { asObject, Fields } from '../common/fields';
import { DbService, Queryable } from '../db/db.service';
import { NotificationsService } from '../notifications/notifications.service';

export interface FetchResult {
  status: number;
  body: Buffer;
}
export type Fetcher = (url: string) => Promise<FetchResult>;

const USER_AGENT = 'ECR-source-watch/1.0 (Export Charges Registry; daily check of official publishers)';
/** Largest official file the hash re-check downloads. */
const MAX_FILE_BYTES = 40 * 1024 * 1024;

/** Reads a URL with a timeout; the default fetcher (tests replace it). */
export const httpFetcher: Fetcher = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(45_000) });
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_FILE_BYTES) throw new Error(`${url}: ${len} bytes is more than the ${MAX_FILE_BYTES} the watch reads`);
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
};

interface ListingEntry {
  url: string;
  title: string;
  /** Registered-regulation key when the entry names one, e.g. PMK|9|2026. */
  regKey?: string;
}

interface Listing {
  key: string;
  source: string;
  url: string;
  parse: (html: string) => ListingEntry[];
}

const decode = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const regKey = (type: string, number: string | number, year: string | number) => `${type.toUpperCase()}|${Number(number)}|${year}`;

/** "PMK No. 9 Tahun 2026" or a BPK slug "pmk-no-9-tahun-2026" → PMK|9|2026. */
export function regKeyOf(label: string): string | undefined {
  const m = /\b(pmk|permendag|permenperin|kepmendag|pp|perpres|uu)\b[^\d]{0,12}(\d+)[^\d]{1,12}(?:tahun[^\d]{0,3})?((?:19|20)\d{2})\b/i.exec(label);
  return m ? regKey(m[1], m[2], m[3]) : undefined;
}

/** BPK search results (newest first): each regulation once, with its short label. */
export function parseBpkSearch(html: string): ListingEntry[] {
  const out = new Map<string, ListingEntry>();
  for (const m of html.matchAll(/href="(\/Details\/(\d+)\/([^"]+))"[^>]*>([\s\S]{0,400}?)<\/a>/g)) {
    const url = `https://peraturan.bpk.go.id${m[1]}`;
    if (out.has(url)) continue;
    const title = text(m[4]).replace(/\s*•.*$/, '') || m[3].replace(/-/g, ' ');
    out.set(url, { url, title, regKey: regKeyOf(m[3]) });
  }
  return [...out.values()];
}

/** JDIH Kemendag listing: decrees on export reference prices and export benchmark prices. */
export function parseKemendagReferencePrices(html: string): ListingEntry[] {
  const out = new Map<string, ListingEntry>();
  for (const m of html.matchAll(/href="(https:\/\/jdih\.kemendag\.go\.id\/peraturan\/([a-z0-9-]+))"/g)) {
    const slug = m[2];
    if (!/harga-(referensi|patokan-ekspor)/.test(slug) || out.has(m[1])) continue;
    const words = slug.replace(/-republik-indonesia/, '').split('-').join(' ');
    out.set(m[1], { url: m[1], title: words.charAt(0).toUpperCase() + words.slice(1) });
  }
  return [...out.values()];
}

/** Official listings read every day (FR-SRC-04). The first read of each only records what is already there. */
export const LISTINGS: Listing[] = [
  { key: 'bpk:bea-keluar', source: 'peraturan.bpk.go.id', url: 'https://peraturan.bpk.go.id/Search?keywords=bea+keluar&tentang=&nomor=&sort=terbaru', parse: parseBpkSearch },
  { key: 'bpk:dana-perkebunan', source: 'peraturan.bpk.go.id', url: 'https://peraturan.bpk.go.id/Search?keywords=dana+perkebunan&tentang=&nomor=&sort=terbaru', parse: parseBpkSearch },
  { key: 'bpk:kelapa-sawit', source: 'peraturan.bpk.go.id', url: 'https://peraturan.bpk.go.id/Search?keywords=kelapa+sawit&tentang=&nomor=&sort=terbaru', parse: parseBpkSearch },
  { key: 'kemendag:harga-referensi', source: 'jdih.kemendag.go.id', url: 'https://jdih.kemendag.go.id/peraturan?keyword=harga+referensi', parse: parseKemendagReferencePrices },
];

export interface BpkDetails {
  status: string | null;
  relations: { relation: 'AMENDED_BY' | 'REVOKED_BY'; label: string; url: string; regKey?: string }[];
}

/** A BPK regulation page: its Status field and the "Diubah dengan" / "Dicabut dengan" lists. */
export function parseBpkDetails(html: string): BpkDetails {
  const status = /fw-bold">\s*Status\s*<\/div>\s*<div[^>]*>([\s\S]*?)<\/div>/.exec(html);
  const relations: BpkDetails['relations'] = [];
  for (const m of html.matchAll(/>\s*(Diubah dengan|Dicabut dengan|Dicabut sebagian dengan)\s*:\s*<([\s\S]*?)<\/ol>/gi)) {
    const relation = m[1].toLowerCase().startsWith('diubah') ? 'AMENDED_BY' : 'REVOKED_BY';
    for (const a of m[2].matchAll(/href="(\/Details\/\d+\/([^"]+))"[^>]*>([^<]+)<\/a>/g)) {
      relations.push({ relation, label: text(a[3]), url: `https://peraturan.bpk.go.id${a[1]}`, regKey: regKeyOf(a[2]) });
    }
  }
  return { status: status ? text(status[1]) : null, relations };
}

/** Files listed on a JDIH Kemenkeu regulation page. */
export function parseJdihFiles(html: string, pageUrl: string): ListingEntry[] {
  const origin = new URL(pageUrl).origin;
  const out = new Map<string, ListingEntry>();
  for (const m of html.matchAll(/\/api\/download\/([0-9a-f-]{36})\/([^"'\\<>]+)/gi)) {
    const url = `${origin}/api/download/${m[1]}/${encodeURI(decode(m[2]))}`;
    if (!out.has(m[1])) out.set(m[1], { url, title: decode(m[2]) });
  }
  return [...out.values()];
}

interface Finding {
  kind: 'STATUS_CHANGE' | 'NEW_DOCUMENT' | 'NEW_FILE' | 'FILE_CHANGED';
  fingerprint: string;
  title: string;
  detail: string;
  url: string;
  source: string;
  regulationId?: string | null;
  sourceDocumentId?: string | null;
}

interface LiveRegulation {
  entity_id: string;
  reg_type: string;
  number: string;
  year: number;
  status: string;
  official_url: string | null;
  bpk_status_url: string | null;
}

/**
 * PRD FR-SRC-03 / FR-SRC-04: the daily source watch. Reads the official publishers and records what Makers should
 * look at; it never changes registry data (a Maker enters any change in a change set, which a Checker approves).
 */
@Injectable()
export class SourceWatchService {
  private readonly logger = new Logger('SourceWatch');
  /** Replaced in tests. */
  fetcher: Fetcher = httpFetcher;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** One run of the job: every check, then one notice to Makers and Checkers when something new was found. */
  async run(runId: string | null) {
    const regs = (await this.db.query<LiveRegulation>(
      `SELECT entity_id, reg_type, number, year, status, official_url, bpk_status_url FROM ecr.regulation
        WHERE version_to IS NULL AND (valid_to IS NULL OR valid_to > current_date)`,
    )).rows;
    const registered = new Set(regs.map((r) => regKey(r.reg_type, r.number, r.year)));
    const unreachable: string[] = [];
    let reads = 0;
    const read = async (url: string): Promise<Buffer | null> => {
      reads++;
      try {
        const res = await this.fetcher(url);
        if (res.status >= 200 && res.status < 300) return res.body;
        unreachable.push(`${url} (HTTP ${res.status})`);
      } catch (err) {
        unreachable.push(`${url} (${(err as Error).message.slice(0, 120)})`);
      }
      return null;
    };
    const findings: Finding[] = [];

    // FR-SRC-03: status and amendments of each registered regulation at BPK.
    for (const r of regs.filter((x) => x.bpk_status_url)) {
      const body = await read(r.bpk_status_url!);
      if (!body) continue;
      const label = `${r.reg_type} ${r.number}/${r.year}`;
      const d = parseBpkDetails(body.toString('utf8'));
      if (d.status && /tidak berlaku|dicabut/i.test(d.status) && !['REVOKED', 'AMENDED'].includes(r.status)) {
        findings.push({
          kind: 'STATUS_CHANGE', fingerprint: `bpk-status:${r.entity_id}:${d.status.toLowerCase()}`, source: 'peraturan.bpk.go.id',
          title: `${label}: BPK lists it as "${d.status}"`, url: r.bpk_status_url!, regulationId: r.entity_id,
          detail: `ECR has ${label} as ${r.status}. Check the BPK page and, if it no longer applies, end-date its records in a change set.`,
        });
      }
      for (const rel of d.relations) {
        if (rel.regKey && registered.has(rel.regKey)) continue;
        const verb = rel.relation === 'AMENDED_BY' ? 'amended' : 'revoked';
        findings.push({
          kind: 'STATUS_CHANGE', fingerprint: `bpk-rel:${r.entity_id}:${rel.relation}:${rel.url}`, source: 'peraturan.bpk.go.id',
          title: `${label} is ${verb} by ${rel.label}`, url: rel.url, regulationId: r.entity_id,
          detail: `BPK lists ${rel.label} as having ${verb} ${label}; it is not registered in ECR. Register it with its official PDF and update the affected records.`,
        });
      }
    }

    // FR-SRC-04: new entries on the official listings.
    const listingsRead: string[] = [];
    for (const l of LISTINGS) {
      const body = await read(l.url);
      if (!body) continue;
      const entries = l.parse(body.toString('utf8'));
      if (!entries.length) {
        unreachable.push(`${l.url} (no entries recognised; the page layout may have changed)`);
        continue;
      }
      listingsRead.push(l.key);
      for (const e of await this.newEntries(l.key, entries)) {
        if (e.regKey && registered.has(e.regKey)) continue;
        findings.push({
          kind: 'NEW_DOCUMENT', fingerprint: `listing:${e.url}`, source: l.source, title: e.title, url: e.url,
          detail: `New on ${l.source} (${l.key.split(':')[1].replace(/-/g, ' ')}). If it changes export duty, levy or reference prices, register it with its official PDF.`,
        });
      }
    }

    // New files on the JDIH page of a registered regulation (e.g. a corrigendum or a new annex).
    for (const r of regs.filter((x) => x.official_url && /^https:\/\/jdih\.kemenkeu\.go\.id\/dok\//.test(x.official_url))) {
      const page = `${r.official_url!.replace(/\/(files|summary|overview|evaluasi)?\/?$/, '')}/files`;
      const body = await read(page);
      if (!body) continue;
      const files = parseJdihFiles(body.toString('utf8'), page);
      for (const f of await this.newEntries(`jdih-files:${r.entity_id}`, files)) {
        findings.push({
          kind: 'NEW_FILE', fingerprint: `jdih-file:${f.url}`, source: 'jdih.kemenkeu.go.id', regulationId: r.entity_id,
          title: `${r.reg_type} ${r.number}/${r.year}: new file "${f.title}"`, url: f.url,
          detail: 'A file was added to the regulation\'s page on JDIH Kemenkeu. Check whether it is a corrigendum, annex or replacement of the stored PDF.',
        });
      }
    }

    // Stored PDFs with a direct official link: does the official file still match (FR-SRC-02)?
    const docs = (await this.db.query<{ id: string; title: string; official_url: string; sha256: Buffer }>(
      `SELECT id, title, official_url, sha256 FROM ecr.source_document
        WHERE NOT is_secondary AND official_url ~* '\\.pdf($|\\?)'`,
    )).rows;
    let filesChecked = 0;
    for (const d of docs) {
      const body = await read(d.official_url);
      if (!body) continue;
      filesChecked++;
      const now = createHash('sha256').update(body).digest();
      const mismatch = !now.equals(d.sha256);
      await this.db.query('UPDATE ecr.source_document SET last_rechecked_at = now(), recheck_mismatch = $2 WHERE id = $1', [d.id, mismatch]);
      if (mismatch) {
        findings.push({
          kind: 'FILE_CHANGED', fingerprint: `file:${d.id}:${now.toString('hex')}`, source: new URL(d.official_url).hostname,
          title: `The official file of "${d.title}" has changed`, url: d.official_url, sourceDocumentId: d.id,
          detail: 'The file at its official address no longer matches the stored copy. Records citing it cannot be published until a Maker replaces it.',
        });
      }
    }

    const created = await this.record(findings, runId);
    if (created.length) {
      await this.notifications.alert(this.db.pool, { permissions: ['changeset.create', 'changeset.approve'] }, {
        kind: 'SOURCE_WATCH',
        title: `${created.length} new ${created.length === 1 ? 'finding' : 'findings'} on the official sources`,
        body: created.slice(0, 8).map((f) => f.title).join('; ') + (created.length > 8 ? `; and ${created.length - 8} more` : '') + '.',
        link: '/source-watch',
        dedupeKey: `source-watch:${runId ?? created[0].fingerprint}`,
      });
    }
    if (reads > 0 && unreachable.length === reads) {
      throw new Error(`No official source could be read: ${unreachable.slice(0, 3).join('; ')}`);
    }
    if (unreachable.length) this.logger.warn(`source watch could not read ${unreachable.length} of ${reads} pages`);
    return {
      regulations: regs.length, listings: listingsRead.length, filesChecked, reads,
      newFindings: created.length, unreachable,
    };
  }

  /** Entries not seen before on this listing; on its first read, records them all and reports none (the baseline). */
  private async newEntries(listing: string, entries: ListingEntry[]): Promise<ListingEntry[]> {
    const { rows: [{ n }] } = await this.db.query<{ n: string }>('SELECT count(*) AS n FROM ecr.source_watch_seen WHERE listing = $1', [listing]);
    const fresh: ListingEntry[] = [];
    for (const e of entries) {
      const { rowCount } = await this.db.query(
        'INSERT INTO ecr.source_watch_seen (listing, url, title) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [listing, e.url, e.title.slice(0, 1000)],
      );
      if (rowCount && Number(n) > 0) fresh.push(e);
    }
    return fresh;
  }

  private async record(findings: Finding[], runId: string | null): Promise<Finding[]> {
    const created: Finding[] = [];
    for (const f of findings) {
      const { rowCount } = await this.db.query(
        `INSERT INTO ecr.source_watch_item (kind, fingerprint, title, detail, url, source, regulation_entity_id, source_document_id, run_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (fingerprint) DO NOTHING`,
        [f.kind, f.fingerprint, f.title.slice(0, 500), f.detail, f.url, f.source, f.regulationId ?? null, f.sourceDocumentId ?? null, runId],
      );
      if (rowCount) created.push(f);
    }
    return created;
  }

  async list(status: string | undefined) {
    const wanted = ['OPEN', 'DONE', 'DISMISSED'].includes(status ?? '') ? status : null;
    const { rows } = await this.db.query(
      `SELECT i.id, i.kind, i.title, i.detail, i.url, i.source, i.status, i.detected_at AS "detectedAt",
              i.regulation_entity_id AS "regulationId", i.source_document_id AS "sourceDocumentId",
              i.resolved_at AS "resolvedAt", u.full_name AS "resolvedBy", i.resolution_note AS "resolutionNote"
         FROM ecr.source_watch_item i LEFT JOIN ecr.app_user u ON u.id = i.resolved_by
        WHERE $1::text IS NULL OR i.status = $1
        ORDER BY i.status = 'OPEN' DESC, i.detected_at DESC
        LIMIT 500`,
      [wanted],
    );
    const { rows: [last] } = await this.db.query<{ started_at: Date; status: string; details: unknown }>(
      `SELECT started_at, status, details FROM ecr.job_run WHERE job_name = 'source-watch' ORDER BY started_at DESC LIMIT 1`,
    );
    return { items: rows, lastRun: last ? { at: last.started_at, status: last.status, details: last.details } : null };
  }

  /** A Maker records what was done about an item: DONE (entered in a change set) or DISMISSED (not relevant). */
  async resolve(actor: Actor, id: string, body: unknown) {
    const f = new Fields(asObject(body));
    const status = f.oneOf('status', ['DONE', 'DISMISSED'] as const);
    const note = f.optText('note', 1000);
    if (status === 'DISMISSED' && !note) f.fail('note', 'Say why it does not need a change.');
    f.throwIfAny();
    return this.db.tx(async (c: Queryable) => {
      const { rows: [item] } = await c.query<{ status: string; title: string }>(
        'SELECT status, title FROM ecr.source_watch_item WHERE id = $1 FOR UPDATE', [id],
      );
      if (!item) throw new ApiError(404, 'NOT_FOUND', 'Source watch item not found.');
      if (item.status !== 'OPEN') throw new ApiError(409, 'ALREADY_RESOLVED', 'This item was already resolved.');
      await c.query(
        `UPDATE ecr.source_watch_item SET status = $2, resolved_by = $3, resolved_at = now(), resolution_note = $4 WHERE id = $1`,
        [id, status, actor.id, note],
      );
      await this.audit.record(c, {
        action: 'SOURCE_WATCH_RESOLVED', actorKind: 'USER', actorUserId: actor.id, sessionId: actor.sessionId, ip: actor.ip,
        userAgent: actor.userAgent, entityType: 'SOURCE_WATCH_ITEM', entityId: id, before: { status: 'OPEN' }, after: { status, title: item.title },
        reason: note,
      });
      return { id, status };
    });
  }
}
