import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import { DbService } from '../db/db.service';
import {
  CommodityData,
  ENTITY_DEFS,
  EntityData,
  EntityType,
  GroupData,
  loadCurrent,
  loadHistory,
  ProductData,
  regulationLabel,
  RegulationData,
  VersionRow,
} from './entities';

const RELATION_INVERSE: Record<string, string> = { AMENDS: 'AMENDED_BY', REVOKES: 'REVOKED_BY', IMPLEMENTS: 'IMPLEMENTED_BY' };

/**
 * Published master data only (latest data version). Drafts never appear here (US-20-N2); they are visible
 * through change sets to roles with changeset.read.
 */
@Injectable()
export class RegistryReadService {
  constructor(private readonly db: DbService) {}

  // ------------------------------------------------------------------ regulations

  async regulations(filter: { q?: string; status?: string; type?: string }) {
    const regs = await loadCurrent<RegulationData>(this.db.pool, 'REGULATION');
    const docs = await this.documents([...regs.values()].flatMap((r) => r.data.documents.map((d) => d.sourceDocumentId)));
    const q = filter.q?.toLowerCase();
    return [...regs.values()]
      .filter((r) => !filter.status || r.data.status === filter.status)
      .filter((r) => !filter.type || r.data.regType === filter.type)
      .filter((r) => !q || `${regulationLabel(r.data)} ${r.data.titleId} ${r.data.titleEn ?? ''} ${r.data.issuer}`.toLowerCase().includes(q))
      .sort((a, b) => b.data.year - a.data.year || regulationLabel(a.data).localeCompare(regulationLabel(b.data), undefined, { numeric: true }))
      .map((r) => this.regulationView(r, regs, docs));
  }

  async regulation(entityId: string) {
    const regs = await loadCurrent<RegulationData>(this.db.pool, 'REGULATION');
    const current = regs.get(entityId);
    if (!current) throw new ApiError(404, 'NOT_FOUND', 'Regulation not found.');
    const history = await loadHistory<RegulationData>(this.db.pool, 'REGULATION', entityId);
    const docs = await this.documents(history.flatMap((r) => r.data.documents.map((d) => d.sourceDocumentId)));
    const { rows: products } = await this.db.query<{ entity_id: string; name_id: string; item_no_as_printed: string | null }>(
      `SELECT entity_id, name_id, item_no_as_printed FROM ecr.product
        WHERE version_to IS NULL AND classification_regulation_id = $1 ORDER BY name_id`,
      [entityId],
    );
    return {
      ...this.regulationView(current, regs, docs),
      classifiedProducts: products.map((p) => ({ entityId: p.entity_id, nameId: p.name_id, itemNoAsPrinted: p.item_no_as_printed })),
      history: await this.historyView('REGULATION', history),
    };
  }

  private regulationView(r: VersionRow<RegulationData>, all: Map<string, VersionRow<RegulationData>>, docs: Map<string, DocSummary>) {
    const label = (id: string) => (all.get(id) ? regulationLabel(all.get(id)!.data) : 'Unregistered regulation');
    const relatedBy = [...all.values()].flatMap((o) =>
      o.data.relations
        .filter((rel) => rel.regulationId === r.entityId)
        .map((rel) => ({ relation: RELATION_INVERSE[rel.relation], regulationId: o.entityId, label: regulationLabel(o.data) })),
    );
    return {
      entityId: r.entityId,
      label: regulationLabel(r.data),
      ...r.data,
      relations: r.data.relations.map((rel) => ({ ...rel, label: label(rel.regulationId) })),
      relatedBy,
      documents: r.data.documents.map((d) => ({ ...d, ...docs.get(d.sourceDocumentId) })),
      versionFrom: r.versionFrom,
    };
  }

  // ------------------------------------------------------------------ commodities and products

  async commodities() {
    const commodities = await loadCurrent<CommodityData>(this.db.pool, 'COMMODITY');
    const groups = await loadCurrent<GroupData>(this.db.pool, 'PRODUCT_GROUP');
    const { rows: counts } = await this.db.query<{ group_entity_id: string; n: number }>(
      'SELECT group_entity_id, count(*)::int AS n FROM ecr.product WHERE version_to IS NULL GROUP BY group_entity_id',
    );
    const countOf = new Map(counts.map((c) => [c.group_entity_id, c.n]));
    return [...commodities.values()]
      .sort((a, b) => a.data.code.localeCompare(b.data.code))
      .map((c) => ({
        entityId: c.entityId,
        ...c.data,
        groups: [...groups.values()]
          .filter((g) => g.data.commodityId === c.entityId)
          .sort((a, b) => a.data.ordinal - b.data.ordinal)
          .map((g) => ({ entityId: g.entityId, ...g.data, productCount: countOf.get(g.entityId) ?? 0 })),
      }));
  }

  async products(filter: { q?: string; commodityId?: string; groupId?: string }) {
    const ctx = await this.productContext();
    const q = filter.q?.toLowerCase().trim();
    const hsDigits = q?.replace(/[.\s]/g, '');
    return [...ctx.products.values()]
      .filter((p) => !filter.groupId || p.data.groupId === filter.groupId)
      .filter((p) => !filter.commodityId || ctx.groups.get(p.data.groupId ?? '')?.data.commodityId === filter.commodityId)
      .filter((p) => {
        if (!q) return true;
        const text = [p.data.nameId, p.data.nameEn, ...p.data.synonyms, p.data.definition].join(' ').toLowerCase();
        return text.includes(q) || (!!hsDigits && /^\d{2,8}$/.test(hsDigits) && p.data.hsCodes.some((h) => h.code.replace(/\./g, '').startsWith(hsDigits)));
      })
      .sort((a, b) => ctx.sortKey(a).localeCompare(ctx.sortKey(b), undefined, { numeric: true }))
      .map((p) => {
        const group = ctx.groups.get(p.data.groupId ?? '');
        const primary = p.data.parameters.find((x) => x.isPrimary);
        return {
          entityId: p.entityId,
          itemNoAsPrinted: p.data.itemNoAsPrinted,
          nameId: p.data.nameId,
          nameEn: p.data.nameEn,
          group: group ? { entityId: group.entityId, label: group.data.label } : null,
          commodityCode: ctx.commodities.get(group?.data.commodityId ?? '')?.data.code ?? null,
          keySpec: primary ? `${primary.name} ${primary.operator === 'TEXT' ? '' : primary.operator + ' '}${primary.valueText}${primary.unit ? ' ' + primary.unit : ''}` : null,
          hsCodes: p.data.hsCodes.map((h) => ({ code: h.code, isEx: h.isEx })),
          sharedHs: p.data.hsCodes.some((h) => (ctx.byHs.get(h.code)?.length ?? 0) > 1),
          classificationRegulation: ctx.regLabel(p.data.classificationRegulationId),
          validFrom: p.data.validFrom,
          validTo: p.data.validTo,
        };
      });
  }

  async product(entityId: string) {
    const ctx = await this.productContext();
    const p = ctx.products.get(entityId);
    if (!p) throw new ApiError(404, 'NOT_FOUND', 'Product not found.');
    const group = ctx.groups.get(p.data.groupId ?? '');
    return {
      entityId,
      ...p.data,
      group: group ? { entityId: group.entityId, label: group.data.label, code: group.data.code } : null,
      commodity: group ? (ctx.commodities.get(group.data.commodityId ?? '')?.data ?? null) : null,
      classificationRegulation: p.data.classificationRegulationId
        ? { entityId: p.data.classificationRegulationId, label: ctx.regLabel(p.data.classificationRegulationId) }
        : null,
      // BR-PRD-04 / US-24-P1 AC3: other products on the same tariff post.
      hsCodes: p.data.hsCodes.map((h) => ({
        ...h,
        sharedWith: (ctx.byHs.get(h.code) ?? []).filter((o) => o.entityId !== entityId),
      })),
      versionFrom: p.versionFrom,
      history: await this.historyView('PRODUCT', await loadHistory<ProductData>(this.db.pool, 'PRODUCT', entityId)),
    };
  }

  private async productContext() {
    const [products, groups, commodities, regs] = await Promise.all([
      loadCurrent<ProductData>(this.db.pool, 'PRODUCT'),
      loadCurrent<GroupData>(this.db.pool, 'PRODUCT_GROUP'),
      loadCurrent<CommodityData>(this.db.pool, 'COMMODITY'),
      loadCurrent<RegulationData>(this.db.pool, 'REGULATION'),
    ]);
    const byHs = new Map<string, { entityId: string; nameId: string }[]>();
    for (const p of products.values()) {
      for (const h of p.data.hsCodes) byHs.set(h.code, [...(byHs.get(h.code) ?? []), { entityId: p.entityId, nameId: p.data.nameId }]);
    }
    return {
      products,
      groups,
      commodities,
      byHs,
      regLabel: (id: string | null) => (id && regs.get(id) ? regulationLabel(regs.get(id)!.data) : null),
      sortKey: (p: VersionRow<ProductData>) => {
        const g = groups.get(p.data.groupId ?? '');
        return `${String(g?.data.ordinal ?? 9999).padStart(5, '0')} ${p.data.itemNoAsPrinted ?? ''} ${p.data.nameId}`;
      },
    };
  }

  // ------------------------------------------------------------------ HS codes, versions

  async hsCodes(q: string | undefined) {
    const digits = (q ?? '').replace(/\D/g, '').slice(0, 8);
    const { rows } = await this.db.query(
      `SELECT c.code, c.description, v.label AS "btkiVersion"
         FROM ecr.hs_code c JOIN ecr.btki_version v ON v.id = c.btki_version_id
        WHERE v.is_current AND c.code_digits LIKE $1 || '%'
        ORDER BY c.code_digits LIMIT 50`,
      [digits],
    );
    return rows;
  }

  async dataVersions(limit: number) {
    const { rows } = await this.db.query(
      `SELECT v.version_no AS "versionNo", v.published_at AS "publishedAt", v.change_set_id AS "changeSetId",
              cs.title, cs.kind, cs.rollback_of_version AS "rollbackOfVersion", v.rolled_back_by_version AS "rolledBackByVersion",
              v.bulletin, u.full_name AS "publishedByName",
              v.published_by = '00000000-0000-0000-0000-00000000ec01'::uuid AS automatic
         FROM ecr.data_version v
         JOIN ecr.change_set cs ON cs.id = v.change_set_id
         LEFT JOIN ecr.app_user u ON u.id = v.published_by
        ORDER BY v.version_no DESC LIMIT $1`,
      [limit],
    );
    return rows;
  }

  /** Version history with who approved each version (US-30-P1). */
  private async historyView<T extends EntityData>(type: EntityType, rows: VersionRow<T>[]) {
    const { rows: versions } = await this.db.query<{ version_no: number; published_at: Date; title: string; approver: string | null; rolled_back_by_version: number | null }>(
      `SELECT v.version_no, v.published_at, cs.title, u.full_name AS approver, v.rolled_back_by_version
         FROM ecr.data_version v JOIN ecr.change_set cs ON cs.id = v.change_set_id
         LEFT JOIN ecr.app_user u ON u.id = cs.reviewed_by
        WHERE v.version_no = ANY($1::int[])`,
      [rows.map((r) => r.versionFrom)],
    );
    const byNo = new Map(versions.map((v) => [v.version_no, v]));
    return rows
      .map((r) => ({
        versionFrom: r.versionFrom,
        versionTo: r.versionTo,
        publishedAt: byNo.get(r.versionFrom)?.published_at,
        changeSetId: r.changeSetId,
        changeSetTitle: byNo.get(r.versionFrom)?.title,
        approvedBy: byNo.get(r.versionFrom)?.approver ?? null,
        /** Set when this version was rolled back (US-30-P2 AC1: stays visible, marked ROLLED_BACK). */
        rolledBackByVersion: byNo.get(r.versionFrom)?.rolled_back_by_version ?? null,
        label: ENTITY_DEFS[type].label(r.data),
        data: r.data,
      }))
      .reverse();
  }

  private async documents(ids: string[]): Promise<Map<string, DocSummary>> {
    if (!ids.length) return new Map();
    const { rows } = await this.db.query<DocSummary & { id: string }>(
      `SELECT d.id, d.title, d.doc_number AS "docNumber", d.doc_date AS "docDate", d.official_url AS "officialUrl",
              encode(d.sha256, 'hex') AS sha256, d.byte_size AS "byteSize", d.is_secondary AS "isSecondary",
              p.name AS "publisherName"
         FROM ecr.source_document d LEFT JOIN ecr.source_publisher p ON p.id = d.publisher_id
        WHERE d.id = ANY($1::uuid[])`,
      [[...new Set(ids)]],
    );
    return new Map(rows.map(({ id, ...rest }) => [id, rest]));
  }
}

interface DocSummary {
  title: string;
  docNumber: string | null;
  docDate: string | null;
  officialUrl: string | null;
  sha256: string;
  byteSize: string;
  isSecondary: boolean;
  publisherName: string | null;
}
