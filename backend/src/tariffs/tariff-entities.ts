import Decimal from 'decimal.js';
import { addDays, decimalOf, Fields } from '../common/fields';
import type { Queryable } from '../db/db.service';
import type { EntityDef } from '../registry/entities';
import { checkRange, VALIDITY_JSON, validityParams, VERSION_COLUMNS } from '../registry/versioning';

/**
 * Export duty (BK) and levy (PE) schedules, band tables and reference series (Technical Design §7.2), as
 * change-set records. Money, rates and prices are exact decimal strings end to end (§4.3.2).
 */

export const TARIFF_ENTITY_TYPES = ['REF_SERIES', 'REF_VALUE', 'BAND_TABLE', 'SCHEDULE', 'SCHEDULE_LINE'] as const;
export type TariffEntityType = (typeof TARIFF_ENTITY_TYPES)[number];

export const SERIES_KINDS = ['REFERENCE_PRICE', 'HARGA_EKSPOR', 'FX_RATE'] as const;
export const CADENCES = ['MONTHLY', 'HALF_MONTHLY', 'WEEKLY'] as const;
export const CHARGE_TYPES = ['BK', 'PE'] as const;
export const BASIS_TYPES = ['BAND_USD_PER_MT', 'AD_VALOREM_PCT', 'BAND_PCT', 'PCT_OF_REF_PRICE', 'FIXED_USD_PER_MT', 'ZERO_LISTED'] as const;
/** FR-TRF-01 / FR-TRF-02: which bases each charge supports. */
export const BASES_FOR: Record<string, readonly string[]> = {
  BK: ['BAND_USD_PER_MT', 'AD_VALOREM_PCT', 'BAND_PCT', 'ZERO_LISTED'],
  PE: ['PCT_OF_REF_PRICE', 'FIXED_USD_PER_MT', 'ZERO_LISTED'],
};

export interface RefSeriesData {
  code: string;
  name: string;
  kind: string;
  unit: string;
  cadence: string;
  productId: string | null;
}

export interface RefValueData {
  seriesId: string | null;
  periodFrom: string;
  periodTo: string;
  value: string;
  sourceDocumentId: string | null;
  sourceReference: string | null;
}

export interface Band {
  lowerExclusive: string | null;
  upperInclusive: string | null;
  label: string;
}

export interface BandTableData {
  code: string;
  name: string;
  refSeriesId: string | null;
  bands: Band[];
  validFrom: string | null;
  validTo: string | null;
}

export interface ScheduleData {
  regulationId: string | null;
  chargeType: string;
  annexLabel: string;
  commodityId: string | null;
  validFrom: string | null;
  validTo: string | null;
}

export interface ScheduleLineData {
  scheduleId: string | null;
  kelompok: string | null;
  itemNo: string | null;
  uraian: string;
  basisType: string;
  pct: string | null;
  usdPerMt: string | null;
  bandTableId: string | null;
  refSeriesId: string | null;
  /** One amount per band, in band order: USD/MT for BAND_USD_PER_MT, % for BAND_PCT. */
  bandValues: string[];
  productIds: string[];
  validFrom: string | null;
  validTo: string | null;
}

/** Numeric columns back as canonical text ("10", "7.5"), never as JSON floats. */
const num = (col: string) => `trim_scale(${col})::text`;

/** Default printed label for a band: "≤ 680", "680–730", "> 1430". */
export function bandLabel(b: Pick<Band, 'lowerExclusive' | 'upperInclusive'>): string {
  if (b.lowerExclusive === null) return `≤ ${b.upperInclusive}`;
  if (b.upperInclusive === null) return `> ${b.lowerExclusive}`;
  return `${b.lowerExclusive}–${b.upperInclusive}`;
}

// ---------------------------------------------------------------- reference series and values

const refSeriesDef: EntityDef<RefSeriesData> = {
  type: 'REF_SERIES',
  table: 'ref_series',
  fields: ['code', 'name', 'kind', 'unit', 'cadence', 'productId'],
  select: `
    SELECT ${VERSION_COLUMNS}, json_build_object(
      'code', t.code, 'name', t.name, 'kind', t.kind, 'unit', t.unit, 'cadence', t.cadence, 'productId', t.product_entity_id
    ) AS data
    FROM ecr.ref_series t`,

  async parse(input) {
    const f = new Fields(input);
    const code = (f.text('code', 40) || '').toUpperCase();
    if (code && !/^[A-Z0-9-]{2,40}$/.test(code)) f.fail('code', '2–40 letters, digits or "-", e.g. CPO or FX-USDIDR.');
    const d: RefSeriesData = {
      code,
      name: f.text('name', 200),
      kind: f.oneOf('kind', SERIES_KINDS),
      unit: f.text('unit', 30),
      cadence: f.oneOf('cadence', CADENCES),
      productId: f.optUuid('productId'),
    };
    if (d.kind === 'HARGA_EKSPOR' && !d.productId) f.fail('productId', 'A Harga Ekspor series belongs to one product.');
    if (d.kind !== 'HARGA_EKSPOR') d.productId = null;
    f.throwIfAny();
    return d;
  },

  validity: () => ({ validFrom: null, validTo: null }),
  withEndDate: (d) => d,
  label: (d) => d.code,
  naturalKey: (d) => d.code,

  async insertRow(q, base, d) {
    await q.query(
      `INSERT INTO ecr.ref_series (entity_id, version_from, change_set_id, code, name, kind, unit, cadence, product_entity_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [base.entityId, base.versionNo, base.changeSetId, d.code, d.name, d.kind, d.unit, d.cadence, d.productId],
    );
  },
};

const refValueDef: EntityDef<RefValueData> = {
  type: 'REF_VALUE',
  table: 'ref_value',
  fields: ['seriesId', 'periodFrom', 'periodTo', 'value', 'sourceReference', 'sourceDocumentId'],
  select: `
    SELECT ${VERSION_COLUMNS}, json_build_object(
      'seriesId', t.series_entity_id, 'periodFrom', t.period_from, 'periodTo', t.period_to, 'value', ${num('t.value')},
      'sourceDocumentId', t.source_document_id, 'sourceReference', t.source_reference
    ) AS data
    FROM ecr.ref_value t`,

  async parse(input, q) {
    const f = new Fields(input);
    const d: RefValueData = {
      seriesId: f.optUuid('seriesId'),
      periodFrom: f.optDate('periodFrom') ?? '',
      periodTo: f.optDate('periodTo') ?? '',
      // US-27-N1 AC3: a value ≤ 0 is blocked.
      value: f.optDecimal('value', { min: '0', minExclusive: true }) ?? '',
      sourceDocumentId: f.optUuid('sourceDocumentId'),
      sourceReference: f.optText('sourceReference', 200),
    };
    if (!d.seriesId) f.fail('seriesId', 'Choose the series.');
    if (!d.periodFrom) f.fail('periodFrom', 'Required.');
    if (!d.periodTo) f.fail('periodTo', 'Required.');
    if (!d.value && !f.errors.some((e) => e.field === 'value')) f.fail('value', 'Required.');
    if (d.periodFrom && d.periodTo && d.periodTo < d.periodFrom) f.fail('periodTo', 'The period ends before it starts.');
    if (d.sourceDocumentId) {
      const { rows } = await q.query('SELECT 1 FROM ecr.source_document WHERE id = $1', [d.sourceDocumentId]);
      if (!rows[0]) f.fail('sourceDocumentId', 'Document not found.');
    }
    f.throwIfAny();
    return d;
  },

  validity: (d) => ({ validFrom: d.periodFrom, validTo: d.periodTo }),
  withEndDate: (d, date) => ({ ...d, periodTo: date }),
  label: (d) => `${d.periodFrom} – ${d.periodTo}: ${d.value}`,
  naturalKey: () => null,

  async insertRow(q, base, d) {
    await q.query(
      `INSERT INTO ecr.ref_value
         (entity_id, valid_from, valid_to, version_from, change_set_id, series_entity_id, period_from, period_to, value,
          source_document_id, source_reference)
       VALUES ($1, $2, $3, $4, $5, $6, $2, $7, $8, $9, $10)`,
      [base.entityId, d.periodFrom, addDays(d.periodTo, 1), base.versionNo, base.changeSetId, d.seriesId, d.periodTo, d.value,
       d.sourceDocumentId, d.sourceReference],
    );
  },
};

// ---------------------------------------------------------------- band tables

const bandTableDef: EntityDef<BandTableData> = {
  type: 'BAND_TABLE',
  table: 'band_table',
  fields: ['code', 'name', 'refSeriesId', 'bands', 'validFrom', 'validTo'],
  select: `
    SELECT ${VERSION_COLUMNS}, json_build_object(
      'code', t.code, 'name', t.name, 'refSeriesId', t.ref_series_entity_id,
      'bands', COALESCE((SELECT json_agg(json_build_object(
                           'lowerExclusive', ${num('b.lower_exclusive')}, 'upperInclusive', ${num('b.upper_inclusive')}, 'label', b.label)
                           ORDER BY b.ordinal)
                          FROM ecr.band b WHERE b.band_table_row_id = t.id), '[]'::json),
      ${VALIDITY_JSON}
    ) AS data
    FROM ecr.band_table t`,

  async parse(input) {
    const f = new Fields(input);
    const code = (f.text('code', 40) || '').toUpperCase();
    if (code && !/^[A-Z0-9-]{2,40}$/.test(code)) f.fail('code', '2–40 letters, digits or "-", e.g. CPO-17.');
    const d: BandTableData = {
      code,
      name: f.text('name', 200),
      refSeriesId: f.optUuid('refSeriesId'),
      bands: [],
      validFrom: f.optDate('validFrom'),
      validTo: f.optDate('validTo'),
    };
    if (!d.refSeriesId) f.fail('refSeriesId', 'Choose the reference series the bands apply to.');
    checkRange(f, d);
    f.list('bands', 100).forEach((b, i) => {
      const bf = f.nested('bands', i, b);
      const band = {
        lowerExclusive: bf.optDecimal('lowerExclusive', { min: '0', scale: 4 }),
        upperInclusive: bf.optDecimal('upperInclusive', { min: '0', scale: 4 }),
        label: bf.optText('label', 50) ?? '',
      };
      if (band.lowerExclusive !== null && band.upperInclusive !== null && new Decimal(band.upperInclusive).lte(band.lowerExclusive)) {
        bf.fail('upperInclusive', 'The upper edge must be above the lower edge.');
      }
      d.bands.push({ ...band, label: band.label || bandLabel(band) });
    });
    if (!d.bands.length) f.fail('bands', 'Add at least one band.');
    f.throwIfAny();
    return d;
  },

  validity: (d) => ({ validFrom: d.validFrom, validTo: d.validTo }),
  withEndDate: (d, date) => ({ ...d, validTo: date }),
  label: (d) => d.code,
  naturalKey: (d) => d.code,

  async insertRow(q, base, d) {
    const [validFrom, validTo] = validityParams(d);
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO ecr.band_table (entity_id, valid_from, valid_to, version_from, change_set_id, code, name, ref_series_entity_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [base.entityId, validFrom, validTo, base.versionNo, base.changeSetId, d.code, d.name, d.refSeriesId],
    );
    for (const [i, b] of d.bands.entries()) {
      await q.query('INSERT INTO ecr.band (band_table_row_id, ordinal, lower_exclusive, upper_inclusive, label) VALUES ($1, $2, $3, $4, $5)',
        [rows[0].id, i + 1, b.lowerExclusive, b.upperInclusive, b.label]);
    }
  },
};

// ---------------------------------------------------------------- schedules and lines

const scheduleDef: EntityDef<ScheduleData> = {
  type: 'SCHEDULE',
  table: 'schedule',
  fields: ['regulationId', 'chargeType', 'annexLabel', 'commodityId', 'validFrom', 'validTo'],
  select: `
    SELECT ${VERSION_COLUMNS}, json_build_object(
      'regulationId', t.regulation_entity_id, 'chargeType', t.charge_type, 'annexLabel', t.annex_label,
      'commodityId', t.commodity_entity_id, ${VALIDITY_JSON}
    ) AS data
    FROM ecr.schedule t`,

  async parse(input) {
    const f = new Fields(input);
    const d: ScheduleData = {
      regulationId: f.optUuid('regulationId'),
      chargeType: f.oneOf('chargeType', CHARGE_TYPES),
      annexLabel: f.text('annexLabel', 100),
      commodityId: f.optUuid('commodityId'),
      validFrom: f.optDate('validFrom'),
      validTo: f.optDate('validTo'),
    };
    if (!d.regulationId) f.fail('regulationId', 'Choose the regulation the schedule belongs to.');
    if (!d.commodityId) f.fail('commodityId', 'Choose the commodity.');
    checkRange(f, d);
    f.throwIfAny();
    return d;
  },

  validity: (d) => ({ validFrom: d.validFrom, validTo: d.validTo }),
  withEndDate: (d, date) => ({ ...d, validTo: date }),
  label: (d) => `${d.chargeType} ${d.annexLabel}`,
  naturalKey: () => null,

  async insertRow(q, base, d) {
    const [validFrom, validTo] = validityParams(d);
    await q.query(
      `INSERT INTO ecr.schedule (entity_id, valid_from, valid_to, version_from, change_set_id, regulation_entity_id, charge_type, annex_label, commodity_entity_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [base.entityId, validFrom, validTo, base.versionNo, base.changeSetId, d.regulationId, d.chargeType, d.annexLabel, d.commodityId],
    );
  },
};

export function lineLabel(d: Pick<ScheduleLineData, 'kelompok' | 'itemNo' | 'uraian'>): string {
  const where = [d.kelompok && `Kelompok ${d.kelompok}`, d.itemNo && `no. ${d.itemNo}`].filter(Boolean).join(' ');
  const text = d.uraian.length > 70 ? `${d.uraian.slice(0, 67)}…` : d.uraian;
  return where ? `${where}: ${text}` : text;
}

const scheduleLineDef: EntityDef<ScheduleLineData> = {
  type: 'SCHEDULE_LINE',
  table: 'schedule_line',
  fields: ['scheduleId', 'kelompok', 'itemNo', 'uraian', 'basisType', 'pct', 'usdPerMt', 'refSeriesId', 'bandTableId', 'bandValues',
    'productIds', 'validFrom', 'validTo'],
  select: `
    SELECT ${VERSION_COLUMNS}, json_build_object(
      'scheduleId', t.schedule_entity_id, 'kelompok', t.kelompok, 'itemNo', t.item_no, 'uraian', t.uraian,
      'basisType', t.basis_type, 'pct', ${num('t.pct')}, 'usdPerMt', ${num('t.usd_per_mt')},
      'bandTableId', t.band_table_entity_id, 'refSeriesId', t.ref_series_entity_id,
      'bandValues', COALESCE((SELECT json_agg(${num('v.amount')} ORDER BY v.band_ordinal)
                                FROM ecr.schedule_line_band_value v WHERE v.schedule_line_row_id = t.id), '[]'::json),
      'productIds', COALESCE((SELECT json_agg(p.product_entity_id ORDER BY p.product_entity_id)
                                FROM ecr.schedule_line_product p WHERE p.schedule_line_row_id = t.id), '[]'::json),
      'validFrom', t.valid_from, 'validTo', t.valid_to - 1
    ) AS data
    FROM ecr.schedule_line t`,

  async parse(input) {
    const f = new Fields(input);
    const basisType = f.oneOf('basisType', BASIS_TYPES);
    const banded = basisType === 'BAND_USD_PER_MT' || basisType === 'BAND_PCT';
    const d: ScheduleLineData = {
      scheduleId: f.optUuid('scheduleId'),
      kelompok: f.optText('kelompok', 50),
      itemNo: f.optText('itemNo', 50),
      // The legal description is kept verbatim, never truncated.
      uraian: f.text('uraian', 5000),
      basisType,
      // US-26-N1 AC1 / US-25-N1 AC2: % must be above 0 and at most 100; amounts never negative.
      pct: f.optDecimal('pct', { min: '0', minExclusive: true, max: '100', scale: 4 }),
      usdPerMt: f.optDecimal('usdPerMt', { min: '0', scale: 4 }),
      bandTableId: f.optUuid('bandTableId'),
      refSeriesId: f.optUuid('refSeriesId'),
      bandValues: [],
      productIds: [],
      validFrom: f.optDate('validFrom'),
      validTo: f.optDate('validTo'),
    };
    if (!d.scheduleId) f.fail('scheduleId', 'Choose the schedule (annex) the line belongs to.');
    checkRange(f, d);

    const values = input.bandValues;
    if (values !== undefined && values !== null && !Array.isArray(values)) f.fail('bandValues', 'Must be a list.');
    (Array.isArray(values) ? (values as unknown[]) : []).forEach((raw, i) => {
      const v = decimalOf(raw, { min: '0', max: basisType === 'BAND_PCT' ? '100' : undefined, scale: 4 });
      if (v === null) f.fail(`bandValues[${i}]`, 'Enter an amount for every band (0 if none).');
      else if (typeof v === 'object') f.fail(`bandValues[${i}]`, v.error);
      d.bandValues.push(typeof v === 'string' ? v : '0');
    });

    const products = input.productIds;
    if (products !== undefined && products !== null && (!Array.isArray(products) || products.some((p) => typeof p !== 'string'))) {
      f.fail('productIds', 'Must be a list of products.');
    }
    d.productIds = [...new Set((Array.isArray(products) ? (products as string[]) : []).map((p) => p.toLowerCase()))].sort();
    if (d.productIds.some((p) => !/^[0-9a-f-]{36}$/.test(p))) f.fail('productIds', 'Not a valid product reference.');

    // BR-TRF-04 and US-26-P1 AC1: each basis has exactly the inputs it needs; the others are cleared.
    const need = (ok: boolean, field: string, message: string) => !ok && f.fail(field, message);
    need(!['PCT_OF_REF_PRICE', 'AD_VALOREM_PCT'].includes(basisType) || d.pct !== null, 'pct', 'Enter the rate in %.');
    need(basisType !== 'FIXED_USD_PER_MT' || d.usdPerMt !== null, 'usdPerMt', 'Enter the amount in USD/MT.');
    need(!banded || d.bandTableId !== null, 'bandTableId', 'Choose the band table.');
    need(!(banded || basisType === 'PCT_OF_REF_PRICE') || d.refSeriesId !== null, 'refSeriesId', 'Choose the reference price series.');
    need(!banded || d.bandValues.length > 0, 'bandValues', 'Enter one amount per band.');
    if (!['PCT_OF_REF_PRICE', 'AD_VALOREM_PCT'].includes(basisType)) d.pct = null;
    if (basisType !== 'FIXED_USD_PER_MT') d.usdPerMt = null;
    if (!banded) {
      d.bandTableId = null;
      d.bandValues = [];
    }
    if (!(banded || basisType === 'PCT_OF_REF_PRICE')) d.refSeriesId = null;
    f.throwIfAny();
    return d;
  },

  validity: (d) => ({ validFrom: d.validFrom, validTo: d.validTo }),
  withEndDate: (d, date) => ({ ...d, validTo: date }),
  label: lineLabel,
  naturalKey: () => null,

  async insertRow(q, base, d) {
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO ecr.schedule_line
         (entity_id, valid_from, valid_to, version_from, change_set_id, schedule_entity_id, kelompok, item_no, uraian, basis_type,
          pct, usd_per_mt, band_table_entity_id, ref_series_entity_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [base.entityId, d.validFrom, d.validTo ? addDays(d.validTo, 1) : null, base.versionNo, base.changeSetId, d.scheduleId, d.kelompok,
       d.itemNo, d.uraian, d.basisType, d.pct, d.usdPerMt, d.bandTableId, d.refSeriesId],
    );
    for (const [i, amount] of d.bandValues.entries()) {
      await q.query('INSERT INTO ecr.schedule_line_band_value (schedule_line_row_id, band_ordinal, amount) VALUES ($1, $2, $3)',
        [rows[0].id, i + 1, amount]);
    }
    for (const p of d.productIds) {
      await q.query('INSERT INTO ecr.schedule_line_product (schedule_line_row_id, product_entity_id) VALUES ($1, $2)', [rows[0].id, p]);
    }
  },
};

export const TARIFF_DEFS = {
  REF_SERIES: refSeriesDef as EntityDef,
  REF_VALUE: refValueDef as EntityDef,
  BAND_TABLE: bandTableDef as EntityDef,
  SCHEDULE: scheduleDef as EntityDef,
  SCHEDULE_LINE: scheduleLineDef as EntityDef,
};
