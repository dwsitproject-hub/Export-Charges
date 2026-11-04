import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { ApiError } from '../common/api-error';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService } from '../db/db.service';
import type { CalcResult, LineCharge } from '../catalogue/calculator';
import { CatalogueQuery, CatalogueService } from '../catalogue/catalogue.service';
import { dataView } from '../catalogue/data-state';
import type { ProductData } from '../registry/entities';
import type { Charge } from '../tariffs/charge-engine';
import { BASIS_TEXT, CATEGORY_TEXT, grouped, legalReference, priceUsed, rateText, STATUS_TEXT, valueText, wibDateTime } from './present';
import { Cell, num, Sheet, toCsv, toXlsx } from './tabular';

export const FORMATS = ['csv', 'xlsx'] as const;
export type Format = (typeof FORMATS)[number];
/** Upper bound for an export job; the synchronous limit is `exportAsyncThreshold` (US-47-N1 AC3). */
export const MAX_JOB_ROWS = 1_000_000;

export interface ExportFile {
  body: Buffer;
  filename: string;
  contentType: string;
}

const CONTENT_TYPE: Record<Format, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const chargeText = (c: Charge) => (c.status === 'MISSING_VALUE' || c.status === 'DATA_ERROR') && c.message
  ? `${STATUS_TEXT[c.status]}: ${c.message}` : STATUS_TEXT[c.status] ?? c.status;
const usdPerMt = (c: Charge) => (c.status === 'MISSING_VALUE' || c.status === 'DATA_ERROR' ? null : num(c.usdPerMt));

/** CSV and XLSX exports of the catalogue and of saved calculations (PRD FR-EXP-01, US-47; Technical Design §4.3.3). */
@Injectable()
export class ExportsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly catalogue: CatalogueService,
  ) {}

  /**
   * Every row matching the catalogue's search and filters, in its sort order, at date D and version V. Above the
   * synchronous limit the answer is EXPORT_TOO_LARGE with the address of the export job to request instead.
   */
  async catalogueExport(actor: Actor, query: CatalogueQuery, format: Format): Promise<ExportFile> {
    const limit = this.config.exportAsyncThreshold;
    const built = await this.buildCatalogue(actor.id, query, format, limit);
    if ('tooLarge' in built) {
      throw new ApiError(422, 'EXPORT_TOO_LARGE',
        `${built.tooLarge.toLocaleString('en')} rows is more than ${limit.toLocaleString('en')}; the export will be prepared in the background and you will be notified.`,
        { rows: built.tooLarge, limit, jobUrl: '/api/exports/jobs' });
    }
    await this.recordExport(actor, 'CATALOGUE', null, built.audit);
    return built.file;
  }

  /** Builds the catalogue file for `userId`; `{ tooLarge }` when more than `maxRows` rows match. */
  async buildCatalogue(userId: string, query: CatalogueQuery, format: Format, maxRows: number):
    Promise<{ file: ExportFile; rows: number; audit: Record<string, unknown> } | { tooLarge: number }> {
    const page = await this.catalogue.catalogue({ ...query, page: 1, pageSize: maxRows + 1 });
    if (page.total > maxRows) return { tooLarge: page.total };
    const user = await this.user(userId);
    const facetLabels = (ids: string[], facet: { id: string; label: string }[]) =>
      ids.map((id) => facet.find((f) => f.id === id)?.label ?? id).join(', ');
    const filters = [
      page.query && `search "${page.query}"`,
      query.commodity.length && `commodity ${facetLabels(query.commodity, page.facets.commodity)}`,
      query.group.length && `group ${facetLabels(query.group, page.facets.group)}`,
      query.category.length && `category ${query.category.map((c) => CATEGORY_TEXT[c] ?? c).join(', ')}`,
      query.regulation.length && `regulation ${facetLabels(query.regulation, page.facets.regulation)}`,
      query.sharedHs && 'shared HS codes only',
    ].filter(Boolean).join('; ');

    const header = [
      'Commodity', 'Group', 'Item no.', 'Product', 'Product (English)', 'HS codes', 'Key specification', 'Category',
      'Duty (BK)', 'BK USD/MT', 'BK basis', 'BK rate or band', 'BK price used', 'BK legal reference',
      'Levy (PE)', 'PE USD/MT', 'PE basis', 'PE rate or band', 'PE price used', 'PE legal reference',
      'Total USD/MT', 'Shared HS code', 'Classification regulation',
    ];
    const chargeCells = (c: Charge): Cell[] => {
      const price = priceUsed(c);
      return [chargeText(c), usdPerMt(c), c.basisType ? BASIS_TEXT[c.basisType] ?? c.basisType : null, rateText(c),
        price ? valueText(price) : null, legalReference(c)];
    };
    const rows = page.rows.map((r): Cell[] => [
      r.commodityCode, r.group, r.itemNoAsPrinted, r.nameId, r.nameEn,
      r.hsCodes.map((h) => `${h.isEx ? 'ex ' : ''}${h.code}`).join(', '), r.keySpec, CATEGORY_TEXT[r.category],
      ...chargeCells(r.bk), ...chargeCells(r.pe),
      r.totalUsdPerMt !== null ? num(r.totalUsdPerMt) : r.totalNote, r.sharedHs ? 'Yes' : 'No',
      `${r.classificationRegulation ?? ''}${r.draftClassification ? ' (draft)' : ''}` || null,
    ]);

    const sheet: Sheet = {
      name: 'Catalogue',
      title: 'ECR — export duty (BK) and levy (PE) catalogue',
      meta: [
        ['As-of date (PEB date)', page.date],
        ['Data version', `${page.versionNo}${page.publishedAt ? `, published ${wibDateTime(page.publishedAt)}` : ''}`],
        ...page.referencePrices.map((p): [string, string] => [
          p.name,
          p.value ? `${valueText(p.value)}${p.bands.map((b) => `; band ${b.ordinal}${b.label ? ` (${b.label})` : ''} of ${b.table}`).join('')}` : 'not published for this date',
        ]),
        ['Search and filters', filters || 'none'],
        ['Rows', String(page.total)],
        ...page.notices.map((n): [string, string] => ['Notice', n]),
        ['Exported', wibDateTime(new Date())],
        ['Exported by', `${user.fullName} <${user.email}>`],
        ['Disclaimer', this.config.disclaimer],
      ],
      header,
      rows,
      widths: [10, 12, 8, 34, 28, 22, 22, 14, 18, 11, 20, 18, 30, 30, 18, 11, 20, 18, 30, 30, 13, 9, 22],
    };
    return {
      file: this.file(sheet, format, `ecr-catalogue-${page.date}-v${page.versionNo}`),
      rows: rows.length,
      audit: { format, rows: rows.length, date: page.date, versionNo: page.versionNo, filters },
    };
  }

  /** A saved calculation, line by line with totals; only its author can export it. */
  async calculationExport(actor: Actor, id: string, format: Format): Promise<ExportFile> {
    const { rows: [calc] } = await this.db.query<{ result: CalcResult; created_at: Date; evidence_id: string | null }>(
      `SELECT c.result, c.created_at, e.evidence_id
         FROM ecr.calculation c LEFT JOIN ecr.evidence_pack e ON e.calculation_id = c.id
        WHERE c.id = $1 AND c.created_by = $2`,
      [id, actor.id],
    );
    if (!calc) throw new ApiError(404, 'NOT_FOUND', 'Calculation not found.');
    const r = calc.result;
    const view = await dataView(this.db.pool, r.pebDate, r.versionNo);
    const user = await this.user(actor.id);

    const chargeCells = (c: LineCharge): Cell[] => [
      chargeText(c), c.basisType ? BASIS_TEXT[c.basisType] ?? c.basisType : null, rateText(c), usdPerMt(c), num(c.totalUsd),
      priceUsed(c) ? valueText(priceUsed(c)!) : null, legalReference(c),
    ];
    const rows = r.lines.map((l): Cell[] => [
      String(l.ordinal), l.product,
      view.state.get<ProductData>(l.productId, 'PRODUCT')?.hsCodes.map((h) => `${h.isEx ? 'ex ' : ''}${h.code}`).join(', ') ?? null,
      num(l.quantityMt), ...chargeCells(l.bk), ...chargeCells(l.pe), num(l.totalUsd),
      l.fx ? num(l.fx.value) : null, l.fx ? `${l.fx.periodFrom} – ${l.fx.periodTo}` : null, num(l.totalIdr),
      l.warnings.join(' ') || null,
    ]);
    const blank = (n: number) => Array<Cell>(n).fill(null);
    const footer: Cell[][] = [[
      'Total', ...blank(3), ...blank(4), num(r.totals.bkUsd), ...blank(2), ...blank(4), num(r.totals.peUsd), ...blank(2),
      num(r.totals.usd), ...blank(2), num(r.totals.idr), r.totals.idr ? 'IDR rounded half up to whole rupiah (BR-CAL-05)' : null,
    ]];

    const sheet: Sheet = {
      name: 'Calculation',
      title: r.isSimulation ? 'ECR — SIMULATION (what-if reference price), not official evidence' : 'ECR — export duty (BK) and levy (PE) calculation',
      meta: [
        ['Calculation', id],
        ['Saved', wibDateTime(calc.created_at)],
        ['PEB date (duty and levy)', r.pebDate],
        ['Payment date (KMK rate)', r.paymentDate],
        ['Data version', `${r.versionNo}${view.publishedAt ? `, published ${wibDateTime(view.publishedAt)}` : ''}`],
        ['Status', r.status === 'COMPLETE' ? 'Complete' : 'Incomplete — a value is missing'],
        ...(r.isSimulation ? [['What-if reference price', `${grouped(r.refPriceOverride)} USD/MT (SIMULATION)`] as [string, string]] : []),
        ['Total USD', r.totals.usd === null ? 'not computable' : grouped(r.totals.usd)],
        ['Total IDR', r.totals.idr === null ? 'not computable' : grouped(r.totals.idr)],
        ...r.missing.map((m): [string, string] => ['Missing', m]),
        ['Evidence pack', calc.evidence_id ?? 'none'],
        ['Exported', wibDateTime(new Date())],
        ['Exported by', `${user.fullName} <${user.email}>`],
        ['Disclaimer', r.disclaimer],
      ],
      header: [
        '#', 'Product', 'HS codes', 'Quantity MT',
        'Duty (BK)', 'BK basis', 'BK rate or band', 'BK USD/MT', 'BK USD', 'BK price used', 'BK legal reference',
        'Levy (PE)', 'PE basis', 'PE rate or band', 'PE USD/MT', 'PE USD', 'PE price used', 'PE legal reference',
        'Total USD', 'KMK USD/IDR', 'KMK period', 'IDR', 'Warnings',
      ],
      rows,
      footer,
      widths: [4, 32, 18, 12, 14, 20, 18, 11, 13, 30, 30, 14, 20, 18, 11, 13, 30, 30, 14, 12, 22, 18, 40],
    };
    await this.recordExport(actor, 'CALCULATION', id, { format, rows: rows.length, versionNo: r.versionNo, isSimulation: r.isSimulation });
    return this.file(sheet, format, `ecr-calculation-${r.pebDate}-${id.slice(-8)}`);
  }

  private file(sheet: Sheet, format: Format, name: string): ExportFile {
    return { body: format === 'csv' ? toCsv(sheet) : toXlsx(sheet), filename: `${name}.${format}`, contentType: CONTENT_TYPE[format] };
  }

  private async user(id: string) {
    const { rows } = await this.db.query<{ fullName: string; email: string }>(
      'SELECT full_name AS "fullName", email FROM ecr.app_user WHERE id = $1', [id],
    );
    return rows[0];
  }

  private recordExport(actor: Actor, entityType: string, entityId: string | null, after: object) {
    return this.audit.record(this.db.pool, {
      action: 'EXPORT_DOWNLOADED',
      actorKind: 'USER',
      actorUserId: actor.id,
      sessionId: actor.sessionId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      entityType,
      entityId,
      after,
    });
  }
}
