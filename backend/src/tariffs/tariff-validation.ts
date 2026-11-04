import Decimal from 'decimal.js';
import { addDays } from '../common/fields';
import type { Queryable } from '../db/db.service';
import { CandidateItem, CandidateState, loadSourceDocs } from '../registry/candidate';
import type { CommodityData, ProductData, RegulationData } from '../registry/entities';
import type { AddFinding } from '../registry/validation';
import { hargaEksporSeries } from './charge-engine';
import {
  BandTableData,
  BASES_FOR,
  lineLabel,
  RefSeriesData,
  RefValueData,
  ScheduleData,
  ScheduleLineData,
} from './tariff-entities';

/** Inclusive date ranges with open ends overlap (BR-TRF-01, BR-REF-01). */
function overlaps(a: { from: string | null; to: string | null }, b: { from: string | null; to: string | null }): boolean {
  return (a.from === null || b.to === null || a.from <= b.to) && (b.from === null || a.to === null || b.from <= a.to);
}

/**
 * Rules for reference prices, band tables and duty/levy schedules (PRD BR-TRF-01..04, BR-REF-01..03, DQ-06..08,
 * BR-SRC-01). Lines are checked when they are in the set or when something they depend on is.
 */
export async function validateTariffs(q: Queryable, state: CandidateState, items: CandidateItem[], today: string, add: AddFinding) {
  const series = state.ofType<RefSeriesData>('REF_SERIES');
  const values = state.ofType<RefValueData>('REF_VALUE');
  const tables = state.ofType<BandTableData>('BAND_TABLE');
  const schedules = state.ofType<ScheduleData>('SCHEDULE');
  const lines = state.ofType<ScheduleLineData>('SCHEDULE_LINE');
  const inSet = new Set(items.map((i) => i.entityId));

  // ------------------------------------------------------------ reference series
  for (const s of series.filter((x) => x.inSet)) {
    if (series.some((o) => o.id !== s.id && o.data.code === s.data.code)) {
      add('ERROR', 'SERIES-CODE', 'REF_SERIES', s.id, 'code', `Series code ${s.data.code} is already used.`);
    }
    if (s.data.productId && !state.has(s.data.productId, 'PRODUCT')) {
      add('ERROR', 'REF-MISSING', 'REF_SERIES', s.id, 'productId', `${s.data.code}: the product is not registered.`);
    }
    if (s.data.kind === 'HARGA_EKSPOR' && series.some((o) => o.id !== s.id && o.data.kind === 'HARGA_EKSPOR' && o.data.productId === s.data.productId)) {
      add('ERROR', 'SERIES-HE', 'REF_SERIES', s.id, 'productId', `${s.data.code}: the product already has a Harga Ekspor series.`);
    }
  }

  // ------------------------------------------------------------ reference values
  const docs = await loadSourceDocs(q, values.filter((v) => v.inSet && v.data.sourceDocumentId).map((v) => v.data.sourceDocumentId!));
  for (const v of values.filter((x) => x.inSet)) {
    const d = v.data;
    const s = state.get<RefSeriesData>(d.seriesId, 'REF_SERIES');
    const name = `${s?.code ?? 'Value'} ${d.periodFrom} – ${d.periodTo}`;
    if (!s) add('ERROR', 'REF-MISSING', 'REF_VALUE', v.id, 'seriesId', `${name}: the series is not registered.`);

    // BR-SRC-01 / US-31-N1 AC1: every published price, Harga Ekspor and FX value has its official decree.
    const doc = d.sourceDocumentId ? docs.get(d.sourceDocumentId) : undefined;
    if (!doc || doc.isSecondary) {
      add('ERROR', 'BR-SRC-01', 'REF_VALUE', v.id, 'sourceDocumentId', `${name}: attach the official decree (PDF from an allow-listed publisher).`);
    } else if (doc.recheckMismatch) {
      add('ERROR', 'SRC-HASH', 'REF_VALUE', v.id, 'sourceDocumentId', `${name}: the source document no longer matches the official file.`);
    }

    const sameSeries = values.filter((o) => o.id !== v.id && o.data.seriesId === d.seriesId);
    const clash = sameSeries.find((o) => overlaps({ from: d.periodFrom, to: d.periodTo }, { from: o.data.periodFrom, to: o.data.periodTo }));
    if (clash) {
      add('ERROR', 'BR-REF-01', 'REF_VALUE', v.id, 'periodFrom',
        `${name} overlaps the period ${clash.data.periodFrom} – ${clash.data.periodTo} of the same series.`);
    }
    const previous = sameSeries.filter((o) => o.data.periodTo < d.periodFrom).sort((a, b) => b.data.periodTo.localeCompare(a.data.periodTo))[0];
    if (previous) {
      // BR-REF-02 / US-27-N1 AC2: a jump of more than 30 % needs the Maker's confirmation.
      const change = new Decimal(d.value).minus(previous.data.value).div(previous.data.value).abs();
      if (change.gt('0.3')) {
        add('WARNING', 'BR-REF-02', 'REF_VALUE', v.id, 'value',
          `${name}: ${d.value} differs ${change.mul(100).toFixed(1)} % from the previous period (${previous.data.value}).`);
      }
      // DQ-07: periods of a series follow each other without gaps.
      if (addDays(previous.data.periodTo, 1) < d.periodFrom) {
        add('WARNING', 'DQ-07', 'REF_VALUE', v.id, 'periodFrom',
          `${name}: no value for ${addDays(previous.data.periodTo, 1)} – ${addDays(d.periodFrom, -1)}.`);
      }
    }
  }

  // ------------------------------------------------------------ band tables
  for (const t of tables.filter((x) => x.inSet)) {
    const d = t.data;
    if (tables.some((o) => o.id !== t.id && o.data.code === d.code)) {
      add('ERROR', 'BAND-CODE', 'BAND_TABLE', t.id, 'code', `Band table code ${d.code} is already used.`);
    }
    if (!state.has(d.refSeriesId, 'REF_SERIES')) {
      add('ERROR', 'REF-MISSING', 'BAND_TABLE', t.id, 'refSeriesId', `${d.code}: the reference series is not registered.`);
    }
    // BR-TRF-02 / US-25-N1 AC1: contiguous, non-overlapping, from 0 to no ceiling.
    const problems: string[] = [];
    const first = d.bands[0];
    if (first && first.lowerExclusive !== null && !new Decimal(first.lowerExclusive).isZero()) problems.push(`band 1 starts at ${first.lowerExclusive}, not 0`);
    d.bands.forEach((b, i) => {
      if (i > 0) {
        const prev = d.bands[i - 1];
        if (prev.upperInclusive === null) problems.push(`band ${i} has no ceiling but band ${i + 1} follows`);
        else if (b.lowerExclusive === null) problems.push(`band ${i + 1} has no lower edge`);
        else if (new Decimal(b.lowerExclusive).gt(prev.upperInclusive)) problems.push(`gap between ${prev.upperInclusive} and ${b.lowerExclusive}`);
        else if (new Decimal(b.lowerExclusive).lt(prev.upperInclusive)) problems.push(`bands ${i} and ${i + 1} overlap`);
      }
    });
    if (d.bands.length && d.bands[d.bands.length - 1].upperInclusive !== null) {
      problems.push(`the last band ends at ${d.bands[d.bands.length - 1].upperInclusive} instead of having no ceiling`);
    }
    if (problems.length) add('ERROR', 'BR-TRF-02', 'BAND_TABLE', t.id, 'bands', `${d.code}: ${problems.join('; ')}.`);
  }

  // ------------------------------------------------------------ schedules
  for (const s of schedules.filter((x) => x.inSet)) {
    const label = `${s.data.chargeType} ${s.data.annexLabel}`;
    if (!state.has(s.data.regulationId, 'REGULATION')) add('ERROR', 'REF-MISSING', 'SCHEDULE', s.id, 'regulationId', `${label}: the regulation is not registered.`);
    if (!state.has(s.data.commodityId, 'COMMODITY')) add('ERROR', 'REF-MISSING', 'SCHEDULE', s.id, 'commodityId', `${label}: the commodity is not registered.`);
  }

  // ------------------------------------------------------------ schedule lines
  const affected = lines.filter((l) => l.inSet || inSet.has(l.data.scheduleId ?? '') || inSet.has(l.data.bandTableId ?? '') || inSet.has(l.data.refSeriesId ?? ''));
  const reported = new Set<string>();
  for (const l of affected) {
    const d = l.data;
    const name = lineLabel(d);
    const schedule = state.get<ScheduleData>(d.scheduleId, 'SCHEDULE');
    const err = (rule: string, field: string | null, message: string) => add('ERROR', rule, 'SCHEDULE_LINE', l.id, field, `${name}: ${message}`);

    if (!schedule) err('REF-MISSING', 'scheduleId', 'the schedule is not registered.');
    if (!d.validFrom) err('BR-TRF-01', 'validFrom', 'missing validity start.');
    if (schedule && !BASES_FOR[schedule.chargeType].includes(d.basisType)) {
      err('BASIS', 'basisType', `${d.basisType} is not a ${schedule.chargeType} basis (allowed: ${BASES_FOR[schedule.chargeType].join(', ')}).`);
    }

    const ref = state.get<RefSeriesData>(d.refSeriesId, 'REF_SERIES');
    if (d.refSeriesId && !ref) err('REF-MISSING', 'refSeriesId', 'the reference series is not registered.');
    if (ref && ref.kind !== 'REFERENCE_PRICE') err('BR-TRF-04', 'refSeriesId', `${ref.code} is not a reference-price series.`);

    if (d.basisType === 'BAND_USD_PER_MT' || d.basisType === 'BAND_PCT') {
      const table = state.get<BandTableData>(d.bandTableId, 'BAND_TABLE');
      if (!table) {
        err('REF-MISSING', 'bandTableId', 'the band table is not registered.');
      } else {
        // US-25-N1 AC2: exactly one amount per band.
        if (d.bandValues.length !== table.bands.length) {
          err('DQ-06', 'bandValues', `${d.bandValues.length} amounts for ${table.bands.length} bands of ${table.code}.`);
        }
        if (table.refSeriesId !== d.refSeriesId) err('BR-TRF-04', 'refSeriesId', `${table.code} is defined on a different reference series.`);
      }
      // US-25-N1 AC3: amounts falling as the reference price rises are suspicious.
      if (d.bandValues.some((v, i) => i > 0 && new Decimal(v).lt(d.bandValues[i - 1]))) {
        add('WARNING', 'DQ-06', 'SCHEDULE_LINE', l.id, 'bandValues', `${name}: band amounts decrease as the reference price rises — confirm.`);
      }
    }

    for (const p of d.productIds) {
      const product = state.get<ProductData>(p, 'PRODUCT');
      if (!product) {
        err('REF-MISSING', 'productIds', 'links a product that is not registered.');
        continue;
      }
      if ((d.basisType === 'AD_VALOREM_PCT' || d.basisType === 'BAND_PCT') && !hargaEksporSeries(state, p)) {
        err('BR-CAL-04', 'productIds', `${product.nameId} has no Harga Ekspor series, which this basis needs.`);
      }
      // BR-TRF-01 / US-25-N2 / US-26-N1 AC2: one active BK and one active PE line per product and date.
      if (!schedule) continue;
      for (const o of lines) {
        if (o.id === l.id || !o.data.productIds.includes(p)) continue;
        if (state.get<ScheduleData>(o.data.scheduleId, 'SCHEDULE')?.chargeType !== schedule.chargeType) continue;
        if (!overlaps({ from: d.validFrom, to: d.validTo }, { from: o.data.validFrom, to: o.data.validTo })) continue;
        const key = [l.id, o.id, p].sort().join('|');
        if (reported.has(key)) continue;
        reported.add(key);
        err('BR-TRF-01', 'productIds',
          `${product.nameId} already has an active ${schedule.chargeType} line in the same period (${lineLabel(o.data)}).`);
      }
    }
    // DQ-08 / US-26-N1 AC3.
    if (!d.productIds.length) add('WARNING', 'DQ-08', 'SCHEDULE_LINE', l.id, 'productIds', `${name}: not linked to any product.`);
  }

  // A schedule's commodity should match the products its lines cover.
  for (const l of lines.filter((x) => x.inSet)) {
    const schedule = state.get<ScheduleData>(l.data.scheduleId, 'SCHEDULE');
    const commodity = state.get<CommodityData>(schedule?.commodityId, 'COMMODITY');
    const regulation = state.get<RegulationData>(schedule?.regulationId, 'REGULATION');
    if (regulation?.status === 'REVOKED' && (!l.data.validTo || l.data.validTo >= today)) {
      add('WARNING', 'REG-REVOKED', 'SCHEDULE_LINE', l.id, 'scheduleId', `${lineLabel(l.data)}: its regulation is revoked but the line is still valid.`);
    }
    if (commodity && !commodity.isInScope) {
      add('INFO', 'OUT-OF-SCOPE', 'SCHEDULE_LINE', l.id, 'scheduleId', `${lineLabel(l.data)}: the commodity ${commodity.code} is out of scope.`);
    }
  }
}
