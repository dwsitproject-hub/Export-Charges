import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { ApiError } from '../common/api-error';
import { addDays, wibToday } from '../common/fields';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService } from '../db/db.service';
import { CalcInput, CalcResult, calculate, canonicalHash, LineCharge } from '../catalogue/calculator';
import { dataView } from '../catalogue/data-state';
import { legalReference, rateText } from '../exports/present';
import type { ObjectStore } from '../registry/file-handling';
import { OBJECT_STORE } from '../registry/source-documents.service';
import { ProductData, regulationLabel, RegulationData } from '../registry/entities';
import type { ValueUsed } from '../tariffs/charge-engine';
import { EvidenceCharge, EvidencePayload, renderEvidencePdf } from './evidence-pdf';

export const EVIDENCE_ID_RE = /^EV-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RETENTION_YEARS = 10;

interface PackRow {
  evidence_id: string;
  calculation_id: string;
  payload: EvidencePayload;
  payload_sha256: Buffer;
  object_key: string;
  pdf_sha256: Buffer;
  byte_size: number;
  created_by: string;
  created_at: Date;
  retain_until: string;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();

/** PDF/A evidence packs (PRD FR-EXP-02, Technical Design §4.3.3): one per saved, official calculation. */
@Injectable()
export class EvidenceService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  /**
   * Generates the pack for the author's calculation, or returns the one already made. A simulation, an incomplete
   * result or a calculation that no longer replays to its stored result cannot become evidence.
   */
  async create(actor: Actor, calculationId: string): Promise<{ created: boolean; pack: ReturnType<EvidenceService['summary']> }> {
    return this.db.tx(async (client) => {
      const { rows: [calc] } = await client.query<{ inputs: CalcInput; inputs_hash: Buffer; result: CalcResult; result_hash: Buffer; created_at: Date; is_simulation: boolean; status: string }>(
        `SELECT inputs, inputs_hash, result, result_hash, created_at, is_simulation, status
           FROM ecr.calculation WHERE id = $1 AND created_by = $2`,
        [calculationId, actor.id],
      );
      if (!calc) throw new ApiError(404, 'NOT_FOUND', 'Calculation not found.');
      // One pack per calculation, even when two requests arrive together.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`evidence:${calculationId}`]);
      const { rows: [existing] } = await client.query<PackRow>('SELECT * FROM ecr.evidence_pack WHERE calculation_id = $1', [calculationId]);
      if (existing) return { created: false, pack: this.summary(existing) };

      if (calc.is_simulation) {
        throw new ApiError(422, 'SIMULATION_NOT_EVIDENCE', 'A what-if calculation is a simulation and cannot become evidence (BR-CAL-12).');
      }
      if (calc.status !== 'COMPLETE') {
        throw new ApiError(422, 'CALCULATION_INCOMPLETE', 'The calculation is missing a value; evidence needs a complete result.');
      }
      const view = await dataView(client, calc.inputs.pebDate, calc.inputs.versionNo);
      if (!canonicalHash(calc.inputs).equals(calc.inputs_hash) || !canonicalHash(calculate(view.state, calc.inputs, calc.result.disclaimer)).equals(calc.result_hash)) {
        await this.audit.record(this.db.pool, {
          action: 'EVIDENCE_REPLAY_MISMATCH',
          actorKind: 'USER',
          actorUserId: actor.id,
          sessionId: actor.sessionId,
          ip: actor.ip,
          userAgent: actor.userAgent,
          entityType: 'CALCULATION',
          entityId: calculationId,
        });
        throw new ApiError(409, 'REPLAY_MISMATCH', 'Replaying the calculation at its data version does not give the stored result; evidence was not generated.');
      }

      const { rows: [ids] } = await client.query<{ uuid: string; now: Date }>('SELECT uuidv7()::text AS uuid, now() AS now');
      const evidenceId = `EV-${ids.uuid}`;
      const { rows: [user] } = await client.query<{ full_name: string; email: string }>('SELECT full_name, email FROM ecr.app_user WHERE id = $1', [actor.id]);
      const payload = await this.payload(client, {
        evidenceId,
        generatedAt: ids.now,
        user: { name: user.full_name, email: user.email },
        calculationId,
        savedAt: calc.created_at,
        result: calc.result,
        inputsHash: calc.inputs_hash,
        resultHash: calc.result_hash,
        view,
      });
      const payloadHash = canonicalHash(payload);
      const pdf = renderEvidencePdf(payload, payloadHash.toString('hex'));
      const key = `evidence/${ids.now.getUTCFullYear()}/${evidenceId.toLowerCase()}.pdf`;
      await this.store.put(key, pdf);

      const { rows: [row] } = await client.query<PackRow>(
        `INSERT INTO ecr.evidence_pack
           (evidence_id, calculation_id, payload, payload_sha256, object_key, pdf_sha256, byte_size, created_by, created_at, retain_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [evidenceId, calculationId, JSON.stringify(payload), payloadHash, key, sha256(pdf), pdf.length, actor.id, ids.now,
         addDays(wibToday(ids.now), Math.round(RETENTION_YEARS * 365.25))],
      );
      await this.audit.record(client, {
        action: 'EVIDENCE_CREATED',
        actorKind: 'USER',
        actorUserId: actor.id,
        sessionId: actor.sessionId,
        ip: actor.ip,
        userAgent: actor.userAgent,
        entityType: 'EVIDENCE_PACK',
        entityId: evidenceId,
        after: { calculationId, versionNo: calc.inputs.versionNo, payloadSha256: payloadHash.toString('hex'), pdfSha256: sha256(pdf).toString('hex') },
      });
      return { created: true, pack: this.summary(row) };
    });
  }

  /** The pack's record; its author and auditors can see it. */
  async get(actor: Actor, evidenceId: string) {
    return this.summary(await this.readable(actor, evidenceId));
  }

  /** The PDF, refused if it no longer matches its recorded SHA-256. */
  async file(actor: Actor, evidenceId: string): Promise<{ body: Buffer; filename: string }> {
    const pack = await this.readable(actor, evidenceId);
    const body = await this.store.get(pack.object_key);
    if (!sha256(body).equals(pack.pdf_sha256)) {
      throw new ApiError(409, 'EVIDENCE_INTEGRITY', 'The stored evidence pack does not match its recorded checksum.');
    }
    return { body, filename: `${pack.evidence_id}.pdf` };
  }

  /**
   * Verification for anyone signed in who holds the pack (Technical Design §4.3.3): the stored PDF still matches its
   * hash, the recorded payload still matches the hash printed in the footer, and the calculation replays to the
   * same result at its data version. The figures are returned so the reader can compare them with the paper.
   */
  async verify(actor: Actor, evidenceId: string) {
    const pack = await this.find(evidenceId);
    const { rows: [calc] } = await this.db.query<{ inputs: CalcInput; result: CalcResult; result_hash: Buffer }>(
      'SELECT inputs, result, result_hash FROM ecr.calculation WHERE id = $1', [pack.calculation_id],
    );
    let pdfIntact = false;
    try {
      pdfIntact = sha256(await this.store.get(pack.object_key)).equals(pack.pdf_sha256);
    } catch {
      pdfIntact = false;
    }
    const payloadIntact = canonicalHash(pack.payload).equals(pack.payload_sha256);
    const view = await dataView(this.db.pool, calc.inputs.pebDate, calc.inputs.versionNo);
    const replayMatch = canonicalHash(calculate(view.state, calc.inputs, calc.result.disclaimer)).equals(calc.result_hash) &&
      pack.payload.calculation.resultSha256 === calc.result_hash.toString('hex');
    const valid = pdfIntact && payloadIntact && replayMatch;
    await this.audit.record(this.db.pool, {
      action: 'EVIDENCE_VERIFIED',
      actorKind: 'USER',
      actorUserId: actor.id,
      sessionId: actor.sessionId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      entityType: 'EVIDENCE_PACK',
      entityId: evidenceId,
      after: { valid, pdfIntact, payloadIntact, replayMatch },
    });
    const p = pack.payload;
    return {
      evidenceId,
      valid,
      checks: { pdfIntact, payloadIntact, replayMatch },
      pdfSha256: pack.pdf_sha256.toString('hex'),
      contentSha256: pack.payload_sha256.toString('hex'),
      byteSize: pack.byte_size,
      createdAt: pack.created_at,
      createdBy: p.generatedBy.name,
      versionNo: p.calculation.versionNo,
      pebDate: p.calculation.pebDate,
      paymentDate: p.calculation.paymentDate,
      lines: p.lines.map((l) => ({ product: l.product, quantityMt: l.quantityMt, totalUsd: l.totalUsd })),
      totals: p.totals,
      canDownload: pack.created_by === actor.id || actor.permissions.has('audit.read'),
    };
  }

  private summary(row: PackRow) {
    return {
      evidenceId: row.evidence_id,
      calculationId: row.calculation_id,
      contentSha256: row.payload_sha256.toString('hex'),
      pdfSha256: row.pdf_sha256.toString('hex'),
      byteSize: row.byte_size,
      pdfaProfile: 'PDF/A-2b',
      createdAt: row.created_at,
      retainUntil: row.retain_until,
      verifyUrl: row.payload.verifyUrl,
    };
  }

  private async find(evidenceId: string): Promise<PackRow> {
    const { rows } = await this.db.query<PackRow>(
      `SELECT evidence_id, calculation_id, payload, payload_sha256, object_key, pdf_sha256, byte_size, created_by, created_at,
              retain_until
         FROM ecr.evidence_pack WHERE evidence_id = $1`,
      [evidenceId],
    );
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Evidence pack not found.');
    return rows[0];
  }

  private async readable(actor: Actor, evidenceId: string): Promise<PackRow> {
    const pack = await this.find(evidenceId);
    if (pack.created_by !== actor.id && !actor.permissions.has('audit.read')) throw new ApiError(404, 'NOT_FOUND', 'Evidence pack not found.');
    return pack;
  }

  /** What the PDF prints, taken from the stored result and the data at its version. */
  private async payload(
    client: Parameters<typeof dataView>[0],
    a: { evidenceId: string; generatedAt: Date; user: { name: string; email: string }; calculationId: string; savedAt: Date;
      result: CalcResult; inputsHash: Buffer; resultHash: Buffer; view: Awaited<ReturnType<typeof dataView>> },
  ): Promise<EvidencePayload> {
    const { state } = a.view;
    const r = a.result;
    const summary = (c: LineCharge): EvidenceCharge => ({
      status: c.status,
      basis: c.basisType ?? null,
      rateOrBand: rateText(c),
      usdPerMt: c.usdPerMt,
      totalUsd: c.totalUsd,
      legalReference: legalReference(c),
      message: c.status === 'MISSING_VALUE' || c.status === 'DATA_ERROR' ? c.message : null,
    });

    const values = new Map<string, ValueUsed>();
    const legal = new Map<string, EvidencePayload['legalReferences'][number]>();
    const documents = new Set<string>();
    const regulationDocs = (id: string | null | undefined) => {
      for (const d of state.get<RegulationData>(id, 'REGULATION')?.documents ?? []) documents.add(d.sourceDocumentId);
    };
    const lines = r.lines.map((l) => {
      const product = state.get<ProductData>(l.productId, 'PRODUCT');
      const classification = state.get<RegulationData>(product?.classificationRegulationId, 'REGULATION');
      regulationDocs(product?.classificationRegulationId);
      for (const c of [l.bk, l.pe]) {
        for (const v of [c.referencePrice, c.hargaEkspor]) {
          if (v) {
            values.set(v.valueId, v);
            if (v.sourceDocumentId) documents.add(v.sourceDocumentId);
          }
        }
        if (c.line) {
          legal.set(`${c.chargeType}:${c.line.lineId}`, {
            chargeType: c.chargeType, regulation: c.line.regulation, annex: c.line.annexLabel, kelompok: c.line.kelompok,
            itemNo: c.line.itemNo, uraian: c.line.uraian,
          });
          regulationDocs(c.line.regulationId);
        }
      }
      if (l.fx) {
        values.set(l.fx.valueId, l.fx);
        if (l.fx.sourceDocumentId) documents.add(l.fx.sourceDocumentId);
      }
      return {
        ordinal: l.ordinal,
        product: l.product,
        hsCodes: product?.hsCodes.map((h) => `${h.isEx ? 'ex ' : ''}${h.code}`) ?? [],
        classification: classification ? regulationLabel(classification) : null,
        quantityMt: l.quantityMt,
        bk: summary(l.bk),
        pe: summary(l.pe),
        totalUsd: l.totalUsd,
        fx: l.fx ? { seriesCode: l.fx.seriesCode, value: l.fx.value, periodFrom: l.fx.periodFrom, periodTo: l.fx.periodTo, sourceReference: l.fx.sourceReference } : null,
        totalIdr: l.totalIdr,
        warnings: l.warnings,
      };
    });

    const { rows: sources } = await client.query<EvidencePayload['sources'][number]>(
      `SELECT d.title, d.doc_number AS "docNumber", d.doc_date::text AS "docDate", d.official_url AS "officialUrl",
              p.name AS publisher, encode(d.sha256, 'hex') AS sha256
         FROM ecr.source_document d LEFT JOIN ecr.source_publisher p ON p.id = d.publisher_id
        WHERE d.id = ANY($1::uuid[]) ORDER BY d.doc_kind, d.doc_date NULLS LAST, d.title`,
      [[...documents]],
    );

    return {
      evidenceId: a.evidenceId,
      generatedAt: a.generatedAt.toISOString(),
      generatedBy: a.user,
      verifyUrl: `${this.config.publicBaseUrl}/verify/${a.evidenceId}`,
      calculation: {
        id: a.calculationId,
        savedAt: new Date(a.savedAt).toISOString(),
        pebDate: r.pebDate,
        paymentDate: r.paymentDate,
        versionNo: r.versionNo,
        versionPublishedAt: a.view.publishedAt ? new Date(a.view.publishedAt).toISOString() : null,
        status: r.status,
        inputsSha256: a.inputsHash.toString('hex'),
        resultSha256: a.resultHash.toString('hex'),
      },
      lines,
      totals: r.totals,
      referenceValues: [...values.values()]
        .sort((x, y) => x.seriesCode.localeCompare(y.seriesCode) || x.periodFrom.localeCompare(y.periodFrom))
        .map((v) => ({ seriesCode: v.seriesCode, periodFrom: v.periodFrom, periodTo: v.periodTo, value: v.value, unit: v.unit, sourceReference: v.sourceReference, fallback: v.fallback })),
      legalReferences: [...legal.values()],
      sources,
      missing: r.missing,
      disclaimer: r.disclaimer,
    };
  }
}
