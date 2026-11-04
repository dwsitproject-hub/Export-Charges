import type { Queryable } from '../db/db.service';
import { validateTariffs } from '../tariffs/tariff-validation';
import { CandidateItem, CandidateState, loadSourceDocs } from './candidate';
import { CommodityData, ENTITY_DEFS, EntityType, GroupData, ProductData, regulationLabel, RegulationData } from './entities';

export type Severity = 'ERROR' | 'WARNING' | 'INFO';

export interface Finding {
  ruleCode: string;
  severity: Severity;
  entityType: EntityType | null;
  entityId: string | null;
  field: string | null;
  message: string;
}

export type ItemForValidation = CandidateItem;

export type AddFinding = (severity: Severity, ruleCode: string, type: EntityType | null, entityId: string | null, field: string | null, message: string) => void;

/**
 * Data-quality and business-rule checks for one change set (Technical Design §4.2.4). The candidate state is
 * the published data overlaid with the set's items; rules report on the set's items and on published records
 * they would break. Volumes are small (hundreds of records), so the state is built in memory.
 */
export async function validateItems(q: Queryable, items: ItemForValidation[], today: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const add: AddFinding = (severity, ruleCode, type, entityId, field, message) =>
    findings.push({ ruleCode, severity, entityType: type, entityId, field, message });

  if (!items.length) {
    add('ERROR', 'EMPTY_CHANGE_SET', null, null, null, 'Add at least one change before submitting.');
    return findings;
  }

  const state = await CandidateState.load(q, items);

  // A withdrawn record (rollback of a record a version created) must not be referenced by anything that remains.
  for (const w of items.filter((i) => i.operation === 'WITHDRAW')) {
    const label = ENTITY_DEFS[w.entityType].label(w.after);
    for (const [id, c] of state.records) {
      if (JSON.stringify(c.data).includes(w.entityId)) {
        add('ERROR', 'ROLLBACK-REFERENCED', w.entityType, w.entityId, null,
          `${label} cannot be withdrawn: ${ENTITY_DEFS[c.type].label(c.data as never)} (${c.type.toLowerCase().replace(/_/g, ' ')} ${id.slice(-8)}) still refers to it.`);
      }
    }
  }
  const regulations = state.ofType<RegulationData>('REGULATION');
  const commodities = state.ofType<CommodityData>('COMMODITY');
  const groups = state.ofType<GroupData>('PRODUCT_GROUP');
  const products = state.ofType<ProductData>('PRODUCT');
  const exists = (id: string | null, type: EntityType) => state.has(id, type);
  /** Still valid after an inclusive end date (or open-ended). */
  const outlives = (validTo: string | null, end: string) => validTo === null || validTo > end;

  const sourceDocs = await loadSourceDocs(q, regulations.filter((r) => r.inSet).flatMap((r) => r.data.documents.map((d) => d.sourceDocumentId)));

  // ------------------------------------------------------------ regulations
  for (const r of regulations.filter((x) => x.inSet)) {
    const d = r.data;
    const label = regulationLabel(d);
    const dup = regulations.find((o) => o.id !== r.id && o.data.regType === d.regType && o.data.year === d.year
      && o.data.number.toUpperCase() === d.number.toUpperCase());
    if (dup) add('ERROR', 'BR-REG-01', 'REGULATION', r.id, 'number', `${label} is already registered.`);

    if (d.effectiveOn && d.promulgatedOn && d.effectiveOn < d.promulgatedOn) {
      add('WARNING', 'REG-DATES', 'REGULATION', r.id, 'effectiveOn', `${label} takes effect before it was promulgated — confirm the dates.`);
    }
    if (d.status === 'IN_FORCE' && d.endsOn && d.endsOn < today) {
      add('WARNING', 'DQ-09', 'REGULATION', r.id, 'status', `${label} is marked in force but ended on ${d.endsOn}.`);
    }
    for (const rel of d.relations) {
      if (rel.regulationId === r.id) add('ERROR', 'BR-REG-02', 'REGULATION', r.id, 'relations', `${label} cannot ${rel.relation.toLowerCase()} itself.`);
      else if (!exists(rel.regulationId, 'REGULATION')) add('ERROR', 'REF-MISSING', 'REGULATION', r.id, 'relations', `${label} refers to a regulation that is not registered.`);
    }

    // BR-SRC-01 / FR-SRC-02: a regulation is published only with an official source document of record.
    const official = d.documents.filter((doc) => {
      const s = sourceDocs.get(doc.sourceDocumentId);
      return s && !s.isSecondary && doc.role !== 'SECONDARY';
    });
    if (!official.length) {
      add('ERROR', 'BR-SRC-01', 'REGULATION', r.id, 'documents', `${label} needs its official source document (PDF from an allow-listed publisher).`);
    }
    for (const doc of d.documents) {
      if (sourceDocs.get(doc.sourceDocumentId)?.recheckMismatch) {
        add('ERROR', 'SRC-HASH', 'REGULATION', r.id, 'documents', `A source document of ${label} no longer matches the official file.`);
      }
    }
  }

  // BR-REG-02: the amendment graph stays acyclic.
  const edges = new Map(regulations.map((r) => [r.id, r.data.relations.map((rel) => rel.regulationId).filter((id) => id !== r.id)]));
  const inCycle = findCycleMembers(edges);
  for (const r of regulations.filter((x) => x.inSet && inCycle.has(x.id))) {
    add('ERROR', 'BR-REG-02', 'REGULATION', r.id, 'relations', `${regulationLabel(r.data)} is part of a circular amendment chain.`);
  }

  // ------------------------------------------------------------ commodities and groups
  for (const c of commodities.filter((x) => x.inSet)) {
    if (commodities.some((o) => o.id !== c.id && o.data.code === c.data.code)) {
      add('ERROR', 'COMMODITY-CODE', 'COMMODITY', c.id, 'code', `Commodity code ${c.data.code} is already used.`);
    }
    if (c.data.validTo) {
      const live = groups.filter((g) => g.data.commodityId === c.id && outlives(g.data.validTo, c.data.validTo!));
      if (live.length) {
        add('ERROR', 'US-22-N1', 'COMMODITY', c.id, 'validTo', `End the groups of ${c.data.code} first (${live.map((g) => g.data.label).join(', ')}).`);
      }
    }
  }
  for (const g of groups.filter((x) => x.inSet)) {
    if (!exists(g.data.commodityId, 'COMMODITY')) {
      add('ERROR', 'REF-MISSING', 'PRODUCT_GROUP', g.id, 'commodityId', `Group ${g.data.label} needs a registered commodity.`);
    }
    if (groups.some((o) => o.id !== g.id && o.data.commodityId === g.data.commodityId && o.data.code === g.data.code)) {
      add('ERROR', 'GROUP-CODE', 'PRODUCT_GROUP', g.id, 'code', `Group code ${g.data.code} is already used in this commodity.`);
    }
    if (g.data.validTo) {
      const live = products.filter((p) => p.data.groupId === g.id && outlives(p.data.validTo, g.data.validTo!));
      if (live.length) {
        add('ERROR', 'US-22-N1', 'PRODUCT_GROUP', g.id, 'validTo',
          `${g.data.label} still has ${live.length} product(s) valid after ${g.data.validTo}; end them first.`);
      }
    }
  }

  // ------------------------------------------------------------ products
  const productsByHs = new Map<string, { id: string; name: string }[]>();
  for (const p of products) {
    for (const h of p.data.hsCodes) {
      const list = productsByHs.get(h.code) ?? [];
      list.push({ id: p.id, name: p.data.nameId });
      productsByHs.set(h.code, list);
    }
  }

  for (const p of products.filter((x) => x.inSet)) {
    const d = p.data;
    const name = d.nameId;
    // BR-PRD-01 and DQ-01 (US-23-N1 AC1): the list of missing fields blocks submission.
    const missing = [
      !d.groupId && 'group',
      !d.classificationRegulationId && 'classification regulation',
      !d.validFrom && 'validity start',
      !d.hsCodes.length && 'HS code',
    ].filter(Boolean);
    if (missing.length) add('ERROR', d.hsCodes.length ? 'BR-PRD-01' : 'DQ-01', 'PRODUCT', p.id, null, `${name}: missing ${missing.join(', ')}.`);

    if (d.groupId && !exists(d.groupId, 'PRODUCT_GROUP')) add('ERROR', 'REF-MISSING', 'PRODUCT', p.id, 'groupId', `${name}: the group is not registered.`);
    if (d.classificationRegulationId) {
      const reg = state.get<RegulationData>(d.classificationRegulationId, 'REGULATION');
      if (!reg) {
        add('ERROR', 'REF-MISSING', 'PRODUCT', p.id, 'classificationRegulationId', `${name}: the classification regulation is not registered.`);
      } else if (reg.status === 'DRAFT_RANCANGAN') {
        add('INFO', 'DQ-10', 'PRODUCT', p.id, 'classificationRegulationId', `${name}: classified under a draft regulation (${regulationLabel(reg)}).`);
      }
    }
    if (!d.definition || !d.parameters.length) {
      add('WARNING', 'DQ-05', 'PRODUCT', p.id, d.definition ? 'parameters' : 'definition',
        `${name}: no ${d.definition ? 'technical parameters' : 'definition'} — users may not identify it correctly.`);
    }
    if (d.itemNoAsPrinted) {
      const twin = products.find((o) => o.id !== p.id && o.data.groupId === d.groupId && o.data.itemNoAsPrinted === d.itemNoAsPrinted);
      if (twin) add('INFO', 'DQ-04', 'PRODUCT', p.id, 'itemNoAsPrinted', `${name}: item no. ${d.itemNoAsPrinted} is also printed for ${twin.data.nameId}.`);
    }
    // BR-PRD-04: shared tariff posts are computed and shown to the Maker now and to users later.
    for (const h of d.hsCodes) {
      const others = (productsByHs.get(h.code) ?? []).filter((o) => o.id !== p.id);
      if (others.length) {
        add('INFO', 'BR-PRD-04', 'PRODUCT', p.id, 'hsCodes', `${name}: shares HS ${h.code} with ${others.map((o) => o.name).join(', ')}.`);
      }
    }
  }

  // A record in the set must not leave published records pointing at nothing.
  for (const it of items.filter((i) => i.operation === 'END_DATE' && i.entityType === 'REGULATION')) {
    const end = (it.after as RegulationData).endsOn!;
    const dependants = products.filter((p) => p.data.classificationRegulationId === it.entityId && outlives(p.data.validTo, end));
    if (dependants.length) {
      add('WARNING', 'REG-ENDED', 'REGULATION', it.entityId, 'endsOn',
        `${dependants.length} product(s) classified under ${regulationLabel(it.after as RegulationData)} stay valid after ${end}.`);
    }
  }

  await validateTariffs(q, state, items, today, add);
  return findings;
}

/** Nodes on a directed cycle (iterative DFS colouring). */
export function findCycleMembers(edges: Map<string, string[]>): Set<string> {
  const state = new Map<string, 1 | 2>();
  const members = new Set<string>();
  for (const start of edges.keys()) {
    if (state.has(start)) continue;
    const path: string[] = [];
    const stack: { node: string; next: number }[] = [{ node: start, next: 0 }];
    state.set(start, 1);
    path.push(start);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const targets = edges.get(top.node) ?? [];
      if (top.next < targets.length) {
        const t = targets[top.next++];
        if (state.get(t) === 1) {
          for (let i = path.indexOf(t); i < path.length; i++) members.add(path[i]);
        } else if (!state.has(t)) {
          state.set(t, 1);
          path.push(t);
          stack.push({ node: t, next: 0 });
        }
      } else {
        state.set(top.node, 2);
        path.pop();
        stack.pop();
      }
    }
  }
  return members;
}
