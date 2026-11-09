import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { wibToday } from '../common/fields';
import { DbService } from '../db/db.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CandidateState } from '../registry/candidate';
import { ChangeSetsService } from '../registry/change-sets.service';
import { SourceDocumentsService } from '../registry/source-documents.service';
import { Fetcher, httpFetcher } from '../source-watch/source-watch.service';
import type { RefSeriesData, RefValueData } from '../tariffs/tariff-entities';
import { DraftOutcome, Outcome, Reader, submitForChecker } from './drafts';
import { parseCpoDecree, parseKemendagAgriDecrees, parseKemendagPdfUrl, parseKmkDecree, parseKursPage } from './official-values';
import { pdfText } from './pdf-text';
import { RegulationDraftService } from './regulation-drafts';
import { AUTO_UPDATE_ACTOR, AUTO_UPDATE_USER_ID } from './system-account';

export { AUTO_UPDATE_USER_ID } from './system-account';

export const KEMENDAG_LISTING = 'https://jdih.kemendag.go.id/peraturan?keyword=harga+referensi';
export const KURS_PAGE = 'https://fiskal.kemenkeu.go.id/informasi-publik/kurs-pajak';
/** Newest Kemendag decrees looked at per run (one a month; the rest are older and already handled). */
const DECREES_PER_RUN = 3;

type Kind = 'CPO' | 'FX';

/** What ECR publishes by itself. A value outside goes to a Checker instead: a reading error, or an unusual change. */
const LIMITS: Record<Kind, { min: number; max: number; maxChange: number; label: string }> = {
  CPO: { min: 300, max: 3000, maxChange: 0.3, label: 'CPO reference price' },
  FX: { min: 5000, max: 50000, maxChange: 0.05, label: 'KMK rate' },
};

interface Decree {
  kind: Kind;
  key: string;
  decree: string;
  pageUrl: string;
  pdfUrl: string;
  pdf: Buffer;
  value: string;
  periodFrom: string;
  periodTo: string;
  quote: string;
  /** Where the value is stated in the decree. */
  reference: string;
  /** Read correctly but something needs a person (e.g. BKF's page shows another rate than the decree). */
  concern?: string;
}

/** The decree cannot be read or used at all: Makers are asked to enter it. */
class NeedsReview extends Error {}
/** The value was read but should not be published without a person: it is drafted and sent to a Checker. */
class ForChecker extends Error {
  constructor(message: string, readonly d: Decree, readonly replaces: string | null = null) {
    super(message);
  }
}

const usd = (v: string) => `US$ ${new Decimal(v).toNumber().toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const rupiah = (v: string) => `Rp ${new Decimal(v).toNumber().toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const month = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const range = (from: string, to: string) => `${day(from)} – ${day(to)}`;

/**
 * Keeps the registry in step with the official sources (job `auto-update`, every 3 h):
 * - The monthly CPO reference price (Kepmendag) and the weekly KMK USD/IDR rate are read from each new decree,
 *   checked and published by themselves, and every user is told.
 * - A price or rate that fails a check (unusual change, outside the expected range, a corrected decree, BKF's page
 *   disagreeing with the decree) is drafted as a change set and sent to the Checkers instead.
 * - New regulations the source watch finds (a PMK amending or revoking a registered regulation, or carrying new palm
 *   duty or levy tables) are drafted by RegulationDraftService and sent to the Checkers.
 * Everything is recorded under the "ECR automatic update" account; a Checker's approval publishes a draft and tells
 * every user.
 */
@Injectable()
export class AutoUpdateService {
  private readonly logger = new Logger('AutoUpdate');
  /** Replaced in tests. */
  fetcher: Fetcher = httpFetcher;
  /** Today's business date (WIB); replaced in tests. */
  today: () => string = () => wibToday();

  constructor(
    private readonly db: DbService,
    private readonly sets: ChangeSetsService,
    private readonly documents: SourceDocumentsService,
    private readonly notifications: NotificationsService,
    private readonly regulations: RegulationDraftService,
  ) {}

  async run(_runId: string | null) {
    const unreachable: string[] = [];
    let reads = 0;
    const read: Reader = async (url) => {
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
    const handled: DraftOutcome[] = [];
    const handle = async (key: string, kind: Kind, decree: string, pageUrl: string, load: () => Promise<Decree | null>) => {
      if (await this.isHandled(key)) return;
      try {
        const d = await load();
        if (!d) return; // a page could not be read: tried again next run
        handled.push({ decree, ...(await this.apply(d)) });
      } catch (err) {
        if (err instanceof ForChecker) {
          handled.push({ decree, ...(await this.draftForChecker(err)) });
        } else if (err instanceof NeedsReview) {
          await this.needsReview(key, kind, decree, pageUrl, err.message);
          handled.push({ decree, outcome: 'NEEDS_REVIEW', detail: err.message });
        } else {
          throw err;
        }
      }
    };

    // CPO reference price: the newest Kepmendag decrees on agricultural and forestry products.
    const listing = await read(KEMENDAG_LISTING);
    if (listing) {
      const decrees = parseKemendagAgriDecrees(listing.toString('utf8'));
      if (!decrees.length) unreachable.push(`${KEMENDAG_LISTING} (no decree recognised; the page layout may have changed)`);
      for (const link of decrees.slice(0, DECREES_PER_RUN)) {
        const decree = `Kepmendag ${link.number}/${link.year}`;
        await handle(`CPO|${link.number}|${link.year}`, 'CPO', decree, link.url, async () => {
          const page = await read(link.url);
          if (!page) return null;
          const pdfUrl = parseKemendagPdfUrl(page.toString('utf8'));
          if (!pdfUrl) throw new NeedsReview(`${decree}: no PDF found on its JDIH page.`);
          const pdf = await read(pdfUrl);
          if (!pdf) return null;
          const parsed = parseCpoDecree(await this.text(pdf, decree));
          if (!parsed) throw new NeedsReview(`${decree}: the CPO reference price or its period could not be read from the PDF.`);
          if (parsed.number !== link.number || parsed.year !== link.year) {
            throw new NeedsReview(`${decree}: the PDF is decree ${parsed.number}/${parsed.year}, not the one its page names.`);
          }
          return {
            kind: 'CPO', key: `CPO|${link.number}|${link.year}`, decree, pageUrl: link.url, pdfUrl, pdf, value: parsed.value,
            periodFrom: parsed.periodFrom, periodTo: parsed.periodTo, quote: parsed.quote, reference: `${decree}, Harga Referensi Crude Palm Oil`,
          };
        });
      }
    }

    // KMK rate: BKF's page shows the decree in force; its PDF (the decree itself) must say the same.
    const kursHtml = await read(KURS_PAGE);
    if (kursHtml) {
      const page = parseKursPage(kursHtml.toString('utf8'));
      if (!page) {
        unreachable.push(`${KURS_PAGE} (the KMK, its period or the USD rate was not recognised; the page layout may have changed)`);
      } else {
        const decree = `KMK ${page.number}`;
        await handle(`FX|${page.number}`, 'FX', decree, KURS_PAGE, async () => {
          const pdf = await read(page.pdfUrl);
          if (!pdf) return null;
          const parsed = parseKmkDecree(await this.text(pdf, decree));
          if (!parsed) throw new NeedsReview(`${decree}: the USD rate or its period could not be read from the PDF.`);
          const differs = [
            parsed.number !== page.number && `number ${parsed.number}`,
            parsed.usd !== page.usd && `USD rate ${parsed.usd} (page ${page.usd})`,
            (parsed.periodFrom !== page.periodFrom || parsed.periodTo !== page.periodTo) && `period ${parsed.periodFrom}–${parsed.periodTo} (page ${page.periodFrom}–${page.periodTo})`,
          ].filter(Boolean);
          return {
            kind: 'FX', key: `FX|${page.number}`, decree, pageUrl: page.pdfUrl, pdfUrl: page.pdfUrl, pdf, value: parsed.usd,
            periodFrom: parsed.periodFrom, periodTo: parsed.periodTo, quote: parsed.quote, reference: `${decree}, Diktum KESATU (USD)`,
            concern: differs.length ? `${decree}: the PDF and BKF's page disagree — ${differs.join(', ')}. The draft uses the decree's own figures.` : undefined,
          };
        });
      }
    }

    // New regulations found by the source watch: drafted for a Checker.
    handled.push(...await this.regulations.run(read));

    if (reads > 0 && unreachable.length === reads) {
      throw new Error(`No official source could be read: ${unreachable.slice(0, 3).join('; ')}`);
    }
    if (unreachable.length) this.logger.warn(`auto update could not read ${unreachable.length} of ${reads} pages`);
    return { handled, reads, unreachable };
  }

  private async text(pdf: Buffer, decree: string): Promise<string> {
    try {
      return await pdfText(pdf);
    } catch (err) {
      throw new NeedsReview(`${decree}: the PDF could not be read (${(err as Error).message.slice(0, 120)}).`);
    }
  }

  private async isHandled(key: string) {
    const { rowCount } = await this.db.query('SELECT 1 FROM ecr.auto_update_source WHERE source_key = $1', [key]);
    return Boolean(rowCount);
  }

  private async series(d: Decree) {
    const state = await CandidateState.load(this.db.pool);
    const series = state.ofType<RefSeriesData>('REF_SERIES').find((s) =>
      d.kind === 'CPO' ? s.data.kind === 'REFERENCE_PRICE' && s.data.code === 'CPO' : s.data.kind === 'FX_RATE' && s.data.unit.toUpperCase().startsWith('IDR'));
    if (!series) throw new NeedsReview(`${d.decree}: the registry has no ${d.kind === 'CPO' ? 'CPO reference price' : 'KMK USD/IDR'} series to add it to.`);
    const values = state.ofType<RefValueData>('REF_VALUE').filter((v) => v.data.seriesId === series.id);
    return { seriesId: series.id, values };
  }

  /** Checks the value against what is published, then publishes it — or hands it to a Checker. */
  private async apply(d: Decree): Promise<Omit<DraftOutcome, 'decree'>> {
    const limits = LIMITS[d.kind];
    const { values } = await this.series(d);

    const same = values.find((v) => v.data.periodFrom === d.periodFrom && v.data.periodTo === d.periodTo);
    if (same) {
      if (new Decimal(same.data.value).eq(d.value)) {
        await this.record(d, 'ALREADY_PUBLISHED', null, 'The registry already has this value.');
        return { outcome: 'ALREADY_PUBLISHED' };
      }
      throw new ForChecker(`${d.decree} says ${d.value} for ${range(d.periodFrom, d.periodTo)}, but ${new Decimal(same.data.value).toFixed(2)} is published for that period (a corrected decree?).`, d, same.id);
    }
    if (d.periodTo < this.today()) {
      await this.record(d, 'OLDER_PERIOD', null, 'The period is already over; not published.');
      return { outcome: 'OLDER_PERIOD' };
    }
    const clash = values.find((v) => v.data.periodFrom <= d.periodTo && d.periodFrom <= v.data.periodTo);
    if (clash) throw new NeedsReview(`${d.decree}: ${range(d.periodFrom, d.periodTo)} overlaps the published ${range(clash.data.periodFrom, clash.data.periodTo)}.`);
    if (d.concern) throw new ForChecker(d.concern, d);

    const value = new Decimal(d.value);
    if (value.lt(limits.min) || value.gt(limits.max)) {
      throw new ForChecker(`${d.decree}: ${d.value} is outside the expected ${limits.min}–${limits.max} for the ${limits.label}.`, d);
    }
    const previous = values.map((v) => v.data).filter((v) => v.periodTo < d.periodFrom).sort((a, b) => b.periodTo.localeCompare(a.periodTo))[0];
    if (previous) {
      const change = value.minus(previous.value).abs().div(previous.value);
      if (change.gt(limits.maxChange)) {
        throw new ForChecker(`${d.decree}: ${d.value} differs by ${change.times(100).toFixed(1)} % from the previous ${new Decimal(previous.value).toFixed(2)}, more than the ${limits.maxChange * 100} % ECR publishes by itself.`, d);
      }
    }

    const reason = `Automatic update from ${d.decree}, read from the official PDF.`;
    const setId = await this.prepare(d, 'automatic update',
      `${reason} Checks passed: wording found${d.kind === 'FX' ? ', BKF page and PDF agree' : ''}, value within ${limits.min}–${limits.max}`
      + `${previous ? ` and within ${limits.maxChange * 100} % of the previous ${new Decimal(previous.value).toFixed(2)}` : ''}, no overlap with published periods.`, null);
    try {
      await this.sets.submit(AUTO_UPDATE_ACTOR, setId, { acknowledgeWarnings: true });
    } catch (err) {
      throw new NeedsReview(`${d.decree}: the change set failed its checks (${(err as Error).message}); it is left as a draft: /change-sets/${setId}.`);
    }
    const version = await this.sets.publishDirect(AUTO_UPDATE_ACTOR, setId, reason);
    await this.record(d, 'PUBLISHED', version, null);
    await this.announce(d, previous?.value ?? null, version, setId);
    await this.closeSourceWatch(d, 'DONE', `Published automatically as data version ${version}.`);
    return { outcome: 'PUBLISHED', version };
  }

  /** Stores the PDF and creates the change set with the value (new, or replacing a published one). */
  private async prepare(d: Decree, label: string, justification: string, replaces: string | null): Promise<string> {
    const { seriesId } = await this.series(d);
    const sha256 = createHash('sha256').update(d.pdf).digest('hex');
    const doc = await this.documents.upload(AUTO_UPDATE_ACTOR, { buffer: d.pdf, originalname: `${d.key.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}.pdf`, size: d.pdf.length }, {
      docKind: d.kind === 'CPO' ? 'REF_PRICE_DECREE' : 'FX_DECREE',
      title: d.kind === 'CPO' ? `${d.decree} Harga Referensi (${month(d.periodFrom)})` : `${d.decree} Nilai Kurs ${range(d.periodFrom, d.periodTo)}`,
      docNumber: d.decree.replace(/^\S+ /, ''),
      officialUrl: d.pageUrl,
    }) as unknown as { id: string };
    const what = d.kind === 'CPO' ? `CPO reference price ${month(d.periodFrom)}` : `KMK rate ${range(d.periodFrom, d.periodTo)}`;
    const set = await this.sets.create(AUTO_UPDATE_ACTOR, {
      title: `${what} (${d.decree}) — ${label}`.slice(0, 200),
      justification: `${justification} Official page: ${d.pageUrl}. PDF: ${d.pdfUrl} (SHA-256 ${sha256}). Text read: "${d.quote}".`,
    }) as { id: string };
    const after = { seriesId, periodFrom: d.periodFrom, periodTo: d.periodTo, value: new Decimal(d.value).toFixed(2), sourceDocumentId: doc.id, sourceReference: d.reference };
    await this.sets.saveItem(AUTO_UPDATE_ACTOR, set.id, replaces
      ? { entityType: 'REF_VALUE', operation: 'UPDATE', entityId: replaces, after }
      : { entityType: 'REF_VALUE', operation: 'CREATE', after });
    return set.id;
  }

  /** The value goes to the Checkers as a submitted change set (they are notified by the usual review notice). */
  private async draftForChecker(err: ForChecker): Promise<Omit<DraftOutcome, 'decree'>> {
    const d = err.d;
    const setId = await this.prepare(d, 'drafted by ECR for a Checker',
      `Drafted automatically from ${d.decree}, read from the official PDF, and NOT published because: ${err.message} `
      + 'Please compare the value and its period with the PDF before approving.', err.replaces);
    const failed = await submitForChecker(this.sets, setId);
    if (failed) {
      await this.needsReview(d.key, d.kind, d.decree, d.pageUrl, `${err.message} The draft /change-sets/${setId} failed its checks (${failed}); a Maker must correct and submit it.`);
      return { outcome: 'NEEDS_REVIEW', detail: failed, changeSetId: setId };
    }
    await this.record(d, 'SENT_TO_CHECKER', null, err.message, setId);
    await this.closeSourceWatch(d, 'DONE', `Drafted by ECR as change set ${setId}; waiting for a Checker.`);
    return { outcome: 'SENT_TO_CHECKER', detail: err.message, changeSetId: setId };
  }

  private async record(d: Decree, outcome: Outcome, version: number | null, detail: string | null, changeSetId: string | null = null) {
    await this.db.query(
      `INSERT INTO ecr.auto_update_source (source_key, kind, decree, page_url, pdf_url, outcome, value, period_from, period_to, data_version, change_set_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (source_key) DO NOTHING`,
      [d.key, d.kind, d.decree, d.pageUrl, d.pdfUrl, outcome, d.value, d.periodFrom, d.periodTo, version, changeSetId, detail],
    );
  }

  /** A decree ECR could not even draft: recorded once, and the people who can enter it are told. */
  private async needsReview(key: string, kind: Kind, decree: string, pageUrl: string, detail: string) {
    const { rowCount } = await this.db.query(
      `INSERT INTO ecr.auto_update_source (source_key, kind, decree, page_url, outcome, detail) VALUES ($1, $2, $3, $4, 'NEEDS_REVIEW', $5)
       ON CONFLICT (source_key) DO NOTHING`,
      [key, kind, decree, pageUrl, detail],
    );
    if (!rowCount) return;
    this.logger.warn(detail);
    await this.notifications.alert(this.db.pool, { roles: ['SUPER_ADMIN'], permissions: ['changeset.create', 'changeset.approve'] }, {
      kind: 'AUTO_UPDATE_NEEDS_REVIEW',
      title: `${decree} could not be updated automatically — please enter it`,
      body: `${detail} ECR did not change any data. A Maker should enter the ${LIMITS[kind].label} from the official decree (${pageUrl}) in a change set for a Checker to approve.`,
      link: '/prices',
      dedupeKey: `auto-update-review:${key}`,
    });
  }

  /** Every active user hears of the new value; people following palm products get their usual notice instead. */
  private async announce(d: Decree, previous: string | null, version: number, changeSetId: string) {
    const fmt = d.kind === 'CPO' ? usd : rupiah;
    const title = d.kind === 'CPO'
      ? `CPO reference price for ${month(d.periodFrom)}: ${usd(d.value)}/MT`
      : `KMK rate for ${range(d.periodFrom, d.periodTo)}: ${rupiah(d.value)} per US$`;
    const body = d.kind === 'CPO'
      ? `${d.decree} sets the CPO reference price for ${range(d.periodFrom, d.periodTo)} at ${usd(d.value)} per tonne`
        + `${previous ? ` (previous period: ${fmt(previous)})` : ''}. ECR read the official decree and published it as data version ${version}; `
        + `export duty and levy for palm products use it from ${day(d.periodFrom)}.`
      : `${d.decree} sets ${rupiah(d.value)} per US dollar for ${range(d.periodFrom, d.periodTo)}`
        + `${previous ? ` (previous week: ${fmt(previous)})` : ''}. ECR read the official decree and published it as data version ${version}; `
        + `Rupiah amounts use it from ${day(d.periodFrom)}.`;
    await this.notifications.everyone(this.db.pool, {
      kind: 'AUTO_UPDATE', title, body, link: `/bulletins/${version}`, versionNo: version, changeSetId, dedupeKey: `published:${version}`,
    });
  }

  /** The source watch reported the same decree as new: it is handled now. */
  private async closeSourceWatch(d: Decree, status: 'DONE' | 'DISMISSED', note: string) {
    await this.db.query(
      `UPDATE ecr.source_watch_item SET status = $4, resolved_by = $2, resolved_at = now(), resolution_note = $3
        WHERE status = 'OPEN' AND url = ANY($1::text[])`,
      [[d.pageUrl, d.pdfUrl], AUTO_UPDATE_USER_ID, note, status],
    );
  }
}
