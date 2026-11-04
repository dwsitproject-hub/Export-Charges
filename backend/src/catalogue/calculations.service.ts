import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { ApiError } from '../common/api-error';
import { addDays, asObject, decimalOf, Fields, wibToday } from '../common/fields';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService } from '../db/db.service';
import type { ProductData } from '../registry/entities';
import { CalcInput, CalcResult, calculate, canonicalHash } from './calculator';
import { dataView } from './data-state';

const MAX_LINES = 50;

/** Charge calculator (PRD F-44, F-45; Technical Design §4.3.2, §5.1 "Calculator"). */
@Injectable()
export class CalculationsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /** Validates inputs (US-44-N1) and resolves the data version; an unusable override is ignored with a notice. */
  private async prepare(body: unknown) {
    const b = asObject(body);
    const f = new Fields(b);
    const pebDate = f.optDate('pebDate') ?? wibToday();
    const paymentDate = f.optDate('paymentDate') ?? pebDate;
    const version = f.optInt('versionNo', 1, 1_000_000);
    if (paymentDate < addDays(pebDate, -30)) f.fail('paymentDate', 'The payment date can be at most 30 days before the PEB date.');

    const lines = f.list('lines', MAX_LINES).map((l, i) => {
      const lf = f.nested('lines', i, l);
      const productId = lf.optUuid('productId');
      if (!productId) lf.fail('productId', 'Choose a product.');
      // US-44-N1 AC1: more than 0 and at most 1,000,000 MT, 3 decimals.
      const quantityMt = lf.optDecimal('quantityMt', { min: '0', minExclusive: true, max: '1000000', scale: 3 }) ?? '';
      if (!quantityMt && !f.errors.some((e) => e.field === `lines[${i}].quantityMt`)) lf.fail('quantityMt', 'Enter the quantity in MT.');
      return { productId: productId ?? '', quantityMt };
    });
    if (!lines.length) f.fail('lines', 'Add at least one product.');
    if (Array.isArray(b.lines) && b.lines.length > MAX_LINES) f.fail('lines', `At most ${MAX_LINES} lines.`);
    f.throwIfAny();

    const view = await dataView(this.db.pool, pebDate, version ?? undefined);
    lines.forEach((l, i) => {
      if (!view.state.has(l.productId, 'PRODUCT')) f.fail(`lines[${i}].productId`, 'Product not found in this data version.');
    });
    f.throwIfAny();

    // US-44-N2 AC2: an override below or at zero, or not a number, is ignored with a message.
    const notices = [...view.notices];
    let refPriceOverride: string | null = null;
    if (b.refPriceOverride !== undefined && b.refPriceOverride !== null && b.refPriceOverride !== '') {
      const v = decimalOf(b.refPriceOverride, { min: '0', minExclusive: true, scale: 6 });
      if (typeof v === 'string') refPriceOverride = v;
      else notices.push('The what-if reference price was not a positive number and was ignored.');
    }
    const input: CalcInput = { lines, pebDate, paymentDate, refPriceOverride, versionNo: view.versionNo };
    return { input, view, notices };
  }

  async preview(body: unknown) {
    const { input, view, notices } = await this.prepare(body);
    return { ...calculate(view.state, input, this.config.disclaimer), notices, scheduledApplied: view.scheduledApplied };
  }

  /** Saves a calculation with its inputs, data version and result, so it can be replayed (NFR-AUD-01). */
  async save(actor: Actor, body: unknown) {
    const { input, view, notices } = await this.prepare(body);
    if (view.scheduledApplied.length) {
      throw new ApiError(422, 'NOT_PUBLISHED', 'A calculation that relies on scheduled, not yet published changes cannot be saved.');
    }
    const result = calculate(view.state, input, this.config.disclaimer);
    const fx = result.lines.find((l) => l.fx)?.fx ?? null;
    const id = await this.db.tx(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO ecr.calculation
           (created_by, peb_date, payment_date, version_no, is_simulation, ref_price_override, status, inputs, inputs_hash, result,
            result_hash, total_usd, total_idr, fx_value, fx_source_document_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
        [actor.id, input.pebDate, input.paymentDate, input.versionNo, result.isSimulation, input.refPriceOverride, result.status,
         JSON.stringify(input), canonicalHash(input), JSON.stringify(result), canonicalHash(result), result.totals.usd, result.totals.idr,
         fx?.value ?? null, fx?.sourceDocumentId ?? null],
      );
      const calcId = rows[0].id;
      for (const l of result.lines) {
        await client.query(
          `INSERT INTO ecr.calculation_line
             (calculation_id, ordinal, product_entity_id, quantity_mt, bk_status, bk_basis, bk_line_entity_id, bk_per_mt, bk_total_usd,
              pe_status, pe_basis, pe_line_entity_id, pe_per_mt, pe_total_usd, ref_value_entity_id, he_value_entity_id, band_ordinal,
              he_fallback, warnings)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
          [calcId, l.ordinal, l.productId, l.quantityMt, l.bk.status, l.bk.basisType ?? null, l.bk.line?.lineId ?? null,
           l.bk.usdPerMt, l.bk.totalUsd, l.pe.status, l.pe.basisType ?? null, l.pe.line?.lineId ?? null, l.pe.usdPerMt, l.pe.totalUsd,
           // Simulated prices are not records; only published values are referenced.
           result.isSimulation ? null : (l.bk.referencePrice ?? l.pe.referencePrice)?.valueId ?? null,
           (l.bk.hargaEkspor ?? l.pe.hargaEkspor)?.valueId ?? null, l.bk.band?.ordinal ?? l.pe.band?.ordinal ?? null,
           !!(l.bk.hargaEkspor?.fallback || l.pe.hargaEkspor?.fallback), JSON.stringify(l.warnings)],
        );
      }
      await this.audit.record(client, {
        action: 'CALCULATION_SAVED',
        actorKind: 'USER',
        actorUserId: actor.id,
        sessionId: actor.sessionId,
        ip: actor.ip,
        userAgent: actor.userAgent,
        entityType: 'CALCULATION',
        entityId: calcId,
        after: { versionNo: input.versionNo, pebDate: input.pebDate, lines: input.lines.length, isSimulation: result.isSimulation, totalUsd: result.totals.usd },
      });
      return calcId;
    });
    return { id, ...result, notices };
  }

  async list(actor: Actor) {
    const { rows } = await this.db.query(
      `SELECT c.id, c.peb_date AS "pebDate", c.payment_date AS "paymentDate", c.version_no AS "versionNo", c.is_simulation AS "isSimulation",
              c.status, c.total_usd::text AS "totalUsd", c.total_idr::text AS "totalIdr", c.created_at AS "createdAt",
              (SELECT e.evidence_id FROM ecr.evidence_pack e WHERE e.calculation_id = c.id) AS "evidenceId",
              (SELECT string_agg(p.name_id, ', ' ORDER BY l.ordinal) FROM ecr.calculation_line l
                 JOIN ecr.product p ON p.entity_id = l.product_entity_id AND p.version_from <= c.version_no
                  AND (p.version_to IS NULL OR p.version_to > c.version_no)
                WHERE l.calculation_id = c.id) AS products
         FROM ecr.calculation c WHERE c.created_by = $1 ORDER BY c.created_at DESC LIMIT 100`,
      [actor.id],
    );
    return rows;
  }

  /** A saved calculation; only its author sees it. */
  async get(actor: Actor, id: string): Promise<CalcResult & { id: string; createdAt: Date; inputsHash: string; resultHash: string; evidenceId: string | null }> {
    const { rows } = await this.db.query<{ result: CalcResult; created_at: Date; inputs_hash: Buffer; result_hash: Buffer; evidence_id: string | null }>(
      `SELECT c.result, c.created_at, c.inputs_hash, c.result_hash, e.evidence_id
         FROM ecr.calculation c LEFT JOIN ecr.evidence_pack e ON e.calculation_id = c.id
        WHERE c.id = $1 AND c.created_by = $2`,
      [id, actor.id],
    );
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Calculation not found.');
    const r = rows[0];
    return {
      id, ...r.result, createdAt: r.created_at, inputsHash: r.inputs_hash.toString('hex'), resultHash: r.result_hash.toString('hex'),
      evidenceId: r.evidence_id,
    };
  }

  /** Replays the stored inputs at the stored data version; the result must be identical (Technical Design §4.3.2). */
  async verify(actor: Actor, id: string) {
    const { rows } = await this.db.query<{ inputs: CalcInput; inputs_hash: Buffer; result: CalcResult; result_hash: Buffer }>(
      'SELECT inputs, inputs_hash, result, result_hash FROM ecr.calculation WHERE id = $1 AND created_by = $2',
      [id, actor.id],
    );
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Calculation not found.');
    const { inputs } = rows[0];
    const view = await dataView(this.db.pool, inputs.pebDate, inputs.versionNo);
    const replay = canonicalHash(calculate(view.state, inputs, rows[0].result.disclaimer));
    return {
      id,
      versionNo: inputs.versionNo,
      inputsIntact: canonicalHash(inputs).equals(rows[0].inputs_hash),
      match: replay.equals(rows[0].result_hash),
      storedResultHash: rows[0].result_hash.toString('hex'),
      replayedResultHash: replay.toString('hex'),
    };
  }

  /** Searchable product list for the calculator (as of a date). */
  async products(date: string) {
    const view = await dataView(this.db.pool, date);
    return view.state.ofType<ProductData>('PRODUCT')
      .map((p) => ({ entityId: p.id, nameId: p.data.nameId, nameEn: p.data.nameEn, hsCodes: p.data.hsCodes.map((h) => h.code) }))
      .sort((a, b) => a.nameId.localeCompare(b.nameId));
  }
}
