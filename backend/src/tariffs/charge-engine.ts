import Decimal from 'decimal.js';
import type { CandidateState } from '../registry/candidate';
import { ProductData, regulationLabel, RegulationData } from '../registry/entities';
import { validOn } from '../registry/versioning';
import { BandTableData, lineLabel, RefSeriesData, RefValueData, ScheduleData, ScheduleLineData } from './tariff-entities';

export type ChargeType = 'BK' | 'PE';

/**
 * CHARGED and LISTED_ZERO come from a schedule line; NOT_LISTED means no line applies (BR-CAL-06).
 * MISSING_VALUE: a reference price or Harga Ekspor for the date is not published (BR-CAL-03).
 * DATA_ERROR: published data breaks a rule (two active lines, no band for the price, band amounts missing).
 */
export type ChargeStatus = 'CHARGED' | 'LISTED_ZERO' | 'NOT_LISTED' | 'MISSING_VALUE' | 'DATA_ERROR';

export interface ValueUsed {
  seriesId: string;
  seriesCode: string;
  valueId: string;
  value: string;
  unit: string;
  periodFrom: string;
  periodTo: string;
  sourceDocumentId: string | null;
  sourceReference: string | null;
  /** Harga Ekspor of an earlier period, used because the period's decision is not yet published (BR-CAL-03). */
  fallback: boolean;
}

export interface Charge {
  chargeType: ChargeType;
  status: ChargeStatus;
  /** Exact USD per metric tonne; rounding is for display only (BR-CAL-05). */
  usdPerMt: string | null;
  message: string | null;
  basisType?: string;
  /** The % applied: the line's rate or the band's %. */
  rate?: string | null;
  band?: { ordinal: number; label: string } | null;
  referencePrice?: ValueUsed | null;
  hargaEkspor?: ValueUsed | null;
  line?: {
    lineId: string;
    label: string;
    regulationId: string | null;
    regulation: string | null;
    annexLabel: string | null;
    kelompok: string | null;
    itemNo: string | null;
    uraian: string;
  };
}

/** The series' value whose period contains `date`; with `fallback`, else the latest earlier one. */
export function valueOn(state: CandidateState, seriesId: string | null, date: string, fallback = false): ValueUsed | null {
  const series = state.get<RefSeriesData>(seriesId, 'REF_SERIES');
  if (!seriesId || !series) return null;
  const values = state.ofType<RefValueData>('REF_VALUE').filter((v) => v.data.seriesId === seriesId);
  let hit = values.find((v) => v.data.periodFrom <= date && date <= v.data.periodTo);
  let usedFallback = false;
  if (!hit && fallback) {
    hit = values.filter((v) => v.data.periodTo < date).sort((a, b) => b.data.periodTo.localeCompare(a.data.periodTo))[0];
    usedFallback = !!hit;
  }
  if (!hit) return null;
  return {
    seriesId,
    seriesCode: series.code,
    valueId: hit.id,
    value: hit.data.value,
    unit: series.unit,
    periodFrom: hit.data.periodFrom,
    periodTo: hit.data.periodTo,
    sourceDocumentId: hit.data.sourceDocumentId,
    sourceReference: hit.data.sourceReference,
    fallback: usedFallback,
  };
}

/** The product's Harga Ekspor series (one per product). */
export function hargaEksporSeries(state: CandidateState, productId: string): string | null {
  return state.ofType<RefSeriesData>('REF_SERIES').find((s) => s.data.kind === 'HARGA_EKSPOR' && s.data.productId === productId)?.id ?? null;
}

/** BR-CAL-02: the first band whose range contains the price (lower edge exclusive, upper inclusive). */
export function selectBand(table: BandTableData, price: string): number {
  const p = new Decimal(price);
  return table.bands.findIndex((b) => (b.lowerExclusive === null || p.gt(b.lowerExclusive)) && (b.upperInclusive === null || p.lte(b.upperInclusive)));
}

/** Schedule lines of one charge type that apply to the product on the date. */
export function activeLines(state: CandidateState, productId: string, chargeType: ChargeType, date: string) {
  return state.ofType<ScheduleLineData>('SCHEDULE_LINE').filter((l) => {
    if (!l.data.productIds.includes(productId) || !validOn(l.data, date)) return false;
    const schedule = state.get<ScheduleData>(l.data.scheduleId, 'SCHEDULE');
    return schedule?.chargeType === chargeType && validOn(schedule, date);
  });
}

/** Duty or levy per metric tonne for one product on one date (PRD §9.2, Technical Design §4.3.2). */
export function chargeFor(state: CandidateState, productId: string, chargeType: ChargeType, date: string): Charge {
  const lines = activeLines(state, productId, chargeType, date);
  const base = { chargeType, usdPerMt: null };
  if (!lines.length) return { ...base, status: 'NOT_LISTED', usdPerMt: '0', message: `Not subject to ${chargeType}.` };
  if (lines.length > 1) {
    return { ...base, status: 'DATA_ERROR', message: `${lines.length} ${chargeType} lines apply on ${date} (BR-TRF-01).` };
  }

  const { id: lineId, data: l } = lines[0];
  const schedule = state.get<ScheduleData>(l.scheduleId, 'SCHEDULE')!;
  const regulation = state.get<RegulationData>(schedule.regulationId, 'REGULATION');
  const result: Charge = {
    ...base,
    status: 'CHARGED',
    message: null,
    basisType: l.basisType,
    rate: null,
    band: null,
    referencePrice: null,
    hargaEkspor: null,
    line: {
      lineId,
      label: lineLabel(l),
      regulationId: schedule.regulationId,
      regulation: regulation ? regulationLabel(regulation) : null,
      annexLabel: schedule.annexLabel,
      kelompok: l.kelompok,
      itemNo: l.itemNo,
      uraian: l.uraian,
    },
  };
  const fail = (status: ChargeStatus, message: string): Charge => ({ ...result, status, usdPerMt: null, message });
  const done = (usd: Decimal): Charge => ({ ...result, status: usd.isZero() ? 'LISTED_ZERO' : 'CHARGED', usdPerMt: usd.toFixed() });

  const needReference = () => {
    const ref = valueOn(state, l.refSeriesId, date);
    const code = state.get<RefSeriesData>(l.refSeriesId, 'REF_SERIES')?.code ?? 'reference price';
    result.referencePrice = ref;
    return ref ?? fail('MISSING_VALUE', `Value for ${code} on ${date} not yet published.`);
  };
  const needHargaEkspor = () => {
    const he = valueOn(state, hargaEksporSeries(state, productId), date, true);
    const name = state.get<ProductData>(productId, 'PRODUCT')?.nameId ?? 'the product';
    result.hargaEkspor = he;
    return he ?? fail('MISSING_VALUE', `Harga Ekspor for ${name} on ${date} not yet published.`);
  };
  const needBand = (price: string) => {
    const table = state.get<BandTableData>(l.bandTableId, 'BAND_TABLE');
    const i = table ? selectBand(table, price) : -1;
    if (!table || i < 0 || l.bandValues[i] === undefined) return fail('DATA_ERROR', `No band of the band table covers ${price}.`);
    result.band = { ordinal: i + 1, label: table.bands[i].label };
    return l.bandValues[i];
  };

  switch (l.basisType) {
    case 'ZERO_LISTED':
      return done(new Decimal(0));
    case 'FIXED_USD_PER_MT':
      return done(new Decimal(l.usdPerMt!));
    case 'PCT_OF_REF_PRICE': {
      const ref = needReference();
      if ('status' in ref) return ref;
      result.rate = l.pct;
      return done(new Decimal(l.pct!).div(100).mul(ref.value));
    }
    case 'BAND_USD_PER_MT': {
      const ref = needReference();
      if ('status' in ref) return ref;
      const amount = needBand(ref.value);
      return typeof amount === 'string' ? done(new Decimal(amount)) : amount;
    }
    case 'BAND_PCT': {
      const ref = needReference();
      if ('status' in ref) return ref;
      const pct = needBand(ref.value);
      if (typeof pct !== 'string') return pct;
      result.rate = pct;
      const he = needHargaEkspor();
      return 'status' in he ? he : done(new Decimal(pct).div(100).mul(he.value));
    }
    case 'AD_VALOREM_PCT': {
      result.rate = l.pct;
      const he = needHargaEkspor();
      return 'status' in he ? he : done(new Decimal(l.pct!).div(100).mul(he.value));
    }
    default:
      return fail('DATA_ERROR', `Unknown basis ${l.basisType}.`);
  }
}
