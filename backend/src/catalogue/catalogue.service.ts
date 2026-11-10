import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { DbService } from '../db/db.service';
import type { CandidateState } from '../registry/candidate';
import { CommodityData, GroupData, ProductData, regulationLabel, RegulationData } from '../registry/entities';
import { Charge, chargeFor, selectBand, valueOn } from '../tariffs/charge-engine';
import type { BandTableData, RefSeriesData, ScheduleData, ScheduleLineData } from '../tariffs/tariff-entities';
import { dataView } from './data-state';

/** KPI categories; every product is in exactly one (US-46-P1, US-46-N1). */
export const CATEGORIES = ['BOTH', 'BK_ONLY', 'PE_ONLY', 'LISTED_ZERO', 'NOT_LISTED'] as const;
export type Category = (typeof CATEGORIES)[number];
export const SORTS = ['default', 'name', 'hs', 'bk', 'pe', 'total'] as const;
export const MAX_QUERY = 200;

export interface CatalogueQuery {
  date: string;
  versionNo?: number;
  q?: string;
  commodity: string[];
  group: string[];
  category: string[];
  regulation: string[];
  sharedHs: boolean;
  sort: (typeof SORTS)[number];
  dir: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

interface Row {
  productId: string;
  commodityId: string | null;
  commodityCode: string | null;
  groupId: string | null;
  group: string | null;
  groupOrdinal: number;
  itemNoAsPrinted: string | null;
  nameId: string;
  nameEn: string | null;
  hsCodes: { code: string; isEx: boolean }[];
  keySpec: string | null;
  bk: Charge;
  pe: Charge;
  /** BK + PE per tonne when both are known; otherwise why not (US-40-N1). */
  totalUsdPerMt: string | null;
  totalNote: string | null;
  category: Category;
  sharedHs: boolean;
  draftClassification: boolean;
  classificationRegulation: string | null;
  regulationIds: string[];
  search: string;
}

/** Lower case without diacritics, so "gliserin" finds "Gliserín" (US-41-P1 AC2). */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Listed with an amount above zero, or listed but not computable for the date. */
const charged = (c: Charge) => c.status === 'CHARGED' || c.status === 'MISSING_VALUE' || c.status === 'DATA_ERROR';

function categoryOf(bk: Charge, pe: Charge): Category {
  if (charged(bk) && charged(pe)) return 'BOTH';
  if (charged(bk)) return 'BK_ONLY';
  if (charged(pe)) return 'PE_ONLY';
  if (bk.status === 'LISTED_ZERO' || pe.status === 'LISTED_ZERO') return 'LISTED_ZERO';
  return 'NOT_LISTED';
}

function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

/** Published catalogue (PRD F-40..F-42, F-45, F-46; Technical Design §4.3.1). */
@Injectable()
export class CatalogueService {
  constructor(private readonly db: DbService) {}

  async catalogue(query: CatalogueQuery) {
    const view = await dataView(this.db.pool, query.date, query.versionNo);
    const all = this.rows(view.state, query.date);

    const notices = [...view.notices];
    let q = query.q?.trim() ?? '';
    if (q.length > MAX_QUERY) {
      q = q.slice(0, MAX_QUERY);
      notices.push(`The search was shortened to ${MAX_QUERY} characters.`);
    }
    const matches = this.matcher(q);
    const searched = all.filter(matches);

    const filters = {
      commodity: (r: Row) => !query.commodity.length || query.commodity.includes(r.commodityId ?? ''),
      group: (r: Row) => !query.group.length || query.group.includes(r.groupId ?? ''),
      category: (r: Row) => !query.category.length || query.category.includes(r.category),
      regulation: (r: Row) => !query.regulation.length || r.regulationIds.some((id) => query.regulation.includes(id)),
      sharedHs: (r: Row) => !query.sharedHs || r.sharedHs,
    };
    const apply = (rows: Row[], except?: keyof typeof filters) =>
      rows.filter((r) => (Object.keys(filters) as (keyof typeof filters)[]).every((k) => k === except || filters[k](r)));
    const rows = apply(searched);

    // Facet counts ignore the facet's own selection, so other values stay reachable (US-42-P1 AC1).
    const count = <K extends string>(rows: Row[], key: (r: Row) => K[]) => {
      const m = new Map<K, number>();
      for (const r of rows) for (const k of key(r)) m.set(k, (m.get(k) ?? 0) + 1);
      return m;
    };
    const label = (id: string) => {
      const reg = view.state.get<RegulationData>(id, 'REGULATION');
      return reg ? regulationLabel(reg) : id;
    };
    const facetList = (m: Map<string, number>, name: (id: string) => string) =>
      [...m].map(([id, n]) => ({ id, label: name(id), count: n })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    const facets = {
      commodity: facetList(count(apply(searched, 'commodity'), (r) => (r.commodityId ? [r.commodityId] : [])),
        (id) => view.state.get<CommodityData>(id, 'COMMODITY')?.code ?? id),
      group: facetList(count(apply(searched, 'group'), (r) => (r.groupId ? [r.groupId] : [])),
        (id) => view.state.get<GroupData>(id, 'PRODUCT_GROUP')?.label ?? id),
      category: CATEGORIES.map((c) => ({ id: c, label: c, count: apply(searched, 'category').filter((r) => r.category === c).length })),
      regulation: facetList(count(apply(searched, 'regulation'), (r) => r.regulationIds), label),
      sharedHs: apply(searched, 'sharedHs').filter((r) => r.sharedHs).length,
    };

    // US-46-P1: the category tiles always add up to the products shown.
    const kpis = {
      shown: rows.length,
      ...Object.fromEntries(CATEGORIES.map((c) => [c, rows.filter((r) => r.category === c).length])),
      sharedHs: rows.filter((r) => r.sharedHs).length,
    } as Record<Category | 'shown' | 'sharedHs', number>;

    const sorted = this.sort(rows, query.sort, query.dir);
    const start = (query.page - 1) * query.pageSize;
    return {
      date: query.date,
      versionNo: view.versionNo,
      publishedAt: view.publishedAt,
      scheduledApplied: view.scheduledApplied,
      notices,
      query: q,
      referencePrices: this.referencePrices(view.state, query.date),
      kpis,
      facets,
      total: rows.length,
      page: query.page,
      pageSize: query.pageSize,
      rows: sorted.slice(start, start + query.pageSize).map(({ search: _search, ...r }) => r),
      suggestion: rows.length === 0 && q ? this.suggest(all, q) : null,
    };
  }

  private rows(state: CandidateState, date: string): Row[] {
    const products = state.ofType<ProductData>('PRODUCT');
    const byHs = new Map<string, number>();
    for (const p of products) for (const h of p.data.hsCodes) byHs.set(h.code, (byHs.get(h.code) ?? 0) + 1);
    const lines = state.ofType<ScheduleLineData>('SCHEDULE_LINE');

    return products.map((p) => {
      const d = p.data;
      const group = state.get<GroupData>(d.groupId, 'PRODUCT_GROUP');
      const commodity = state.get<CommodityData>(group?.commodityId, 'COMMODITY');
      const reg = state.get<RegulationData>(d.classificationRegulationId, 'REGULATION');
      const bk = chargeFor(state, p.id, 'BK', date);
      const pe = chargeFor(state, p.id, 'PE', date);
      const known = (c: Charge) => c.status !== 'MISSING_VALUE' && c.status !== 'DATA_ERROR';
      const total = known(bk) && known(pe) ? new Decimal(bk.usdPerMt!).plus(pe.usdPerMt!).toFixed() : null;
      const blocking = [bk, pe].find((c) => !known(c));
      const primary = d.parameters.find((x) => x.isPrimary);
      const productLines = lines.filter((l) => l.data.productIds.includes(p.id));
      const regulationIds = [...new Set([
        d.classificationRegulationId,
        ...productLines.map((l) => state.get<ScheduleData>(l.data.scheduleId, 'SCHEDULE')?.regulationId),
      ].filter((x): x is string => !!x))];
      return {
        productId: p.id,
        commodityId: group?.commodityId ?? null,
        commodityCode: commodity?.code ?? null,
        groupId: d.groupId,
        group: group?.label ?? null,
        groupOrdinal: group?.ordinal ?? 9999,
        itemNoAsPrinted: d.itemNoAsPrinted,
        nameId: d.nameId,
        nameEn: d.nameEn,
        hsCodes: d.hsCodes.map((h) => ({ code: h.code, isEx: h.isEx })),
        keySpec: primary ? `${primary.name} ${primary.operator === 'TEXT' ? '' : primary.operator + ' '}${primary.valueText}${primary.unit ? ' ' + primary.unit : ''}` : null,
        bk,
        pe,
        totalUsdPerMt: total,
        totalNote: total !== null ? null : blocking?.status === 'MISSING_VALUE' && blocking.message?.startsWith('Harga Ekspor') ? 'n/a – needs Harga Ekspor' : 'n/a – value missing',
        category: categoryOf(bk, pe),
        sharedHs: d.hsCodes.some((h) => (byHs.get(h.code) ?? 0) > 1),
        draftClassification: reg?.status === 'DRAFT_RANCANGAN',
        classificationRegulation: reg ? regulationLabel(reg) : null,
        regulationIds,
        // Names, synonyms, definition, parameters, notes and the schedule uraian (US-41-P1 AC2).
        search: fold([
          d.nameId, d.nameEn, ...d.synonyms, d.definition, ...d.notes, d.itemNoAsPrinted,
          ...d.parameters.map((x) => `${x.name} ${x.valueText}`), ...productLines.map((l) => l.data.uraian),
          ...d.hsCodes.map((h) => h.code),
        ].filter(Boolean).join(' \n ')),
      };
    });
  }

  /** Literal, case- and diacritic-insensitive words (all must match); HS codes in any format by digit prefix. */
  private matcher(q: string): (r: Row) => boolean {
    if (!q) return () => true;
    const digits = q.replace(/[.\s]/g, '');
    if (/^\d{2,8}$/.test(digits)) {
      return (r) => r.hsCodes.some((h) => h.code.replace(/\./g, '').startsWith(digits));
    }
    const words = fold(q).split(/\s+/).filter(Boolean);
    return (r) => words.every((w) => r.search.includes(w));
  }

  /** "Did you mean…" (US-41-N1 AC3): replace unknown words by the closest word in the catalogue. */
  private suggest(rows: Row[], q: string): string | null {
    const vocabulary = new Set(rows.flatMap((r) => r.search.split(/[^\p{L}\p{N}]+/u)).filter((w) => w.length >= 3));
    let changed = false;
    const words = fold(q).split(/\s+/).filter(Boolean).map((w) => {
      if (vocabulary.has(w) || w.length < 3) return w;
      // Short words may be one letter off ("oyl" → "oil"), longer ones two.
      const limit = w.length <= 4 ? 1 : 2;
      let best: { word: string; d: number } | null = null;
      for (const v of vocabulary) {
        if (Math.abs(v.length - w.length) > limit) continue;
        const d = levenshtein(w, v);
        if (d <= limit && (!best || d < best.d)) best = { word: v, d };
      }
      if (best) changed = true;
      return best?.word ?? w;
    });
    const suggestion = words.join(' ');
    return changed && rows.some(this.matcher(suggestion)) ? suggestion : null;
  }

  /**
   * Default order: commodity (palm first), group, item no. as printed (US-40-P1 AC2). Amount sorts order the
   * known USD/MT values numerically and put rows without a computable amount after them, grouped by reason
   * (US-42-N1) — never as zero.
   */
  private sort(rows: Row[], sort: CatalogueQuery['sort'], dir: 'asc' | 'desc'): Row[] {
    const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
    const byDefault = (a: Row, b: Row) =>
      Number(a.commodityCode !== 'PALM') - Number(b.commodityCode !== 'PALM') || natural(a.commodityCode ?? '', b.commodityCode ?? '') ||
      a.groupOrdinal - b.groupOrdinal || natural(a.itemNoAsPrinted ?? '', b.itemNoAsPrinted ?? '') || natural(a.nameId, b.nameId);
    const sign = dir === 'desc' ? -1 : 1;
    const amount = (pick: (r: Row) => string | null, status: (r: Row) => string) => (a: Row, b: Row) => {
      const x = pick(a);
      const y = pick(b);
      if (x !== null && y !== null) return sign * new Decimal(x).comparedTo(y) || byDefault(a, b);
      if (x !== null) return -1;
      if (y !== null) return 1;
      return natural(status(a), status(b)) || byDefault(a, b);
    };
    const charge = (c: Charge) => (c.status === 'MISSING_VALUE' || c.status === 'DATA_ERROR' ? null : c.usdPerMt);
    const compare = {
      default: (a: Row, b: Row) => sign * byDefault(a, b),
      name: (a: Row, b: Row) => sign * natural(a.nameId, b.nameId) || byDefault(a, b),
      hs: (a: Row, b: Row) => sign * natural(a.hsCodes[0]?.code ?? '', b.hsCodes[0]?.code ?? '') || byDefault(a, b),
      bk: amount((r) => charge(r.bk), (r) => r.bk.status),
      pe: amount((r) => charge(r.pe), (r) => r.pe.status),
      total: amount((r) => r.totalUsdPerMt, (r) => r.totalNote ?? ''),
    }[sort];
    return [...rows].sort(compare);
  }

  /** Header (US-40-P1 AC3, US-46-P1): each reference price and the KMK rate for the date, with the band it falls in. */
  private referencePrices(state: CandidateState, date: string) {
    return state.ofType<RefSeriesData>('REF_SERIES')
      .filter((s) => s.data.kind !== 'HARGA_EKSPOR')
      .map((s) => {
        const value = valueOn(state, s.id, date);
        const bands = value
          ? state.ofType<BandTableData>('BAND_TABLE').filter((t) => t.data.refSeriesId === s.id).map((t) => {
            const i = selectBand(t.data, value.value);
            return { table: t.data.code, ordinal: i + 1, label: t.data.bands[i]?.label ?? null };
          })
          : [];
        return { seriesId: s.id, code: s.data.code, name: s.data.name, kind: s.data.kind, unit: s.data.unit, value, bands };
      });
  }
}
