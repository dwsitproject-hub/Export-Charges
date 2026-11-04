import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { ApiError } from '../common/api-error';
import { asObject, Fields } from '../common/fields';
import { DbService } from '../db/db.service';
import { looksLikePdf, MalwareScanner, ObjectStore } from './file-handling';
import { publisherForUrl, urlHost } from './publishers';

export const OBJECT_STORE = Symbol('OBJECT_STORE');
export const MALWARE_SCANNER = Symbol('MALWARE_SCANNER');
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

const DOC_KINDS = ['REGULATION', 'ANNEX', 'REF_PRICE_DECREE', 'HE_DECISION', 'FX_DECREE', 'OTHER'] as const;

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  size: number;
}

const DOCUMENT_SELECT = `
  SELECT d.id, d.doc_kind AS "docKind", d.doc_number AS "docNumber", d.doc_date AS "docDate", d.title,
         d.official_url AS "officialUrl", d.byte_size AS "byteSize", encode(d.sha256, 'hex') AS sha256,
         d.original_filename AS "originalFilename", d.is_secondary AS "isSecondary", d.scan_result AS "scanResult",
         d.recheck_mismatch AS "recheckMismatch", d.created_at AS "createdAt",
         p.name AS "publisherName", p.domain AS "publisherDomain", u.full_name AS "uploadedByName"
    FROM ecr.source_document d
    LEFT JOIN ecr.source_publisher p ON p.id = d.publisher_id
    JOIN ecr.app_user u ON u.id = d.uploaded_by`;

/**
 * Published = cited by a published regulation version or a published reference value (a reference-price, Harga Ekspor
 * or KMK decree); drafts' documents need change-set access (US-20-N2).
 */
const PUBLISHED_DOC = `(EXISTS (SELECT 1 FROM ecr.regulation_document rd WHERE rd.source_document_id = d.id)
  OR EXISTS (SELECT 1 FROM ecr.ref_value v WHERE v.source_document_id = d.id))`;

/** What currently cites a document: regulations and reference values (series code and period). */
const USED_BY = `
  (SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('id', r.entity_id, 'label', r.reg_type || ' ' || r.number || '/' || r.year)), '[]')
     FROM ecr.regulation_document rd JOIN ecr.regulation r ON r.id = rd.regulation_row_id
    WHERE rd.source_document_id = d.id AND r.version_to IS NULL) AS "regulations",
  (SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('id', s.entity_id, 'label',
            s.code || ' ' || to_char(v.period_from, 'YYYY-MM-DD') || ' – ' || to_char(v.period_to, 'YYYY-MM-DD'))), '[]')
     FROM ecr.ref_value v JOIN ecr.ref_series s ON s.entity_id = v.series_entity_id AND s.version_to IS NULL
    WHERE v.source_document_id = d.id AND v.version_to IS NULL) AS "values"`;

/** Official source documents (PRD F-21, Technical Design §4.2.2): immutable evidence stored with SHA-256. */
@Injectable()
export class SourceDocumentsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
  ) {}

  async upload(actor: Actor, file: UploadedFile | undefined, input: unknown) {
    const f = new Fields(asObject(input));
    const meta = {
      docKind: f.oneOf('docKind', DOC_KINDS),
      title: f.text('title', 500),
      docNumber: f.optText('docNumber', 200),
      docDate: f.optDate('docDate'),
      officialUrl: f.optText('officialUrl', 1000),
      // Multipart fields arrive as text.
      isSecondary: asObject(input).isSecondary === 'true' || asObject(input).isSecondary === true,
    };
    if (!file?.buffer?.length) f.fail('file', 'Choose a PDF file.');
    if (meta.officialUrl && !urlHost(meta.officialUrl)) f.fail('officialUrl', 'Enter the full URL (https://…).');
    f.throwIfAny();

    const body = file!.buffer;
    if (body.length > MAX_SOURCE_BYTES) return this.reject(actor, meta.title, 'FILE_TOO_LARGE', 'The file is larger than 25 MB.');
    if (!looksLikePdf(body)) return this.reject(actor, meta.title, 'FILE_REJECTED', 'The file is not a PDF.');

    // US-31-N1 AC2: a source of record comes from an allow-listed official publisher; anything else is secondary.
    const publisher = meta.officialUrl ? await publisherForUrl(this.db.pool, meta.officialUrl) : null;
    if (!meta.isSecondary && !publisher?.isOfficial) {
      throw new ApiError(422, 'SOURCE_NOT_OFFICIAL',
        meta.officialUrl
          ? 'This URL is not on an official publisher; attach it as a secondary reference instead.'
          : 'Enter the official URL the document was downloaded from.',
        { fields: [{ field: 'officialUrl', message: 'Not an allow-listed official publisher.' }] });
    }

    const scan = await this.scanner.scan(body);
    if (scan.verdict === 'INFECTED') {
      return this.reject(actor, meta.title, 'FILE_REJECTED', 'The file failed the virus scan.', scan.signature);
    }

    const sha = createHash('sha256').update(body).digest();
    const existing = await this.db.query<{ id: string }>('SELECT id FROM ecr.source_document WHERE sha256 = $1', [sha]);
    if (existing.rows[0]) return { ...(await this.find(existing.rows[0].id)), reused: true };

    const key = `sources/${new Date().getUTCFullYear()}/${sha.toString('hex')}.pdf`;
    await this.store.put(key, body);
    const id = await this.db.tx(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO ecr.source_document
           (publisher_id, doc_kind, doc_number, doc_date, title, official_url, object_key, byte_size, sha256, content_type,
            original_filename, is_secondary, scan_result, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'application/pdf', $10, $11, $12, $13)
         ON CONFLICT (sha256) DO NOTHING
         RETURNING id`,
        [publisher?.id ?? null, meta.docKind, meta.docNumber, meta.docDate, meta.title, meta.officialUrl, key, body.length, sha,
         file!.originalname.slice(0, 255), meta.isSecondary, scan.verdict, actor.id],
      );
      if (!rows[0]) return null; // Same file uploaded concurrently.
      await this.audit.record(client, {
        action: 'SOURCE_DOCUMENT_UPLOADED',
        actorKind: 'USER',
        actorUserId: actor.id,
        sessionId: actor.sessionId,
        ip: actor.ip,
        userAgent: actor.userAgent,
        entityType: 'SOURCE_DOCUMENT',
        entityId: rows[0].id,
        after: { title: meta.title, sha256: sha.toString('hex'), officialUrl: meta.officialUrl, isSecondary: meta.isSecondary, scan: scan.verdict },
      });
      return rows[0].id;
    });
    if (!id) {
      const again = await this.db.query<{ id: string }>('SELECT id FROM ecr.source_document WHERE sha256 = $1', [sha]);
      return { ...(await this.find(again.rows[0].id)), reused: true };
    }
    return { ...(await this.find(id)), reused: false };
  }

  /** Documents, newest first, each with what currently cites it (PRD F-31: every value traces to its source). */
  async list(q: string | undefined, canSeeDrafts: boolean) {
    const { rows } = await this.db.query(
      `${DOCUMENT_SELECT.replace('\n    FROM ecr.source_document d', `,${USED_BY}\n    FROM ecr.source_document d`)}
        WHERE ($1::text IS NULL OR d.title ILIKE '%' || $1 || '%' OR d.doc_number ILIKE '%' || $1 || '%')
          AND ($2 OR ${PUBLISHED_DOC})
        ORDER BY d.doc_date DESC NULLS LAST, d.created_at DESC LIMIT 200`,
      [q ?? null, canSeeDrafts],
    );
    return rows;
  }

  get(id: string, canSeeDrafts: boolean) {
    return this.find(id, canSeeDrafts);
  }

  /** The stored file, refused if it no longer matches its recorded SHA-256. */
  async file(id: string, canSeeDrafts: boolean): Promise<{ body: Buffer; filename: string }> {
    await this.find(id, canSeeDrafts);
    const { rows } = await this.db.query<{ object_key: string; sha256: Buffer; original_filename: string | null; title: string }>(
      'SELECT object_key, sha256, original_filename, title FROM ecr.source_document WHERE id = $1',
      [id],
    );
    const body = await this.store.get(rows[0].object_key);
    if (!createHash('sha256').update(body).digest().equals(rows[0].sha256)) {
      throw new ApiError(409, 'SOURCE_INTEGRITY', 'The stored file does not match its recorded checksum; Checkers have been alerted.');
    }
    return { body, filename: rows[0].original_filename || `${rows[0].title}.pdf` };
  }

  async publishers() {
    const { rows } = await this.db.query(
      `SELECT name, domain, data_types AS "dataTypes", is_official AS "isOfficial" FROM ecr.source_publisher ORDER BY is_official DESC, name`,
    );
    return rows;
  }

  private async find(id: string, canSeeDrafts = true) {
    const { rows } = await this.db.query(`${DOCUMENT_SELECT} WHERE d.id = $1 AND ($2 OR ${PUBLISHED_DOC})`, [id, canSeeDrafts]);
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Document not found.');
    return rows[0];
  }

  private async reject(actor: Actor, title: string, code: string, message: string, signature?: string): Promise<never> {
    await this.audit.record(this.db.pool, {
      action: 'SOURCE_DOCUMENT_REJECTED',
      actorKind: 'USER',
      actorUserId: actor.id,
      sessionId: actor.sessionId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      entityType: 'SOURCE_DOCUMENT',
      after: { title, code, signature },
    });
    throw new ApiError(422, code, message);
  }
}
