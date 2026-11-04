import { ApiError } from '../common/api-error';
import { addDays, Fields } from '../common/fields';
import type { Queryable } from '../db/db.service';
import {
  BandTableData,
  RefSeriesData,
  RefValueData,
  ScheduleData,
  ScheduleLineData,
  TARIFF_DEFS,
  TARIFF_ENTITY_TYPES,
} from '../tariffs/tariff-entities';
import { publisherForUrl, urlHost } from './publishers';
import { checkRange, validityParams, VERSION_COLUMNS } from './versioning';

/**
 * Versioned master-data records maintained through change sets (Technical Design §4.2.1, §7.2).
 * Each definition says how the API shape is validated, read back from a row version (with its children)
 * and written as a new row version by the publish transaction.
 */

export const REGISTRY_ENTITY_TYPES = ['REGULATION', 'COMMODITY', 'PRODUCT_GROUP', 'PRODUCT'] as const;
export const ENTITY_TYPES = [...REGISTRY_ENTITY_TYPES, ...TARIFF_ENTITY_TYPES] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const REG_TYPES = ['UU', 'PP', 'PERPRES', 'PMK', 'KMK', 'PERMENDAG', 'KEPMENDAG', 'PERMENPERIN', 'OTHER'] as const;
export const REG_STATUSES = ['DRAFT_RANCANGAN', 'PROMULGATED', 'IN_FORCE', 'AMENDED', 'REVOKED'] as const;
export const REG_RELATIONS = ['AMENDS', 'REVOKES', 'IMPLEMENTS'] as const;
export const DOC_ROLES = ['MAIN', 'ANNEX', 'CORRIGENDUM', 'SECONDARY'] as const;
export const PARAM_OPERATORS = ['<', '≤', '=', '≥', '>', 'RANGE', 'TEXT'] as const;

const REG_TYPE_LABEL: Record<string, string> = {
  UU: 'UU', PP: 'PP', PERPRES: 'Perpres', PMK: 'PMK', KMK: 'KMK',
  PERMENDAG: 'Permendag', KEPMENDAG: 'Kepmendag', PERMENPERIN: 'Permenperin', OTHER: '',
};

export interface RegulationData {
  regType: string;
  number: string;
  year: number;
  titleId: string;
  titleEn: string | null;
  issuer: string;
  status: string;
  promulgatedOn: string | null;
  effectiveOn: string | null;
  endsOn: string | null;
  officialUrl: string | null;
  bpkStatusUrl: string | null;
  relations: { relation: string; regulationId: string }[];
  documents: { sourceDocumentId: string; role: string }[];
}

export interface CommodityData {
  code: string;
  nameId: string;
  nameEn: string | null;
  isInScope: boolean;
  validFrom: string | null;
  validTo: string | null;
}

export interface GroupData {
  commodityId: string | null;
  code: string;
  label: string;
  ordinal: number;
  validFrom: string | null;
  validTo: string | null;
}

export interface ProductParameter {
  name: string;
  operator: string;
  valueText: string;
  valueMin: number | null;
  valueMax: number | null;
  unit: string | null;
  isPrimary: boolean;
}

export interface ProductHsCode {
  hsCodeId: string;
  code: string;
  isEx: boolean;
  exDescription: string | null;
}

export interface ProductData {
  groupId: string | null;
  itemNoAsPrinted: string | null;
  nameId: string;
  nameEn: string | null;
  synonyms: string[];
  definition: string | null;
  notes: string[];
  annexPage: number | null;
  classificationRegulationId: string | null;
  validFrom: string | null;
  validTo: string | null;
  fxOnPebDate: boolean;
  otherObligationsNote: string | null;
  parameters: ProductParameter[];
  hsCodes: ProductHsCode[];
}

export type EntityData =
  | RegulationData | CommodityData | GroupData | ProductData
  | RefSeriesData | RefValueData | BandTableData | ScheduleData | ScheduleLineData;

/** Columns every row version carries; the definition adds its own. */
export interface RowBase {
  entityId: string;
  versionNo: number;
  changeSetId: string;
}

export interface EntityDef<T extends EntityData = EntityData> {
  type: EntityType;
  table: string;
  /** Fields of the API shape in form order (the diff follows it; stored JSON loses key order). */
  fields: readonly string[];
  /** SELECT producing row_id, entity_id, version_from, version_to, change_set_id and data (API shape); alias t. */
  select: string;
  parse(input: Record<string, unknown>, q: Queryable): Promise<T>;
  /** Inclusive business dates (null = open). */
  validity(d: T): { validFrom: string | null; validTo: string | null };
  withEndDate(d: T, date: string): T;
  label(d: T): string;
  naturalKey(d: T): string | null;
  insertRow(q: Queryable, base: RowBase, d: T): Promise<void>;
}

export function regulationLabel(d: Pick<RegulationData, 'regType' | 'number' | 'year'>): string {
  return `${REG_TYPE_LABEL[d.regType] ?? d.regType} ${d.number}/${d.year}`.trim();
}

/** HS input with dots or spaces → 8 digits (US-24-P1 AC1); null for anything else, e.g. "ex 4407 (all…)". */
export function normaliseHs(input: string): string | null {
  const digits = input.replace(/[.\s]/g, '');
  return /^\d{8}$/.test(digits) ? digits : null;
}

// ---------------------------------------------------------------- regulation

const regulationDef: EntityDef<RegulationData> = {
  type: 'REGULATION',
  table: 'regulation',
  fields: ['regType', 'number', 'year', 'titleId', 'titleEn', 'issuer', 'status', 'promulgatedOn', 'effectiveOn', 'endsOn',
    'officialUrl', 'bpkStatusUrl', 'relations', 'documents'],
  select: `
    SELECT ${VERSION_COLUMNS}, json_build_object(
      'regType', t.reg_type, 'number', t.number, 'year', t.year, 'titleId', t.title_id, 'titleEn', t.title_en,
      'issuer', t.issuer, 'status', t.status, 'promulgatedOn', t.promulgated_on, 'effectiveOn', t.effective_on,
      'endsOn', t.ends_on, 'officialUrl', t.official_url, 'bpkStatusUrl', t.bpk_status_url,
      'relations', COALESCE((SELECT json_agg(json_build_object('relation', r.relation, 'regulationId', r.to_regulation_id)
                                             ORDER BY r.relation, r.to_regulation_id)
                               FROM ecr.regulation_relation r WHERE r.regulation_row_id = t.id), '[]'::json),
      'documents', COALESCE((SELECT json_agg(json_build_object('sourceDocumentId', d.source_document_id, 'role', d.role)
                                             ORDER BY d.role, d.source_document_id)
                               FROM ecr.regulation_document d WHERE d.regulation_row_id = t.id), '[]'::json)
    ) AS data
    FROM ecr.regulation t`,

  async parse(input, q) {
    const f = new Fields(input);
    const d: RegulationData = {
      regType: f.oneOf('regType', REG_TYPES),
      number: f.text('number', 50),
      year: f.int('year', 1945, 2100),
      titleId: f.text('titleId', 2000),
      titleEn: f.optText('titleEn', 2000),
      issuer: f.text('issuer', 200),
      status: f.oneOf('status', REG_STATUSES),
      promulgatedOn: f.optDate('promulgatedOn'),
      effectiveOn: f.optDate('effectiveOn'),
      endsOn: f.optDate('endsOn'),
      officialUrl: f.optText('officialUrl', 1000),
      bpkStatusUrl: f.optText('bpkStatusUrl', 1000),
      relations: [],
      documents: [],
    };
    // US-20-N1 AC2: an end date before the effective date is blocked (effective before promulgation is a warning).
    if (d.endsOn && d.effectiveOn && d.endsOn < d.effectiveOn) f.fail('endsOn', 'The end date is before the effective date.');
    if (d.officialUrl) {
      const publisher = await publisherForUrl(q, d.officialUrl);
      if (!publisher?.isOfficial) f.fail('officialUrl', 'Use the page on an official publisher (see Source publishers).');
    }
    if (d.bpkStatusUrl && urlHost(d.bpkStatusUrl) !== 'peraturan.bpk.go.id') {
      f.fail('bpkStatusUrl', 'Use the regulation page on peraturan.bpk.go.id.');
    }

    const seen = new Set<string>();
    f.list('relations', 50).forEach((r, i) => {
      const rf = f.nested('relations', i, r);
      const rel = { relation: rf.oneOf('relation', REG_RELATIONS), regulationId: rf.optUuid('regulationId') };
      if (!rel.regulationId) return rf.fail('regulationId', 'Choose the regulation.');
      const key = `${rel.relation}:${rel.regulationId}`;
      if (seen.has(key)) return rf.fail('regulationId', 'Listed twice.');
      seen.add(key);
      d.relations.push({ relation: rel.relation, regulationId: rel.regulationId });
    });

    const docIds = new Set<string>();
    f.list('documents', 50).forEach((doc, i) => {
      const df = f.nested('documents', i, doc);
      const id = df.optUuid('sourceDocumentId');
      const role = df.oneOf('role', DOC_ROLES);
      if (!id) return df.fail('sourceDocumentId', 'Choose an uploaded document.');
      if (docIds.has(id)) return df.fail('sourceDocumentId', 'Listed twice.');
      docIds.add(id);
      d.documents.push({ sourceDocumentId: id, role });
    });
    if (docIds.size) {
      const { rows } = await q.query<{ id: string }>('SELECT id FROM ecr.source_document WHERE id = ANY($1::uuid[])', [[...docIds]]);
      const found = new Set(rows.map((r) => r.id));
      d.documents.forEach((doc, i) => {
        if (!found.has(doc.sourceDocumentId)) f.fail(`documents[${i}].sourceDocumentId`, 'Document not found.');
      });
    }
    d.relations.sort((a, b) => (a.relation + a.regulationId).localeCompare(b.relation + b.regulationId));
    d.documents.sort((a, b) => (a.role + a.sourceDocumentId).localeCompare(b.role + b.sourceDocumentId));
    f.throwIfAny();
    return d;
  },

  validity: (d) => ({ validFrom: d.effectiveOn ?? d.promulgatedOn, validTo: d.endsOn }),
  withEndDate: (d, date) => ({ ...d, endsOn: date }),
  label: regulationLabel,
  naturalKey: (d) => `${d.regType}-${d.number.toUpperCase()}-${d.year}`,

  async insertRow(q, base, d) {
    const [validFrom, validTo] = validityParams(regulationDef.validity(d));
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO ecr.regulation
         (entity_id, valid_from, valid_to, version_from, change_set_id, reg_type, number, year, title_id, title_en,
          issuer, status, promulgated_on, effective_on, ends_on, official_url, bpk_status_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
      [base.entityId, validFrom, validTo, base.versionNo, base.changeSetId, d.regType, d.number, d.year, d.titleId, d.titleEn,
       d.issuer, d.status, d.promulgatedOn, d.effectiveOn, d.endsOn, d.officialUrl, d.bpkStatusUrl],
    );
    const rowId = rows[0].id;
    for (const r of d.relations) {
      await q.query('INSERT INTO ecr.regulation_relation (regulation_row_id, relation, to_regulation_id) VALUES ($1, $2, $3)',
        [rowId, r.relation, r.regulationId]);
    }
    for (const doc of d.documents) {
      await q.query('INSERT INTO ecr.regulation_document (regulation_row_id, source_document_id, role) VALUES ($1, $2, $3)',
        [rowId, doc.sourceDocumentId, doc.role]);
    }
  },
};

// ---------------------------------------------------------------- commodity and group

const commodityDef: EntityDef<CommodityData> = {
  type: 'COMMODITY',
  table: 'commodity',
  fields: ['code', 'nameId', 'nameEn', 'isInScope', 'validFrom', 'validTo'],
  select: `
    SELECT ${VERSION_COLUMNS}, json_build_object(
      'code', t.code, 'nameId', t.name_id, 'nameEn', t.name_en, 'isInScope', t.is_in_scope,
      'validFrom', CASE WHEN isfinite(t.valid_from) THEN t.valid_from END, 'validTo', t.valid_to - 1
    ) AS data
    FROM ecr.commodity t`,

  async parse(input) {
    const f = new Fields(input);
    const code = (f.text('code', 20) || '').toUpperCase();
    if (code && !/^[A-Z0-9_-]{2,20}$/.test(code)) f.fail('code', '2–20 letters, digits, "-" or "_".');
    const d: CommodityData = {
      code,
      nameId: f.text('nameId', 200),
      nameEn: f.optText('nameEn', 200),
      isInScope: f.bool('isInScope', true),
      validFrom: f.optDate('validFrom'),
      validTo: f.optDate('validTo'),
    };
    checkRange(f, d);
    f.throwIfAny();
    return d;
  },

  validity: (d) => ({ validFrom: d.validFrom, validTo: d.validTo }),
  withEndDate: (d, date) => ({ ...d, validTo: date }),
  label: (d) => `${d.code} — ${d.nameId}`,
  naturalKey: (d) => d.code,

  async insertRow(q, base, d) {
    const [validFrom, validTo] = validityParams(d);
    await q.query(
      `INSERT INTO ecr.commodity (entity_id, valid_from, valid_to, version_from, change_set_id, code, name_id, name_en, is_in_scope)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [base.entityId, validFrom, validTo, base.versionNo, base.changeSetId, d.code, d.nameId, d.nameEn, d.isInScope],
    );
  },
};

const groupDef: EntityDef<GroupData> = {
  type: 'PRODUCT_GROUP',
  table: 'product_group',
  fields: ['commodityId', 'code', 'label', 'ordinal', 'validFrom', 'validTo'],
  select: `
    SELECT ${VERSION_COLUMNS}, json_build_object(
      'commodityId', t.commodity_entity_id, 'code', t.code, 'label', t.label, 'ordinal', t.ordinal,
      'validFrom', CASE WHEN isfinite(t.valid_from) THEN t.valid_from END, 'validTo', t.valid_to - 1
    ) AS data
    FROM ecr.product_group t`,

  async parse(input) {
    const f = new Fields(input);
    const d: GroupData = {
      commodityId: f.optUuid('commodityId'),
      code: f.text('code', 20),
      label: f.text('label', 200),
      ordinal: f.int('ordinal', 0, 10_000),
      validFrom: f.optDate('validFrom'),
      validTo: f.optDate('validTo'),
    };
    if (!d.commodityId) f.fail('commodityId', 'Choose the commodity.');
    checkRange(f, d);
    f.throwIfAny();
    return d;
  },

  validity: (d) => ({ validFrom: d.validFrom, validTo: d.validTo }),
  withEndDate: (d, date) => ({ ...d, validTo: date }),
  label: (d) => d.label,
  naturalKey: () => null,

  async insertRow(q, base, d) {
    const [validFrom, validTo] = validityParams(d);
    await q.query(
      `INSERT INTO ecr.product_group (entity_id, valid_from, valid_to, version_from, change_set_id, commodity_entity_id, code, label, ordinal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [base.entityId, validFrom, validTo, base.versionNo, base.changeSetId, d.commodityId, d.code, d.label, d.ordinal],
    );
  },
};

// ---------------------------------------------------------------- product

const productDef: EntityDef<ProductData> = {
  type: 'PRODUCT',
  table: 'product',
  fields: ['groupId', 'itemNoAsPrinted', 'nameId', 'nameEn', 'synonyms', 'definition', 'notes', 'annexPage',
    'classificationRegulationId', 'validFrom', 'validTo', 'fxOnPebDate', 'otherObligationsNote', 'parameters', 'hsCodes'],
  select: `
    SELECT ${VERSION_COLUMNS}, json_build_object(
      'groupId', t.group_entity_id, 'itemNoAsPrinted', t.item_no_as_printed, 'nameId', t.name_id, 'nameEn', t.name_en,
      'synonyms', to_json(t.synonyms), 'definition', t.definition, 'notes', to_json(t.notes), 'annexPage', t.annex_page,
      'classificationRegulationId', t.classification_regulation_id,
      'validFrom', t.valid_from, 'validTo', t.valid_to - 1, 'fxOnPebDate', t.fx_on_peb_date,
      'otherObligationsNote', t.other_obligations_note,
      'parameters', COALESCE((SELECT json_agg(json_build_object(
                                 'name', p.name, 'operator', p.operator, 'valueText', p.value_text, 'valueMin', p.value_min,
                                 'valueMax', p.value_max, 'unit', p.unit, 'isPrimary', p.is_primary) ORDER BY p.ordinal)
                                FROM ecr.product_parameter p WHERE p.product_row_id = t.id), '[]'::json),
      'hsCodes', COALESCE((SELECT json_agg(json_build_object(
                              'hsCodeId', h.hs_code_id, 'code', c.code, 'isEx', h.is_ex, 'exDescription', h.ex_description)
                              ORDER BY c.code_digits)
                             FROM ecr.product_hs_code h JOIN ecr.hs_code c ON c.id = h.hs_code_id
                            WHERE h.product_row_id = t.id), '[]'::json)
    ) AS data
    FROM ecr.product t`,

  async parse(input, q) {
    const f = new Fields(input);
    const d: ProductData = {
      groupId: f.optUuid('groupId'),
      itemNoAsPrinted: f.optText('itemNoAsPrinted', 20),
      nameId: f.text('nameId', 500),
      nameEn: f.optText('nameEn', 500),
      synonyms: f.textList('synonyms', 50, 200),
      definition: f.optText('definition', 5000),
      notes: f.textList('notes', 50, 2000),
      annexPage: f.optInt('annexPage', 1, 10_000),
      classificationRegulationId: f.optUuid('classificationRegulationId'),
      validFrom: f.optDate('validFrom'),
      validTo: f.optDate('validTo'),
      fxOnPebDate: f.bool('fxOnPebDate', false),
      otherObligationsNote: f.optText('otherObligationsNote', 2000),
      parameters: [],
      hsCodes: [],
    };
    checkRange(f, d);

    f.list('parameters', 50).forEach((p, i) => {
      const pf = f.nested('parameters', i, p);
      const param: ProductParameter = {
        name: pf.text('name', 200),
        operator: pf.oneOf('operator', PARAM_OPERATORS),
        valueText: pf.text('valueText', 500),
        valueMin: pf.optNumber('valueMin'),
        valueMax: pf.optNumber('valueMax'),
        unit: pf.optText('unit', 50),
        isPrimary: pf.bool('isPrimary', false),
      };
      if (param.valueMin !== null && param.valueMax !== null && param.valueMin > param.valueMax) {
        pf.fail('valueMax', 'Upper bound is below the lower bound.');
      }
      d.parameters.push(param);
    });
    if (d.parameters.filter((p) => p.isPrimary).length > 1) f.fail('parameters', 'Mark only one parameter as the key spec.');

    // US-24-P1 / US-24-N1: explicit 8-digit codes from the current BTKI version, each once, ex-codes described.
    const wanted: { index: number; digits: string; isEx: boolean; exDescription: string | null }[] = [];
    f.list('hsCodes', 30).forEach((h, i) => {
      const hf = f.nested('hsCodes', i, h);
      const raw = hf.text('code', 100);
      const digits = normaliseHs(raw);
      const isEx = hf.bool('isEx', false);
      const exDescription = hf.optText('exDescription', 1000);
      if (raw && !digits) return hf.fail('code', 'Enter explicit 8-digit HS codes.');
      if (isEx && !exDescription) hf.fail('exDescription', 'An ex-code needs the qualifying description.');
      if (digits && wanted.some((w) => w.digits === digits)) return hf.fail('code', 'This HS code is already listed.');
      if (digits) wanted.push({ index: i, digits, isEx, exDescription: isEx ? exDescription : null });
    });
    if (wanted.length) {
      const { rows } = await q.query<{ id: string; code: string; code_digits: string; label: string }>(
        `SELECT c.id, c.code, c.code_digits, v.label FROM ecr.hs_code c JOIN ecr.btki_version v ON v.id = c.btki_version_id
          WHERE v.is_current AND c.code_digits = ANY($1)`,
        [wanted.map((w) => w.digits)],
      );
      const byDigits = new Map(rows.map((r) => [r.code_digits, r]));
      for (const w of wanted) {
        const hit = byDigits.get(w.digits);
        if (!hit) {
          f.fail(`hsCodes[${w.index}].code`, `${w.digits.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1.$2.$3')} is not in the current BTKI version.`);
          continue;
        }
        d.hsCodes.push({ hsCodeId: hit.id, code: hit.code, isEx: w.isEx, exDescription: w.exDescription });
      }
      d.hsCodes.sort((a, b) => a.code.localeCompare(b.code));
    }
    f.throwIfAny();
    return d;
  },

  validity: (d) => ({ validFrom: d.validFrom, validTo: d.validTo }),
  withEndDate: (d, date) => ({ ...d, validTo: date }),
  label: (d) => (d.itemNoAsPrinted ? `${d.itemNoAsPrinted}. ${d.nameId}` : d.nameId),
  naturalKey: () => null,

  async insertRow(q, base, d) {
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO ecr.product
         (entity_id, valid_from, valid_to, version_from, change_set_id, group_entity_id, item_no_as_printed, name_id, name_en,
          synonyms, definition, notes, annex_page, classification_regulation_id, fx_on_peb_date, other_obligations_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
      [base.entityId, d.validFrom, d.validTo ? addDays(d.validTo, 1) : null, base.versionNo, base.changeSetId, d.groupId,
       d.itemNoAsPrinted, d.nameId, d.nameEn, d.synonyms, d.definition, d.notes, d.annexPage, d.classificationRegulationId,
       d.fxOnPebDate, d.otherObligationsNote],
    );
    const rowId = rows[0].id;
    for (const [i, p] of d.parameters.entries()) {
      await q.query(
        `INSERT INTO ecr.product_parameter (product_row_id, ordinal, name, operator, value_text, value_min, value_max, unit, is_primary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [rowId, i + 1, p.name, p.operator, p.valueText, p.valueMin, p.valueMax, p.unit, p.isPrimary],
      );
    }
    for (const h of d.hsCodes) {
      await q.query('INSERT INTO ecr.product_hs_code (product_row_id, hs_code_id, is_ex, ex_description) VALUES ($1, $2, $3, $4)',
        [rowId, h.hsCodeId, h.isEx, h.exDescription]);
    }
  },
};

export const ENTITY_DEFS: Record<EntityType, EntityDef> = {
  REGULATION: regulationDef as EntityDef,
  COMMODITY: commodityDef as EntityDef,
  PRODUCT_GROUP: groupDef as EntityDef,
  PRODUCT: productDef as EntityDef,
  ...TARIFF_DEFS,
};

export function entityDef(type: string): EntityDef {
  const def = ENTITY_DEFS[type as EntityType];
  if (!def) throw new ApiError(400, 'INVALID_INPUT', `entityType must be one of ${ENTITY_TYPES.join(', ')}.`);
  return def;
}

export interface VersionRow<T extends EntityData = EntityData> {
  rowId: string;
  entityId: string;
  versionFrom: number;
  versionTo: number | null;
  changeSetId: string;
  data: T;
}

interface RawRow {
  row_id: string;
  entity_id: string;
  version_from: number;
  version_to: number | null;
  change_set_id: string;
  data: EntityData;
}

function toVersionRow<T extends EntityData>(r: RawRow): VersionRow<T> {
  return { rowId: r.row_id, entityId: r.entity_id, versionFrom: r.version_from, versionTo: r.version_to, changeSetId: r.change_set_id, data: r.data as T };
}

/** Current (latest published) versions, optionally only for some entity ids. */
export async function loadCurrent<T extends EntityData>(q: Queryable, type: EntityType, entityIds?: string[]): Promise<Map<string, VersionRow<T>>> {
  const def = ENTITY_DEFS[type];
  const { rows } = entityIds
    ? await q.query<RawRow>(`${def.select} WHERE t.version_to IS NULL AND t.entity_id = ANY($1::uuid[])`, [entityIds])
    : await q.query<RawRow>(`${def.select} WHERE t.version_to IS NULL`);
  return new Map(rows.map((r) => [r.entity_id, toVersionRow<T>(r)]));
}

/**
 * Versions that were current in data version `version` (Technical Design §4.3.1: version_from ≤ V < version_to),
 * so any past answer can be reproduced exactly.
 */
export async function loadAtVersion<T extends EntityData>(q: Queryable, type: EntityType, version: number): Promise<Map<string, VersionRow<T>>> {
  const { rows } = await q.query<RawRow>(
    `${ENTITY_DEFS[type].select} WHERE t.version_from <= $1 AND (t.version_to IS NULL OR t.version_to > $1)`,
    [version],
  );
  const map = new Map(rows.map((r) => [r.entity_id, toVersionRow<T>(r)]));
  // Exactly one version of each record is current in any data version; anything else is corrupt history.
  if (map.size !== rows.length) throw new Error(`${type}: more than one row version current in data version ${version}`);
  return map;
}

/** Every published version of one record, oldest first. */
export async function loadHistory<T extends EntityData>(q: Queryable, type: EntityType, entityId: string): Promise<VersionRow<T>[]> {
  const { rows } = await q.query<RawRow>(`${ENTITY_DEFS[type].select} WHERE t.entity_id = $1 ORDER BY t.version_from`, [entityId]);
  return rows.map((r) => toVersionRow<T>(r));
}
