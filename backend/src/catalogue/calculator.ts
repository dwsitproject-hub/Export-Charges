import { createHash } from 'node:crypto';
import { DEFAULT_DISCLAIMER } from '../config';
import Decimal from 'decimal.js';
import type { CandidateState } from '../registry/candidate';
import { ProductData, regulationLabel, RegulationData } from '../registry/entities';
import { Charge, chargeFor, ValueUsed, valueOn } from '../tariffs/charge-engine';
import type { RefSeriesData, RefValueData } from '../tariffs/tariff-entities';


export interface CalcInput {
  lines: { productId: string; quantityMt: string }[];
  pebDate: string;
  paymentDate: string;
  /** What-if reference price (US-44-P2): replaces every reference price for the PEB date; marks a simulation. */
  refPriceOverride: string | null;
  versionNo: number;
}

export interface LineCharge extends Charge {
  totalUsd: string | null;
}

export interface CalcLine {
  ordinal: number;
  productId: string;
  product: string;
  quantityMt: string;
  bk: LineCharge;
  pe: LineCharge;
  totalUsd: string | null;
  fx: ValueUsed | null;
  totalIdr: string | null;
  warnings: string[];
}

export interface CalcResult {
  pebDate: string;
  paymentDate: string;
  versionNo: number;
  isSimulation: boolean;
  refPriceOverride: string | null;
  status: 'COMPLETE' | 'INCOMPLETE';
  lines: CalcLine[];
  totals: { bkUsd: string | null; peUsd: string | null; usd: string | null; idr: string | null };
  /** Problems that leave a total empty, named so the user knows what is missing (US-44-N2). */
  missing: string[];
  disclaimer: string;
}

/** Plain words for a charge (US-43-P1 AC3): "USD 74/MT", "listed at 0", "not subject". */
export function describeCharge(c: Charge): string {
  if (c.status === 'NOT_LISTED') return `not subject to ${c.chargeType}`;
  if (c.status === 'LISTED_ZERO') return `${c.chargeType} listed at 0`;
  if (c.status !== 'CHARGED') return `${c.chargeType} not computable`;
  const basis = c.basisType === 'PCT_OF_REF_PRICE' ? ` (${c.rate} % of ${c.referencePrice?.seriesCode ?? 'reference price'})`
    : c.basisType === 'AD_VALOREM_PCT' ? ` (${c.rate} % of Harga Ekspor)` : '';
  return `${c.chargeType} USD ${c.usdPerMt}/MT${basis}`;
}

/** SHA-256 of a canonical JSON rendering (keys sorted), for replay checks. */
export function canonicalHash(value: unknown): Buffer {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon)
      : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
        : v;
  return createHash('sha256').update(JSON.stringify(canon(value))).digest();
}

/** Applies a what-if price to every reference-price series on the PEB date (a copy of the state). */
/** The published state with a what-if reference price for `date` (every reference-price series, or only `seriesCode`). */
export function withOverride(state: CandidateState, date: string, price: string, seriesCode?: string): CandidateState {
  const overrides = state.ofType<RefSeriesData>('REF_SERIES').filter((s) => s.data.kind === 'REFERENCE_PRICE' && (!seriesCode || s.data.code === seriesCode)).map((s) => {
    const current = state.ofType<RefValueData>('REF_VALUE').find((v) => v.data.seriesId === s.id && v.data.periodFrom <= date && date <= v.data.periodTo);
    const data: RefValueData = {
      seriesId: s.id,
      periodFrom: current?.data.periodFrom ?? date,
      periodTo: current?.data.periodTo ?? date,
      value: price,
      sourceDocumentId: null,
      sourceReference: 'What-if (simulation)',
    };
    return { id: current?.id ?? `simulation-${s.id}`, candidate: { type: 'REF_VALUE' as const, data, inSet: true } };
  });
  return state.with(overrides);
}

/** The KMK USD/IDR series (FX-USDIDR, else the only FX series). */
function fxSeries(state: CandidateState): string | null {
  const fx = state.ofType<RefSeriesData>('REF_SERIES').filter((s) => s.data.kind === 'FX_RATE');
  return (fx.find((s) => s.data.code === 'FX-USDIDR') ?? fx[0])?.id ?? null;
}

const computable = (c: Charge) => c.status !== 'MISSING_VALUE' && c.status !== 'DATA_ERROR';

/**
 * Charges for a shipment (PRD §9.2, BR-CAL-01..10; Technical Design §4.3.2). Duty and levy use the rates and
 * prices in force on the PEB date; IDR uses the KMK rate on the payment date, or on the PEB date for goods with
 * special characteristics (BR-CAL-09). Exact decimals throughout; only the IDR grand total is rounded (BR-CAL-05).
 * A replay passes the disclaimer stored with the result, since the configured text may have changed since.
 */
export function calculate(published: CandidateState, input: CalcInput, disclaimer = DEFAULT_DISCLAIMER): CalcResult {
  const state = input.refPriceOverride ? withOverride(published, input.pebDate, input.refPriceOverride) : published;
  const fxId = fxSeries(state);
  const missing = new Set<string>();

  // Charges of every product, for the shared-HS warnings (BR-CAL-07).
  const products = state.ofType<ProductData>('PRODUCT');
  const chargeCache = new Map<string, { bk: Charge; pe: Charge }>();
  const chargesOf = (productId: string) => {
    let c = chargeCache.get(productId);
    if (!c) {
      c = { bk: chargeFor(state, productId, 'BK', input.pebDate), pe: chargeFor(state, productId, 'PE', input.pebDate) };
      chargeCache.set(productId, c);
    }
    return c;
  };

  const lines = input.lines.map((l, i): CalcLine => {
    const product = state.get<ProductData>(l.productId, 'PRODUCT')!;
    const { bk, pe } = chargesOf(l.productId);
    const qty = new Decimal(l.quantityMt);
    const withTotal = (c: Charge): LineCharge => ({
      ...c,
      totalUsd: computable(c) && c.usdPerMt !== null ? qty.mul(c.usdPerMt).toFixed() : null,
    });
    const bkLine = withTotal(bk);
    const peLine = withTotal(pe);
    for (const c of [bk, pe]) if (!computable(c) && c.message) missing.add(c.message);

    const totalUsd = bkLine.totalUsd !== null && peLine.totalUsd !== null ? new Decimal(bkLine.totalUsd).plus(peLine.totalUsd).toFixed() : null;
    const fxDate = product.fxOnPebDate ? input.pebDate : input.paymentDate;
    const fx = valueOn(state, fxId, fxDate);
    if (!fx) missing.add(`KMK USD/IDR rate for ${fxDate} not yet published.`);
    const totalIdr = totalUsd !== null && fx ? new Decimal(totalUsd).mul(fx.value).toFixed() : null;

    const warnings: string[] = [];
    if (product.fxOnPebDate) warnings.push(`Goods with special characteristics: IDR at the KMK rate of the PEB date ${input.pebDate} (BR-CAL-09).`);
    for (const c of [bk, pe]) {
      if (c.hargaEkspor?.fallback) {
        warnings.push(`Harga Ekspor of ${c.hargaEkspor.periodFrom} – ${c.hargaEkspor.periodTo} used; the decision for ${input.pebDate} is not yet published (BR-CAL-03).`);
      }
    }
    const reg = state.get<RegulationData>(product.classificationRegulationId, 'REGULATION');
    if (reg?.status === 'DRAFT_RANCANGAN') warnings.push(`Classification based on a draft regulation (${regulationLabel(reg)}) — subject to change.`);
    for (const h of product.hsCodes) {
      const others = products.filter((o) => o.id !== l.productId && o.data.hsCodes.some((x) => x.code === h.code)).map((o) => {
        const oc = chargesOf(o.id);
        const differs = oc.bk.status !== bk.status || oc.bk.usdPerMt !== bk.usdPerMt || oc.pe.status !== pe.status || oc.pe.usdPerMt !== pe.usdPerMt;
        return differs ? `${o.data.nameId} (${describeCharge(oc.bk)}, ${describeCharge(oc.pe)})` : null;
      }).filter(Boolean);
      if (others.length) warnings.push(`HS ${h.code} is shared with products charged differently: ${others.join('; ')} (BR-CAL-07).`);
    }

    return { ordinal: i + 1, productId: l.productId, product: product.nameId, quantityMt: l.quantityMt, bk: bkLine, pe: peLine, totalUsd, fx, totalIdr, warnings };
  });

  const sum = (pick: (l: CalcLine) => string | null) =>
    lines.every((l) => pick(l) !== null) ? lines.reduce((acc, l) => acc.plus(pick(l)!), new Decimal(0)).toFixed() : null;
  const usd = sum((l) => l.totalUsd);
  const idr = sum((l) => l.totalIdr);
  return {
    pebDate: input.pebDate,
    paymentDate: input.paymentDate,
    versionNo: input.versionNo,
    isSimulation: input.refPriceOverride !== null,
    refPriceOverride: input.refPriceOverride,
    status: usd !== null && idr !== null ? 'COMPLETE' : 'INCOMPLETE',
    lines,
    totals: {
      bkUsd: sum((l) => l.bk.totalUsd),
      peUsd: sum((l) => l.pe.totalUsd),
      usd,
      // Whole rupiah, rounded half up, only at the end (BR-CAL-05).
      idr: idr === null ? null : new Decimal(idr).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(),
    },
    missing: [...missing],
    disclaimer,
  };
}
