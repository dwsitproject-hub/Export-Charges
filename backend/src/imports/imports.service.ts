import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { ApiError } from '../common/api-error';
import { UUID_RE, wibToday } from '../common/fields';
import { DbService, Queryable } from '../db/db.service';
import { wibDateTime } from '../exports/present';
import { Cell, toWorkbook, toXlsx } from '../exports/tabular';
import { CandidateState } from '../registry/candidate';
import {
  CommodityData, ENTITY_DEFS, EntityData, EntityType, GroupData, loadCurrent, ProductData, ProductParameter, regulationLabel, RegulationData,
} from '../registry/entities';
import type { MalwareScanner, ObjectStore } from '../registry/file-handling';
import { MALWARE_SCANNER, OBJECT_STORE } from '../registry/source-documents.service';
import { validateItems } from '../registry/validation';
import type { BandTableData, RefSeriesData, ScheduleData, ScheduleLineData } from '../tariffs/tariff-entities';
import { ColumnDef, LINES, MAX_IMPORT_BYTES, MAX_ROWS, PRICES, PRODUCTS, SheetDef, SHEETS, TEMPLATE_VERSION } from './template';
import { readWorkbook, Workbook, XlsxCell, XlsxError } from './xlsx-reader';

export interface ReportEntry {
  sheet: string;
  row: number | null;
  column: string | null;
  field: string | null;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  code: string;
  message: string;
}

interface ImportItem {
  entityType: EntityType;
  entityId: string;
  operation: 'CREATE' | 'UPDATE';
  baseRowId: string | null;
  before: EntityData | null;
  after: EntityData;
  importRow: string;
}

interface DryRun {
  rowCount: number;
  report: ReportEntry[];
  items: ImportItem[];
}

interface JobRow {
  id: string;
  uploaded_by: string;
  file_name: string;
  file_object_key: string;
  file_sha256: Buffer;
  byte_size: number;
  scan_result: string;
  template_version: string;
  status: string;
  row_count: number;
  error_count: number;
  warning_count: number;
  report: ReportEntry[];
  change_set_id: string | null;
  created_at: Date;
  committed_at: Date | null;
}

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  size: number;
}

/** Where each API field of a record is entered, per sheet, for the row-level report. */
const FIELD_COLUMN: Record<string, Record<string, string>> = {
  PRODUCT: {
    groupId: 'group', itemNoAsPrinted: 'itemNo', nameId: 'nameId', nameEn: 'nameEn', synonyms: 'synonyms', definition: 'definition',
    notes: 'notes', classificationRegulationId: 'regulation', validFrom: 'validFrom', validTo: 'validTo', fxOnPebDate: 'fxOnPebDate',
    parameters: 'specValue', hsCodes: 'hsCodes', exDescription: 'exDescription',
  },
  SCHEDULE_LINE: {
    scheduleId: 'annex', kelompok: 'kelompok', itemNo: 'itemNo', uraian: 'uraian', basisType: 'basis', pct: 'pct', usdPerMt: 'usdPerMt',
    refSeriesId: 'series', bandTableId: 'bandTable', bandValues: 'bandValues', productIds: 'products', validFrom: 'validFrom', validTo: 'validTo',
  },
  REF_VALUE: { seriesId: 'series', periodFrom: 'periodFrom', periodTo: 'periodTo', value: 'value', sourceReference: 'decree', sourceDocumentId: 'document' },
};

const fold = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const list = (s: string) => s.split(';').map((x) => x.trim()).filter(Boolean);
const OPERATOR: Record<string, string> = { '<': '<', '<=': '≤', '≤': '≤', '=': '=', '>=': '≥', '≥': '≥', '>': '>', RANGE: 'RANGE', TEXT: 'TEXT' };

/** A number as written by a spreadsheet, without binary noise such as 950.2700000000001. */
function numberText(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return String(Number(n.toPrecision(15)));
}

/** YYYY-MM-DD from ISO text, DD/MM/YYYY, or an Excel date serial (1900 system). */
function dateText(cell: XlsxCell): string | null {
  if (cell.kind === 'number') {
    const days = Math.floor(Number(cell.value));
    if (!Number.isFinite(days) || days < 1 || days > 200_000) return null;
    return new Date(Date.UTC(1899, 11, 30) + days * 86_400_000).toISOString().slice(0, 10);
  }
  const v = cell.value.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(v);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

/** One data row of a sheet with its columns found by header. */
class SheetRow {
  constructor(
    readonly sheet: SheetDef,
    readonly row: number,
    private readonly cells: Map<string, XlsxCell>,
    private readonly letters: Map<string, string>,
    private readonly report: (e: Omit<ReportEntry, 'sheet' | 'row'>) => void,
  ) {}

  letter(key: string): string | null {
    return this.letters.get(key) ?? null;
  }

  header(key: string): string | null {
    return this.sheet.columns.find((c) => c.key === key)?.header ?? null;
  }

  error(key: string | null, code: string, message: string, severity: ReportEntry['severity'] = 'ERROR') {
    this.report({ column: key ? this.letter(key) : null, field: key ? this.header(key) : null, severity, code, message });
  }

  cell(key: string): XlsxCell | undefined {
    const letter = this.letters.get(key);
    return letter ? this.cells.get(letter) : undefined;
  }

  text(key: string): string {
    const c = this.cell(key);
    if (!c) return '';
    return (c.kind === 'number' ? numberText(c.value) : c.value).trim();
  }

  date(key: string): string | null {
    const c = this.cell(key);
    if (!c || !c.value.trim()) return null;
    const d = dateText(c);
    if (!d) this.error(key, 'DATE', 'Enter a date as YYYY-MM-DD.');
    return d;
  }
}

/** Excel bulk import (PRD F-28, FR-IMP-01; Technical Design §4.2.3). */
@Injectable()
export class ImportsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
  ) {}

  // ------------------------------------------------------------------ template

  /** The current template with the codes it accepts listed on a reference sheet. */
  async template(): Promise<Buffer> {
    const state = await CandidateState.load(this.db.pool);
    const about: Cell[][] = [
      ['ECR import template'],
      ['Template version', TEMPLATE_VERSION],
      ['How it works', 'Fill the sheets you need and leave the others empty. Upload the file: ECR checks every row and the rules for the '
        + 'whole set (dry run) and saves nothing. When there are no errors, create the change set; it is reviewed like any other.'],
      ['Rules', 'Values only: formula cells and text starting with =, +, - or @ are refused. At most 10 MB and 5,000 rows per sheet. '
        + 'Do not rename sheets or headers.'],
      [],
      ['Sheet', 'Column', 'Required', 'What to enter'],
      ...SHEETS.flatMap((s) => [
        [s.name, '', '', s.purpose] as Cell[],
        ...s.columns.map((c): Cell[] => ['', c.header, c.required ? 'Yes' : '', c.help]),
      ]),
    ];
    const commodities = new Map(state.ofType<CommodityData>('COMMODITY').map((c) => [c.id, c.data.code]));
    const lists: Cell[][] = [
      ['Kind', 'Code or label', 'Details', 'ECR id'],
      ...state.ofType<GroupData>('PRODUCT_GROUP').map((g): Cell[] => ['Group', `${commodities.get(g.data.commodityId ?? '') ?? '?'} ${g.data.code}`, g.data.label, g.id]),
      ...state.ofType<RegulationData>('REGULATION').map((r): Cell[] => ['Regulation', regulationLabel(r.data), r.data.titleId, r.id]),
      ...state.ofType<ScheduleData>('SCHEDULE').map((s): Cell[] => {
        const reg = state.get<RegulationData>(s.data.regulationId, 'REGULATION');
        return ['Schedule', `${reg ? regulationLabel(reg) : '?'} · ${s.data.chargeType} · ${s.data.annexLabel}`, '', s.id];
      }),
      ...state.ofType<RefSeriesData>('REF_SERIES').map((s): Cell[] => ['Series', s.data.code, `${s.data.name} (${s.data.unit})`, s.id]),
      ...state.ofType<BandTableData>('BAND_TABLE').map((t): Cell[] => ['Band table', t.data.code, `${t.data.bands.length} bands`, t.id]),
      ...state.ofType<ProductData>('PRODUCT').map((p): Cell[] => ['Product', p.data.nameId, p.data.hsCodes.map((h) => h.code).join('; '), p.id]),
    ];
    return toWorkbook([
      { name: 'About', rows: about, boldRows: [1, 6], widths: [16, 26, 10, 100] },
      ...SHEETS.map((s) => ({ name: s.name, rows: [s.columns.map((c) => c.header)], headerRow: 1, boldRows: [1], widths: s.columns.map((c) => c.width ?? 16) })),
      { name: 'Lists', rows: lists, headerRow: 1, boldRows: [1], widths: [12, 40, 40, 38] },
    ]);
  }

  // ------------------------------------------------------------------ upload and dry run

  async upload(actor: Actor, file: UploadedFile | undefined) {
    if (!file?.buffer?.length) throw new ApiError(400, 'INVALID_INPUT', 'Choose an .xlsx file.', { fields: [{ field: 'file', message: 'Choose an .xlsx file.' }] });
    const body = file.buffer;
    const name = file.originalname.slice(0, 255);
    if (body.length > MAX_IMPORT_BYTES) return this.reject(actor, name, 'FILE_TOO_LARGE', 'The file is larger than 10 MB.');
    if (!/\.xlsx$/i.test(name) || body.readUInt32LE(0) !== 0x04034b50) return this.reject(actor, name, 'FILE_REJECTED', 'Upload an Excel workbook (.xlsx).');
    const scan = await this.scanner.scan(body);
    if (scan.verdict === 'INFECTED') return this.reject(actor, name, 'FILE_REJECTED', 'The file failed the virus scan.', scan.signature);

    let book: Workbook;
    try {
      book = readWorkbook(body);
    } catch (err) {
      if (err instanceof XlsxError) return this.reject(actor, name, 'FILE_REJECTED', err.message);
      throw err;
    }
    // US-28-N1 AC2: an outdated template is refused with a link to the current one.
    const version = book.get('About')?.get(2)?.get('B')?.value.trim() ?? '';
    if (version !== TEMPLATE_VERSION) {
      return this.reject(actor, name, 'TEMPLATE_OUTDATED',
        `This file is not made from the current import template (${TEMPLATE_VERSION}). Download the template and copy your rows into it.`,
        undefined, { templateUrl: '/api/imports/template', found: version || null });
    }

    const run = await this.db.tx((client) => this.dryRun(client, book));
    const sha = createHash('sha256').update(body).digest();
    const key = `imports/${new Date().getUTCFullYear()}/${sha.toString('hex')}.xlsx`;
    await this.store.put(key, body);
    const errors = run.report.filter((r) => r.severity === 'ERROR').length;
    const warnings = run.report.filter((r) => r.severity === 'WARNING').length;
    const id = await this.db.tx(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO ecr.import_job (uploaded_by, file_name, file_object_key, file_sha256, byte_size, scan_result, template_version, status,
                                     row_count, error_count, warning_count, report)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [actor.id, name, key, sha, body.length, scan.verdict, version, errors ? 'VALIDATED_WITH_ERRORS' : 'VALIDATED', run.rowCount, errors, warnings,
         JSON.stringify(run.report)],
      );
      await this.record(client, actor, 'IMPORT_VALIDATED', rows[0].id, { after: { file: name, sha256: sha.toString('hex'), rows: run.rowCount, errors, warnings } });
      return rows[0].id;
    });
    return this.get(actor, id);
  }

  /**
   * Reads every row into change items and checks them (PRD L2-3.6 step 3): each row through the same parser as the
   * editors, then the whole set through the change-set validation. Nothing is written.
   */
  private async dryRun(client: PoolClient, book: Workbook): Promise<DryRun> {
    const report: ReportEntry[] = [];
    const items: ImportItem[] = [];
    const state = await CandidateState.load(client);
    let rowCount = 0;

    // Lookups in the published data.
    const commodityByCode = new Map(state.ofType<CommodityData>('COMMODITY').map((c) => [c.data.code.toUpperCase(), c.id]));
    const groups = state.ofType<GroupData>('PRODUCT_GROUP');
    const regulationByLabel = new Map<string, string>();
    for (const r of state.ofType<RegulationData>('REGULATION')) {
      regulationByLabel.set(fold(regulationLabel(r.data)), r.id);
      regulationByLabel.set(fold(ENTITY_DEFS.REGULATION.naturalKey(r.data) ?? ''), r.id);
    }
    const seriesByCode = new Map(state.ofType<RefSeriesData>('REF_SERIES').map((s) => [s.data.code.toUpperCase(), s.id]));
    const bandTableByCode = new Map(state.ofType<BandTableData>('BAND_TABLE').map((t) => [t.data.code.toUpperCase(), t.id]));
    const schedules = state.ofType<ScheduleData>('SCHEDULE');

    const rowsOf = (def: SheetDef): SheetRow[] => {
      const sheet = book.get(def.name);
      if (!sheet) return [];
      const header = sheet.get(1) ?? new Map<string, XlsxCell>();
      const letters = new Map<string, string>();
      for (const [letter, cell] of header) {
        const col = def.columns.find((c) => fold(c.header) === fold(cell.value));
        if (col) letters.set(col.key, letter);
      }
      const dataRows = [...sheet.keys()].filter((n) => n > 1).sort((a, b) => a - b)
        .filter((n) => [...sheet.get(n)!.values()].some((c) => c.value.trim() || c.formula));
      if (!dataRows.length) return [];
      const missing = def.columns.filter((c) => c.required && !letters.has(c.key));
      for (const c of missing) report.push({ sheet: def.name, row: 1, column: null, field: c.header, severity: 'ERROR', code: 'HEADER_MISSING', message: `Column "${c.header}" is missing.` });
      if (missing.length) return [];
      if (dataRows.length > MAX_ROWS) {
        report.push({ sheet: def.name, row: null, column: null, field: null, severity: 'ERROR', code: 'TOO_MANY_ROWS', message: `At most ${MAX_ROWS} rows per sheet.` });
        return [];
      }
      rowCount += dataRows.length;
      return dataRows.map((n) => {
        const cells = sheet.get(n)!;
        const row = new SheetRow(def, n, cells, letters, (e) => report.push({ sheet: def.name, row: n, ...e }));
        // US-28-N1 AC3: values only; text that a spreadsheet could run as a formula is refused.
        for (const [letter, cell] of cells) {
          const col = def.columns.find((c) => letters.get(c.key) === letter);
          if (cell.formula) report.push({ sheet: def.name, row: n, column: letter, field: col?.header ?? null, severity: 'ERROR', code: 'FORMULA', message: 'Formula cells are not accepted; paste the value instead.' });
          else if (cell.kind === 'text' && /^[=+\-@]/.test(cell.value.trim())) {
            report.push({ sheet: def.name, row: n, column: letter, field: col?.header ?? null, severity: 'ERROR', code: 'FORMULA_TEXT', message: 'Text starting with =, +, - or @ is not accepted.' });
          }
        }
        return row;
      });
    };
    const rowFailed = (r: SheetRow) => report.some((e) => e.sheet === r.sheet.name && e.row === r.row && e.severity === 'ERROR');

    /** Runs the editor's parser; its field errors become report entries on the right column. */
    const parse = async (r: SheetRow, type: EntityType, input: Record<string, unknown>): Promise<EntityData | null> => {
      try {
        return await ENTITY_DEFS[type].parse(input, client);
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== 'INVALID_INPUT') throw err;
        const fields = (err.details?.fields as { field: string; message: string }[] | undefined) ?? [{ field: '', message: err.message }];
        for (const f of fields) {
          const leaf = /\.(\w+)$/.exec(f.field)?.[1];
          const root = f.field.split(/[.[]/)[0];
          const key = (leaf && FIELD_COLUMN[type][leaf]) ?? FIELD_COLUMN[type][root] ?? null;
          // A column already reported (e.g. a code that did not resolve) is not reported twice.
          const column = key ? r.letter(key) : null;
          if (column && report.some((e) => e.sheet === r.sheet.name && e.row === r.row && e.column === column)) continue;
          r.error(key, 'INVALID', f.message);
        }
        return null;
      }
    };
    const lockedBy = async (type: EntityType, entityId: string) => {
      const { rows } = await client.query<{ title: string }>(
        `SELECT cs.title FROM ecr.change_item i JOIN ecr.change_set cs ON cs.id = i.change_set_id
          WHERE i.entity_type = $1 AND i.entity_id = $2 AND i.is_open`,
        [type, entityId],
      );
      return rows[0]?.title ?? null;
    };
    const newIds = async (n: number) =>
      n ? (await client.query<{ id: string }>('SELECT uuidv7()::text AS id FROM generate_series(1, $1)', [n])).rows.map((r) => r.id) : [];
    /** A published record to change: the id must exist and not be open in another change set. */
    const target = async (r: SheetRow, type: EntityType, seen: Set<string>) => {
      const raw = r.text('id');
      if (!raw) return null;
      if (!UUID_RE.test(raw)) {
        r.error('id', 'INVALID', 'Not an ECR id.');
        return undefined;
      }
      const id = raw.toLowerCase();
      if (seen.has(id)) {
        r.error('id', 'DUPLICATE', 'This record appears twice in the file.');
        return undefined;
      }
      seen.add(id);
      const current = (await loadCurrent(client, type, [id])).get(id);
      if (!current) {
        r.error('id', 'NOT_FOUND', 'No published record with this id.');
        return undefined;
      }
      const holder = await lockedBy(type, id);
      if (holder) {
        r.error('id', 'ENTITY_LOCKED', `This record is being edited in change set “${holder}”.`);
        return undefined;
      }
      return current;
    };

    // ------------------------------------------------------------ Products
    const productRows = rowsOf(PRODUCTS);
    const productByKey = new Map<string, string>();
    const productIds = await newIds(productRows.length);
    const seenProducts = new Set<string>();
    for (const [index, r] of productRows.entries()) {
      const key = r.text('key');
      if (!key) r.error('key', 'REQUIRED', 'Give the row a key.');
      else if (productByKey.has(fold(key))) r.error('key', 'DUPLICATE', 'This row key is used twice.');
      const current = await target(r, 'PRODUCT', seenProducts);
      const entityId = current ? current.entityId : productIds[index];
      if (key && !productByKey.has(fold(key))) productByKey.set(fold(key), entityId);
      if (current === undefined) continue;

      const base = (current ? structuredClone(current.data) : {
        synonyms: [], notes: [], parameters: [], hsCodes: [], fxOnPebDate: false,
      }) as Record<string, unknown> & Partial<ProductData>;
      const input: Record<string, unknown> = { ...base };
      const set = (field: string, col: string) => {
        const v = r.text(col);
        if (v) input[field] = v;
      };
      set('itemNoAsPrinted', 'itemNo');
      set('nameId', 'nameId');
      set('nameEn', 'nameEn');
      set('definition', 'definition');
      if (r.text('synonyms')) input.synonyms = list(r.text('synonyms'));
      if (r.text('notes')) input.notes = list(r.text('notes'));

      const groupCode = r.text('group');
      if (groupCode) {
        const commodity = r.text('commodity');
        const commodityId = commodity ? commodityByCode.get(commodity.toUpperCase()) : null;
        if (commodity && !commodityId) r.error('commodity', 'NOT_FOUND', `No commodity with code ${commodity}.`);
        const hits = groups.filter((g) => g.data.code.toUpperCase() === groupCode.toUpperCase() && (!commodityId || g.data.commodityId === commodityId));
        if (hits.length === 1) input.groupId = hits[0].id;
        else if (!commodity || commodityId) r.error('group', hits.length ? 'AMBIGUOUS' : 'NOT_FOUND', hits.length ? 'Several commodities have this group; fill Commodity.' : `No group ${groupCode}.`);
      }
      const regulation = r.text('regulation');
      if (regulation) {
        const id = regulationByLabel.get(fold(regulation));
        if (id) input.classificationRegulationId = id;
        else r.error('regulation', 'NOT_FOUND', `${regulation} is not registered.`);
      }
      const hs = r.text('hsCodes');
      if (hs) {
        const exDescription = r.text('exDescription') || null;
        input.hsCodes = hs.split(/[;,]/).map((x) => x.trim()).filter(Boolean).map((code) => {
          const isEx = /^ex\s+/i.test(code);
          return { code: code.replace(/^ex\s+/i, ''), isEx, exDescription: isEx ? exDescription : null };
        });
      }
      const specName = r.text('specName');
      const specValue = r.text('specValue');
      if (specName || specValue) {
        const operator = OPERATOR[(r.text('specOperator') || 'TEXT').toUpperCase()];
        if (!operator) r.error('specOperator', 'INVALID', 'Use <, <=, =, >=, >, RANGE or TEXT.');
        const primary: ProductParameter = {
          name: specName, operator: operator ?? 'TEXT', valueText: specValue, valueMin: null, valueMax: null, unit: r.text('specUnit') || null, isPrimary: true,
        };
        input.parameters = [primary, ...((base.parameters ?? []) as ProductParameter[]).filter((p) => !p.isPrimary)];
      }
      const validFrom = r.date('validFrom');
      const validTo = r.date('validTo');
      if (validFrom) input.validFrom = validFrom;
      if (validTo) input.validTo = validTo;
      const fx = r.text('fxOnPebDate').toUpperCase();
      if (fx) {
        if (['Y', 'YES', 'TRUE', '1'].includes(fx)) input.fxOnPebDate = true;
        else if (['N', 'NO', 'FALSE', '0'].includes(fx)) input.fxOnPebDate = false;
        else r.error('fxOnPebDate', 'INVALID', 'Enter Y or N.');
      }
      // Every row goes through the parser so the report lists all its problems at once (US-28-N1 AC1).
      const after = await parse(r, 'PRODUCT', input);
      if (after && !rowFailed(r)) {
        items.push({ entityType: 'PRODUCT', entityId, operation: current ? 'UPDATE' : 'CREATE', baseRowId: current?.rowId ?? null,
          before: current?.data ?? null, after, importRow: `${PRODUCTS.name}!${r.row}` });
      }
    }

    // ------------------------------------------------------------ Lines
    const lineRows = rowsOf(LINES);
    const lineIds = await newIds(lineRows.length);
    const seenLines = new Set<string>();
    for (const [index, r] of lineRows.entries()) {
      const current = await target(r, 'SCHEDULE_LINE', seenLines);
      if (current === undefined) continue;
      const base = (current?.data ?? {}) as Partial<ScheduleLineData>;
      const input: Record<string, unknown> = { ...base };

      const regulation = r.text('regulation');
      const regulationId = regulationByLabel.get(fold(regulation));
      if (!regulationId) r.error('regulation', 'NOT_FOUND', `${regulation || 'The regulation'} is not registered.`);
      const charge = r.text('charge').toUpperCase();
      if (!['BK', 'PE'].includes(charge)) r.error('charge', 'INVALID', 'Enter BK or PE.');
      const annex = r.text('annex');
      if (regulationId && ['BK', 'PE'].includes(charge)) {
        const hits = schedules.filter((s) => s.data.regulationId === regulationId && s.data.chargeType === charge && fold(s.data.annexLabel) === fold(annex));
        if (hits.length === 1) input.scheduleId = hits[0].id;
        else r.error('annex', hits.length ? 'AMBIGUOUS' : 'NOT_FOUND', hits.length ? 'Several schedules match.' : `No ${charge} schedule “${annex}” of ${regulation}; register it first.`);
      }
      for (const [field, col] of [['kelompok', 'kelompok'], ['itemNo', 'itemNo'], ['uraian', 'uraian'], ['pct', 'pct'], ['usdPerMt', 'usdPerMt']] as const) {
        const v = r.text(col);
        if (v) input[field] = v;
      }
      const basis = r.text('basis').toUpperCase();
      if (basis) input.basisType = basis;
      const series = r.text('series');
      if (series) {
        const id = seriesByCode.get(series.toUpperCase());
        if (id) input.refSeriesId = id;
        else r.error('series', 'NOT_FOUND', `No series with code ${series}.`);
      }
      const bandTable = r.text('bandTable');
      if (bandTable) {
        const id = bandTableByCode.get(bandTable.toUpperCase());
        if (id) input.bandTableId = id;
        else r.error('bandTable', 'NOT_FOUND', `No band table with code ${bandTable}.`);
      }
      if (r.text('bandValues')) input.bandValues = list(r.text('bandValues')).map(numberText);
      const products = r.text('products');
      if (products) {
        input.productIds = list(products).map((ref) => {
          const byKey = productByKey.get(fold(ref));
          if (byKey) return byKey;
          if (UUID_RE.test(ref) && state.has(ref.toLowerCase(), 'PRODUCT')) return ref.toLowerCase();
          r.error('products', 'NOT_FOUND', `Unknown product “${ref}”: use a row key from the Products sheet or a product id.`);
          return ref;
        });
      }
      const validFrom = r.date('validFrom');
      const validTo = r.date('validTo');
      if (validFrom) input.validFrom = validFrom;
      if (validTo) input.validTo = validTo;
      const after = await parse(r, 'SCHEDULE_LINE', input);
      if (after && !rowFailed(r)) {
        items.push({ entityType: 'SCHEDULE_LINE', entityId: current?.entityId ?? lineIds[index], operation: current ? 'UPDATE' : 'CREATE',
          baseRowId: current?.rowId ?? null, before: current?.data ?? null, after, importRow: `${LINES.name}!${r.row}` });
      }
    }

    // ------------------------------------------------------------ Prices
    const priceRows = rowsOf(PRICES);
    const priceIds = await newIds(priceRows.length);
    for (const [index, r] of priceRows.entries()) {
      const input: Record<string, unknown> = { value: r.text('value'), sourceReference: r.text('decree') || null };
      const series = r.text('series');
      const seriesId = seriesByCode.get(series.toUpperCase());
      if (seriesId) input.seriesId = seriesId;
      else r.error('series', 'NOT_FOUND', `No series with code ${series}.`);
      input.periodFrom = r.date('periodFrom');
      input.periodTo = r.date('periodTo');
      const document = r.text('document');
      if (document) {
        const { rows } = await client.query<{ id: string }>(
          /^[0-9a-f]{64}$/i.test(document)
            ? `SELECT id FROM ecr.source_document WHERE sha256 = decode($1, 'hex')`
            : 'SELECT id FROM ecr.source_document WHERE upper(doc_number) = upper($1)',
          [document],
        );
        if (rows.length === 1) input.sourceDocumentId = rows[0].id;
        else r.error('document', rows.length ? 'AMBIGUOUS' : 'NOT_FOUND', rows.length ? 'Several documents have this number; use its SHA-256.' : 'No uploaded source document matches; upload it first.');
      }
      const after = await parse(r, 'REF_VALUE', input);
      if (after && !rowFailed(r)) items.push({ entityType: 'REF_VALUE', entityId: priceIds[index], operation: 'CREATE', baseRowId: null, before: null, after, importRow: `${PRICES.name}!${r.row}` });
    }

    if (!rowCount && !report.length) {
      report.push({ sheet: 'Products', row: null, column: null, field: null, severity: 'ERROR', code: 'EMPTY', message: 'The file has no data rows.' });
    }
    // Rules across records (duplicate lines, bands, overlaps, references) run once every row could be read.
    if (report.some((e) => e.severity === 'ERROR') && rowCount) {
      report.push({ sheet: 'All sheets', row: null, column: null, field: null, severity: 'INFO', code: 'CHECKS_PENDING',
        message: 'Checks across records (band amounts, overlapping lines, references) run once every row can be read.' });
    } else if (items.length) {
      const where = new Map(items.map((i) => [i.entityId, i]));
      const findings = await validateItems(client, items.map((i) => ({ entityType: i.entityType, entityId: i.entityId, operation: i.operation, after: i.after })), wibToday());
      for (const f of findings) {
        const item = f.entityId ? where.get(f.entityId) : undefined;
        const [sheetName, row] = item ? item.importRow.split('!') : ['', ''];
        const sheet = SHEETS.find((s) => s.name === sheetName);
        const key = item && f.field ? FIELD_COLUMN[item.entityType]?.[f.field] ?? null : null;
        report.push({
          sheet: sheetName || 'Published data',
          row: row ? Number(row) : null,
          column: key && sheet ? (lettersFor(book, sheet).get(key) ?? null) : null,
          field: key && sheet ? sheet.columns.find((c) => c.key === key)?.header ?? null : null,
          severity: f.severity,
          code: f.ruleCode,
          message: f.message,
        });
      }
    }
    report.sort((a, b) => sheetOrder(a.sheet) - sheetOrder(b.sheet) || (a.row ?? 0) - (b.row ?? 0) || severityOrder(a.severity) - severityOrder(b.severity));
    return { rowCount, report, items };
  }

  // ------------------------------------------------------------------ commit

  /**
   * Creates one IMPORT change set with every row as a draft item (PRD L2-3.6 step 5). The stored file is read and
   * checked again first, since the published data may have changed since the dry run.
   */
  async commit(actor: Actor, jobId: string, input: unknown) {
    const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const job = await this.find(jobId);
    if (job.uploaded_by !== actor.id) throw new ApiError(403, 'NOT_OWNER', 'Only the person who uploaded the file can create its change set.');
    if (job.status === 'COMMITTED') throw new ApiError(409, 'INVALID_STATE', 'This import already created a change set.', { changeSetId: job.change_set_id });
    const title = typeof body.title === 'string' && body.title.trim().length >= 3 ? body.title.trim().slice(0, 200) : `Import ${job.file_name}`.slice(0, 200);
    const justification = typeof body.justification === 'string' && body.justification.trim() ? body.justification.trim().slice(0, 4000) : `Imported from ${job.file_name}`;

    const file = await this.store.get(job.file_object_key);
    if (!createHash('sha256').update(file).digest().equals(job.file_sha256)) {
      throw new ApiError(409, 'IMPORT_INTEGRITY', 'The stored file no longer matches the upload; upload it again.');
    }
    try {
      const setId = await this.db.tx(async (client) => {
        await client.query('SELECT 1 FROM ecr.import_job WHERE id = $1 FOR UPDATE', [jobId]);
        const run = await this.dryRun(client, readWorkbook(file));
        const errors = run.report.filter((r) => r.severity === 'ERROR');
        const warnings = run.report.filter((r) => r.severity === 'WARNING');
        if (errors.length) throw new ApiError(422, 'IMPORT_INVALID', `The file now has ${errors.length} error(s); fix them and upload it again.`, { report: run.report });
        if (warnings.length && body.acknowledgeWarnings !== true) {
          throw new ApiError(422, 'WARNINGS_NOT_ACKNOWLEDGED', 'Review and acknowledge the warnings to create the change set.', { report: run.report });
        }
        const { rows: [set] } = await client.query<{ id: string }>(
          `INSERT INTO ecr.change_set (title, justification, kind, created_by) VALUES ($1, $2, 'IMPORT', $3) RETURNING id`,
          [title, justification, actor.id],
        );
        for (const i of run.items) {
          await client.query(
            `INSERT INTO ecr.change_item (change_set_id, entity_type, entity_id, operation, base_row_id, before, after, edited_by, import_row)
             VALUES ($1, $2, $3, $4, $5, $6, $7, ARRAY[$8::uuid], $9)`,
            [set.id, i.entityType, i.entityId, i.operation, i.baseRowId, i.before ? JSON.stringify(i.before) : null, JSON.stringify(i.after), actor.id, i.importRow],
          );
        }
        await client.query(`UPDATE ecr.import_job SET status = 'COMMITTED', change_set_id = $2, committed_at = now() WHERE id = $1`, [jobId, set.id]);
        await this.record(client, actor, 'IMPORT_COMMITTED', jobId, { after: { changeSetId: set.id, items: run.items.length, warningsAcknowledged: warnings.length } });
        await this.audit.record(client, {
          action: 'CHANGESET_CREATED', actorKind: 'USER', actorUserId: actor.id, sessionId: actor.sessionId, ip: actor.ip, userAgent: actor.userAgent,
          entityType: 'CHANGE_SET', entityId: set.id, after: { title, kind: 'IMPORT', importJobId: jobId },
        });
        return set.id;
      });
      return { ...(await this.get(actor, jobId)), changeSetId: setId };
    } catch (err) {
      if ((err as { code?: string }).code === '23505' && (err as { constraint?: string }).constraint === 'change_item_one_open_edit') {
        throw new ApiError(409, 'ENTITY_LOCKED', 'A record in the file is now being edited in another change set; upload the file again to see which.');
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------ reads

  async list(actor: Actor) {
    const { rows } = await this.db.query(
      `SELECT j.id, j.file_name AS "fileName", j.status, j.row_count AS "rowCount", j.error_count AS "errorCount",
              j.warning_count AS "warningCount", j.change_set_id AS "changeSetId", j.created_at AS "createdAt"
         FROM ecr.import_job j WHERE j.uploaded_by = $1 ORDER BY j.created_at DESC LIMIT 50`,
      [actor.id],
    );
    return rows;
  }

  /** The uploader and anyone who reviews change sets can see an import. */
  async get(actor: Actor, id: string) {
    const job = await this.find(id);
    if (job.uploaded_by !== actor.id && !actor.permissions.has('changeset.read')) throw new ApiError(404, 'NOT_FOUND', 'Import not found.');
    return {
      id: job.id,
      fileName: job.file_name,
      fileSha256: job.file_sha256.toString('hex'),
      byteSize: job.byte_size,
      scanResult: job.scan_result,
      templateVersion: job.template_version,
      status: job.status,
      rowCount: job.row_count,
      errorCount: job.error_count,
      warningCount: job.warning_count,
      report: job.report,
      changeSetId: job.change_set_id,
      createdAt: job.created_at,
      committedAt: job.committed_at,
    };
  }

  /** US-28-N1 AC1: the row-level report as a workbook. */
  async reportFile(actor: Actor, id: string): Promise<{ body: Buffer; filename: string }> {
    const job = await this.get(actor, id);
    const body = toXlsx({
      name: 'Report',
      title: `ECR import report — ${job.fileName}`,
      meta: [
        ['Uploaded', wibDateTime(job.createdAt)],
        ['Template version', job.templateVersion],
        ['File SHA-256', job.fileSha256],
        ['Rows', String(job.rowCount)],
        ['Errors', String(job.errorCount)],
        ['Warnings', String(job.warningCount)],
        ['Status', job.status],
      ],
      header: ['Sheet', 'Row', 'Column', 'Field', 'Severity', 'Rule', 'Message'],
      rows: job.report.map((e) => [e.sheet, e.row === null ? null : { num: String(e.row) }, e.column, e.field, e.severity, e.code, e.message]),
      widths: [12, 7, 8, 24, 10, 18, 90],
    });
    return { body, filename: `ecr-import-report-${job.id.slice(-8)}.xlsx` };
  }

  // ------------------------------------------------------------------ helpers

  private async find(id: string): Promise<JobRow> {
    const { rows } = await this.db.query<JobRow>('SELECT * FROM ecr.import_job WHERE id = $1', [id]);
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Import not found.');
    return rows[0];
  }

  private async reject(actor: Actor, fileName: string, code: string, message: string, signature?: string, details?: Record<string, unknown>): Promise<never> {
    await this.audit.record(this.db.pool, {
      action: 'IMPORT_REJECTED', actorKind: 'USER', actorUserId: actor.id, sessionId: actor.sessionId, ip: actor.ip, userAgent: actor.userAgent,
      entityType: 'IMPORT_JOB', after: { fileName, code, signature },
    });
    throw new ApiError(422, code, message, details);
  }

  private record(q: Queryable, actor: Actor, action: string, jobId: string, extra: { after?: unknown }) {
    return this.audit.record(q, {
      action, actorKind: 'USER', actorUserId: actor.id, sessionId: actor.sessionId, ip: actor.ip, userAgent: actor.userAgent,
      entityType: 'IMPORT_JOB', entityId: jobId, ...extra,
    });
  }
}

function lettersFor(book: Workbook, def: SheetDef): Map<string, string> {
  const letters = new Map<string, string>();
  for (const [letter, cell] of book.get(def.name)?.get(1) ?? []) {
    const col: ColumnDef | undefined = def.columns.find((c) => fold(c.header) === fold(cell.value));
    if (col) letters.set(col.key, letter);
  }
  return letters;
}

const sheetOrder = (name: string) => {
  const i = SHEETS.findIndex((s) => s.name === name);
  return i < 0 ? SHEETS.length : i;
};
const severityOrder = (s: string) => (s === 'ERROR' ? 0 : s === 'WARNING' ? 1 : 2);

