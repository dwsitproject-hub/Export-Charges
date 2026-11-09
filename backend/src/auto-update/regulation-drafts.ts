import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { ApiError } from '../common/api-error';
import { DbService } from '../db/db.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CandidateState } from '../registry/candidate';
import { ChangeSetsService } from '../registry/change-sets.service';
import type { ProductData, RegulationData } from '../registry/entities';
import { SourceDocumentsService } from '../registry/source-documents.service';
import type { Band, BandTableData, RefSeriesData, ScheduleData, ScheduleLineData } from '../tariffs/tariff-entities';
import { parseJdihFiles } from '../source-watch/source-watch.service';
import { DraftOutcome, Reader, submitForChecker } from './drafts';
import { pdfText } from './pdf-text';
import {
  BpkRegulation, DutyTable, effectiveDate, LevyTable, parseBpkRegulation, parsePalmDutyTable, parsePalmLevyTable, parseRegulationText,
  RegulationRef, TableBand,
} from './regulation-text';
import { AUTO_UPDATE_ACTOR, AUTO_UPDATE_USER_ID } from './system-account';

/** BPK regulation pages the source watch reported, looked at per run. */
const PAGES_PER_RUN = 10;
const ISSUERS: Record<string, string> = { PMK: 'Kementerian Keuangan', PERMENDAG: 'Kementerian Perdagangan', PERMENPERIN: 'Kementerian Perindustrian' };

type Item<T> = { id: string; data: T };
const key = (r: { regType: string; number: string; year: number }) => `${r.regType.toUpperCase()}|${Number(r.number)}|${r.year}`;
const dayBefore = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const num = (v: string | number | null | undefined) => (v === null || v === undefined ? null : new Decimal(v));
const sameNum = (a: string | number | null | undefined, b: string | number | null | undefined) => {
  const x = num(a);
  const y = num(b);
  return x === null || y === null ? x === y : x.eq(y);
};
const bareHs = (code: string) => code.replace(/^ex\s+/i, '');
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

class NeedsReview extends Error {}

/**
 * Semi-automatic regulations. For each BPK regulation page the source watch reported (a new PMK on its listings, or
 * the regulation BPK says amends or revokes one ECR holds), ECR reads BPK's details and the regulation's PDF and, when
 * it touches ECR's data, drafts the whole change for a Checker:
 * - the new regulation, with its PDF as source, its start date (from its own text and BPK's promulgation date) and
 *   its AMENDS / REVOKES relations to the regulations ECR holds;
 * - a revoked regulation set to REVOKED from that date;
 * - when it carries a palm export duty table (17 CPO price bands) or plantation fund levy table that differs from the
 *   one in force: a new schedule with every line, each linked to the products of the line it replaces, and the old
 *   schedule and lines ended the day before.
 * The draft is submitted, which notifies the Checkers; the justification lists what was read and what to compare.
 * Nothing is published until a Checker approves. A page ECR cannot read is left to the Makers (alerted once); a
 * regulation that touches nothing ECR holds is dismissed from the source watch with a note.
 */
@Injectable()
export class RegulationDraftService {
  private readonly logger = new Logger('RegulationDrafts');
  /** The PDF's text; replaced in tests. */
  readPdf: (pdf: Buffer) => Promise<string> = pdfText;

  constructor(
    private readonly db: DbService,
    private readonly sets: ChangeSetsService,
    private readonly documents: SourceDocumentsService,
    private readonly notifications: NotificationsService,
  ) {}

  async run(read: Reader): Promise<DraftOutcome[]> {
    const { rows: pages } = await this.db.query<{ url: string; title: string }>(
      `SELECT i.url, min(i.title) AS title FROM ecr.source_watch_item i
        WHERE i.status = 'OPEN' AND i.url LIKE 'https://peraturan.bpk.go.id/Details/%'
          AND NOT EXISTS (SELECT 1 FROM ecr.regulation r WHERE r.version_to IS NULL AND r.bpk_status_url = i.url)
          AND NOT EXISTS (SELECT 1 FROM ecr.auto_update_source a WHERE a.source_key = 'REG|' || i.url)
        GROUP BY i.url ORDER BY min(i.detected_at) LIMIT $1`,
      [PAGES_PER_RUN],
    );
    const out: DraftOutcome[] = [];
    for (const p of pages) {
      try {
        const r = await this.draft(p.url, read);
        if (r) out.push(r);
      } catch (err) {
        if (!(err instanceof NeedsReview)) throw err;
        await this.needsReview(p.url, p.title, err.message);
        out.push({ decree: p.title, outcome: 'NEEDS_REVIEW', detail: err.message });
      }
    }
    return out;
  }

  private async draft(url: string, read: Reader): Promise<DraftOutcome | null> {
    const page = await read(url);
    if (!page) return null;
    let meta = parseBpkRegulation(page.toString('utf8'));
    if (!meta) throw new NeedsReview('The BPK page did not show the regulation\'s details (Nomor, Tahun, Judul).');
    const label = `${meta.regType} ${meta.number}/${meta.year}`;

    const state = await CandidateState.load(this.db.pool);
    const regs = state.ofType<RegulationData>('REGULATION');
    const byKey = new Map(regs.map((r) => [key(r.data), r]));
    if (byKey.has(key(meta))) {
      await this.record(url, label, 'NOT_RELEVANT', null, `${label} is already registered.`);
      await this.closeItems(url, 'DONE', `${label} is already registered in ECR.`);
      return { decree: label, outcome: 'NOT_RELEVANT', detail: 'already registered' };
    }
    // The PDF: for a PMK first the Ministry of Finance's own copy on JDIH Kemenkeu, then BPK's — the first whose own
    // text is this regulation (BPK's page for PMK 9/2026, for one, offers PMK 8/2026's file).
    const jdihPage = meta.regType === 'PMK' ? `https://jdih.kemenkeu.go.id/dok/pmk-${Number(meta.number)}-tahun-${meta.year}` : null;
    const candidates = [...(jdihPage ? await this.jdihPdfs(jdihPage, read) : []), meta.pdfUrl].filter((u): u is string => Boolean(u));
    if (!candidates.length) throw new NeedsReview(`${label}: no PDF of it is offered by BPK or JDIH.`);
    const problems: string[] = [];
    let found: { pdf: Buffer; text: string; pdfUrl: string; reg: NonNullable<ReturnType<typeof parseRegulationText>> } | null = null;
    for (const pdfUrl of candidates) {
      const pdf = await read(pdfUrl);
      if (!pdf) return null; // not readable now: tried again next run
      let text: string;
      try {
        text = await this.readPdf(pdf);
      } catch (err) {
        problems.push(`${pdfUrl} could not be read (${(err as Error).message.slice(0, 80)})`);
        continue;
      }
      const reg = parseRegulationText(text);
      if (!reg) { problems.push(`${pdfUrl}: its opening (type, number, year, subject) could not be read`); continue; }
      if (key(reg) !== key(meta)) { problems.push(`${pdfUrl} is ${reg.regType} ${reg.number}/${reg.year}, not ${label}`); continue; }
      found = { pdf, text, pdfUrl, reg };
      break;
    }
    if (!found) throw new NeedsReview(`${label}: no PDF of it could be used — ${problems.join('; ')}.`);
    const { pdf, text, reg } = found;
    meta = { ...meta, pdfUrl: found.pdfUrl };
    // Where the regulation is officially published: the issuer's page when its copy was used, else BPK's.
    const officialPage = jdihPage && found.pdfUrl.startsWith('https://jdih.kemenkeu.go.id/') ? jdihPage : url;

    const held = (refs: RegulationRef[]): Item<RegulationData>[] => refs.flatMap((r) => { const h = byKey.get(key(r)); return h ? [h] : []; });
    const amends = held(reg.amends);
    const revokes = held(reg.revokes);
    const duty = parsePalmDutyTable(text);
    const levy = parsePalmLevyTable(text);
    const current = { duty: this.inForce(state, 'BK'), levy: this.inForce(state, 'PE') };
    const dutyChanged = duty && current.duty && !this.sameDuty(state, duty, current.duty);
    const levyChanged = levy && current.levy && !this.sameLevy(levy, current.levy);

    if (!amends.length && !revokes.length && !dutyChanged && !levyChanged) {
      const note = `Read by ECR: ${label} changes no regulation ECR holds and no palm duty or levy table.`;
      await this.record(url, label, 'NOT_RELEVANT', null, note);
      await this.closeItems(url, 'DISMISSED', note);
      return { decree: label, outcome: 'NOT_RELEVANT' };
    }
    const effectiveOn = effectiveDate(reg, meta.promulgatedOn) ?? meta.effectiveOn;
    if (!effectiveOn) throw new NeedsReview(`${label}: its start date could not be read.`);
    try {
      return await this.prepare(url, meta, label, effectiveOn, pdf, { amends, revokes, duty: dutyChanged ? duty : null, levy: levyChanged ? levy : null, officialPage, skipped: problems }, state, current);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      const fields = ((err.details?.fields ?? []) as { field: string; message: string }[]).map((f) => `${f.field}: ${f.message}`).join('; ');
      throw new NeedsReview(`${label}: ECR could not draft it (${err.message}${fields ? ` ${fields}` : ''}).`);
    }
  }

  /** PDFs on the regulation's JDIH Kemenkeu page (BPK sometimes links another regulation's file). */
  private async jdihPdfs(jdihPage: string, read: Reader): Promise<string[]> {
    const page = `${jdihPage}/files`;
    const html = await read(page);
    return html ? parseJdihFiles(html.toString('utf8'), page).map((f) => f.url).filter((u) => /\.pdf$/i.test(u)) : [];
  }

  /** The palm schedule of this charge in force today (or starting latest), with its open lines. */
  private inForce(state: CandidateState, chargeType: 'BK' | 'PE') {
    const schedules = state.ofType<ScheduleData>('SCHEDULE').filter((s) => s.data.chargeType === chargeType && !s.data.validTo)
      .sort((a, b) => (b.data.validFrom ?? '').localeCompare(a.data.validFrom ?? ''));
    const schedule = schedules[0];
    if (!schedule) return null;
    const lines = state.ofType<ScheduleLineData>('SCHEDULE_LINE').filter((l) => l.data.scheduleId === schedule.id && !l.data.validTo)
      .sort((a, b) => Number(a.data.itemNo) - Number(b.data.itemNo));
    return { schedule, lines };
  }

  private bandsOf(state: CandidateState, bandTableId: string | null): Band[] | null {
    return state.ofType<BandTableData>('BAND_TABLE').find((t) => t.id === bandTableId)?.data.bands ?? null;
  }

  private sameBands(a: Band[] | null, b: TableBand[]) {
    return Boolean(a) && a!.length === b.length && a!.every((x, i) => sameNum(x.lowerExclusive, b[i].lowerExclusive) && sameNum(x.upperInclusive, b[i].upperInclusive));
  }

  private sameDuty(state: CandidateState, t: DutyTable, cur: NonNullable<ReturnType<RegulationDraftService['inForce']>>) {
    if (!this.sameBands(this.bandsOf(state, cur.lines[0]?.data.bandTableId ?? null), t.bands) || cur.lines.length !== t.lines.length) return false;
    return t.lines.every((l, i) => {
      const c = cur.lines[i].data;
      return c.itemNo === String(l.no) && c.bandValues.length === l.amounts.length && c.bandValues.every((v, j) => sameNum(v, l.amounts[j]));
    });
  }

  private sameLevy(t: LevyTable, cur: NonNullable<ReturnType<RegulationDraftService['inForce']>>) {
    if (cur.lines.length !== t.lines.length) return false;
    return t.lines.every((l, i) => {
      const c = cur.lines[i].data;
      return c.itemNo === String(l.no) && c.basisType === l.basis
        && (l.basis === 'PCT_OF_REF_PRICE' ? sameNum(c.pct, l.value) : l.basis === 'FIXED_USD_PER_MT' ? sameNum(c.usdPerMt, l.value) : true);
    });
  }

  /** Products of the line a new line replaces: same number with matching HS codes, else the same description. */
  private productsFor(state: CandidateState, line: { no: number; uraian: string; hs: string[] }, current: Item<ScheduleLineData>[]) {
    const products = new Map(state.ofType<ProductData>('PRODUCT').map((p) => [p.id, p.data]));
    const hs = new Set(line.hs.map(bareHs));
    const fits = (c: Item<ScheduleLineData>) => c.data.productIds.length > 0
      && c.data.productIds.every((id) => (products.get(id)?.hsCodes ?? []).some((h) => hs.has(bareHs(h.code))));
    const sameNo = current.find((c) => c.data.itemNo === String(line.no));
    if (sameNo && fits(sameNo)) return { ids: sameNo.data.productIds, uraian: words(sameNo.data.uraian) === words(line.uraian) ? sameNo.data.uraian : null };
    const sameText = current.find((c) => words(c.data.uraian) === words(line.uraian) && fits(c));
    if (sameText) return { ids: sameText.data.productIds, uraian: sameText.data.uraian };
    return { ids: [] as string[], uraian: null };
  }

  private async prepare(
    url: string, meta: BpkRegulation, label: string, effectiveOn: string, pdf: Buffer,
    found: { amends: Item<RegulationData>[]; revokes: Item<RegulationData>[]; duty: DutyTable | null; levy: LevyTable | null; officialPage: string; skipped: string[] },
    state: CandidateState, current: { duty: ReturnType<RegulationDraftService['inForce']>; levy: ReturnType<RegulationDraftService['inForce']> },
  ): Promise<DraftOutcome> {
    const doc = await this.documents.upload(AUTO_UPDATE_ACTOR, { buffer: pdf, originalname: `${label.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}.pdf`, size: pdf.length }, {
      docKind: 'REGULATION', title: `Salinan ${label}`, docNumber: `${meta.number} TAHUN ${meta.year}`, docDate: meta.enactedOn, officialUrl: found.officialPage,
    }) as unknown as { id: string };

    const notes: string[] = [];
    const subject = meta.title.replace(/^.*?\btentang\b\s*/i, '');
    const set = await this.sets.create(AUTO_UPDATE_ACTOR, {
      title: `${label}: ${subject}`.slice(0, 160) + ' — drafted by ECR for a Checker',
      justification: `Drafted automatically by ECR from ${label}; the details follow when the draft is complete.`,
    }) as { id: string };
    let known = new Set<string>();
    const add = async (entityType: string, operation: 'CREATE' | 'UPDATE' | 'END_DATE', body: Record<string, unknown>) => {
      const updated = await this.sets.saveItem(AUTO_UPDATE_ACTOR, set.id, { entityType, operation, ...body }) as { items: { id: string; entityId: string }[] };
      const created = updated.items.find((i) => !known.has(i.id));
      known = new Set(updated.items.map((i) => i.id));
      return created?.entityId ?? '';
    };

    const regulationId = await add('REGULATION', 'CREATE', {
      after: {
        regType: meta.regType, number: meta.number, year: meta.year, titleId: subject.slice(0, 1000) || meta.title, titleEn: null,
        issuer: ISSUERS[meta.regType] ?? meta.issuer ?? 'Pemerintah Republik Indonesia', status: 'IN_FORCE',
        promulgatedOn: meta.promulgatedOn, effectiveOn, endsOn: null, officialUrl: found.officialPage, bpkStatusUrl: url,
        relations: [...found.amends.map((r) => ({ relation: 'AMENDS', regulationId: r.id })), ...found.revokes.map((r) => ({ relation: 'REVOKES', regulationId: r.id }))],
        documents: [{ sourceDocumentId: doc.id, role: 'MAIN' }],
      },
    });
    notes.push(`Registers ${label} (${meta.title}), in force from ${effectiveOn}${meta.promulgatedOn ? ` (promulgated ${meta.promulgatedOn})` : ''}.`);
    if (found.skipped.length) notes.push(`Not used: ${found.skipped.join('; ')}.`);
    for (const r of found.amends) notes.push(`It amends ${r.data.regType} ${r.data.number}/${r.data.year}.`);
    for (const r of found.revokes) {
      await add('REGULATION', 'UPDATE', { entityId: r.id, after: { ...r.data, status: 'REVOKED', endsOn: dayBefore(effectiveOn) } });
      notes.push(`It revokes ${r.data.regType} ${r.data.number}/${r.data.year}: set to REVOKED, last day ${dayBefore(effectiveOn)}.`);
    }

    const cpo = state.ofType<RefSeriesData>('REF_SERIES').find((s) => s.data.kind === 'REFERENCE_PRICE' && s.data.code === 'CPO')?.id ?? null;
    const unlinked: string[] = [];
    const replace = async (chargeType: 'BK' | 'PE', annexLabel: string, cur: NonNullable<ReturnType<RegulationDraftService['inForce']>>,
      lines: { kelompok: string; no: number; uraian: string; hs: string[]; after: Record<string, unknown> }[]) => {
      const scheduleId = await add('SCHEDULE', 'CREATE', {
        after: { regulationId, chargeType, annexLabel, commodityId: cur.schedule.data.commodityId, validFrom: effectiveOn, validTo: null },
      });
      for (const l of lines) {
        const p = this.productsFor(state, l, cur.lines);
        if (!p.ids.length) unlinked.push(`${chargeType} line ${l.no} (${l.uraian.slice(0, 60)}; HS ${l.hs.join(', ')})`);
        await add('SCHEDULE_LINE', 'CREATE', {
          after: { scheduleId, kelompok: l.kelompok, itemNo: String(l.no), uraian: p.uraian ?? l.uraian, productIds: p.ids, validFrom: effectiveOn, validTo: null, ...l.after },
        });
      }
      const last = dayBefore(effectiveOn);
      if ((cur.schedule.data.validFrom ?? '') <= last) {
        for (const l of cur.lines) await add('SCHEDULE_LINE', 'END_DATE', { entityId: l.id, validTo: last });
        await add('SCHEDULE', 'END_DATE', { entityId: cur.schedule.id, validTo: last });
      }
    };

    if (found.duty && current.duty) {
      const duty = found.duty;
      const bandsNow = this.bandsOf(state, current.duty.lines[0]?.data.bandTableId ?? null);
      let bandTableId = current.duty.lines[0]?.data.bandTableId ?? null;
      if (!this.sameBands(bandsNow, duty.bands)) {
        bandTableId = await add('BAND_TABLE', 'CREATE', {
          after: { code: `CPO-${duty.bands.length}-${meta.regType}${meta.number}-${meta.year}`.slice(0, 40), name: `${duty.bands.length} CPO reference price bands (${label} ${duty.annexLabel})`, refSeriesId: cpo, bands: duty.bands, validFrom: null, validTo: null },
        });
        notes.push(`New CPO price bands (${duty.bands.map((b) => b.label).join(', ')}).`);
      }
      await replace('BK', duty.annexLabel, current.duty, duty.lines.map((l) => ({
        ...l, after: { basisType: 'BAND_USD_PER_MT', pct: null, usdPerMt: null, bandTableId, refSeriesId: cpo, bandValues: l.amounts.map(String) },
      })));
      notes.push(`Export duty: ${label} ${duty.annexLabel} replaces the table of the schedule in force (${duty.lines.length} lines × ${duty.bands.length} bands) from ${effectiveOn}.`);
    }
    if (found.levy && current.levy) {
      const levy = found.levy;
      await replace('PE', levy.annexLabel, current.levy, levy.lines.map((l) => ({
        ...l, after: {
          basisType: l.basis, pct: l.basis === 'PCT_OF_REF_PRICE' ? l.value : null, usdPerMt: l.basis === 'FIXED_USD_PER_MT' ? l.value : null,
          bandTableId: null, refSeriesId: l.basis === 'PCT_OF_REF_PRICE' ? cpo : null, bandValues: [],
        },
      })));
      notes.push(`Export levy: ${label} ${levy.annexLabel} replaces the levy table in force (${levy.lines.length} lines) from ${effectiveOn}.`);
    }
    if (unlinked.length) notes.push(`NOT linked to products (no line with the same number and HS codes before): ${unlinked.join('; ')}. Link them before approving.`);

    await this.db.query('UPDATE ecr.change_set SET justification = $2 WHERE id = $1', [set.id,
      `Drafted automatically by ECR from ${label}, read from its official PDF (${meta.pdfUrl}) and BPK page (${url}). NOT published: please compare `
      + `every value with the PDF before approving. ${notes.join(' ')}`.slice(0, 8000)]);
    const failed = await submitForChecker(this.sets, set.id);
    if (failed) {
      throw new NeedsReview(`${label}: the drafted change set /change-sets/${set.id} failed its checks (${failed}); a Maker must correct and submit it.`);
    }
    await this.record(url, label, 'SENT_TO_CHECKER', set.id, notes.join(' '));
    await this.closeItems(url, 'DONE', `Drafted by ECR as change set ${set.id}; waiting for a Checker.`);
    this.logger.log(`${label}: drafted change set ${set.id} for a Checker`);
    return { decree: label, outcome: 'SENT_TO_CHECKER', changeSetId: set.id, detail: notes.join(' ') };
  }

  private async record(url: string, decree: string, outcome: 'SENT_TO_CHECKER' | 'NOT_RELEVANT' | 'NEEDS_REVIEW', changeSetId: string | null, detail: string) {
    await this.db.query(
      `INSERT INTO ecr.auto_update_source (source_key, kind, decree, page_url, outcome, change_set_id, detail)
       VALUES ($1, 'REGULATION', $2, $3, $4, $5, $6) ON CONFLICT (source_key) DO NOTHING`,
      [`REG|${url}`, decree, url, outcome, changeSetId, detail],
    );
  }

  private async needsReview(url: string, title: string, detail: string) {
    await this.record(url, title, 'NEEDS_REVIEW', null, detail);
    this.logger.warn(detail);
    await this.notifications.alert(this.db.pool, { roles: ['SUPER_ADMIN'], permissions: ['changeset.create', 'changeset.approve'] }, {
      kind: 'AUTO_UPDATE_NEEDS_REVIEW',
      title: `${title.slice(0, 200)} could not be drafted automatically`,
      body: `${detail} ECR did not change any data. A Maker should read the regulation (${url}) and enter what it changes in a change set.`,
      link: '/source-watch',
      dedupeKey: `auto-update-review:REG|${url}`,
    });
  }

  private async closeItems(url: string, status: 'DONE' | 'DISMISSED', note: string) {
    await this.db.query(
      `UPDATE ecr.source_watch_item SET status = $2, resolved_by = $3, resolved_at = now(), resolution_note = $4 WHERE status = 'OPEN' AND url = $1`,
      [url, status, AUTO_UPDATE_USER_ID, note],
    );
  }
}
