import type { Queryable } from '../db/db.service';
import { ENTITY_DEFS, EntityData, EntityType, loadAtVersion, loadCurrent } from './entities';

export interface CandidateItem {
  entityType: EntityType;
  entityId: string;
  /** WITHDRAW (rollback of a record a version created) removes the record from the candidate state. */
  operation: 'CREATE' | 'UPDATE' | 'END_DATE' | 'WITHDRAW';
  after: EntityData;
}

export interface Candidate {
  type: EntityType;
  data: EntityData;
  /** True when the record comes from the change set rather than the published data. */
  inSet: boolean;
}

/**
 * Published data (latest version of every record, or the records of one past data version) overlaid with a
 * change set's items: the state the data would be in if the set were published now. Volumes are small
 * (hundreds of records), so it is built in memory and read-only once built.
 */
export class CandidateState {
  private readonly byType = new Map<EntityType, { id: string; data: EntityData; inSet: boolean }[]>();

  private constructor(readonly records: Map<string, Candidate>) {}

  static async load(q: Queryable, items: CandidateItem[] = [], version?: number): Promise<CandidateState> {
    const records = new Map<string, Candidate>();
    for (const type of Object.keys(ENTITY_DEFS) as EntityType[]) {
      const rows = version === undefined ? await loadCurrent(q, type) : await loadAtVersion(q, type, version);
      for (const [id, row] of rows) records.set(id, { type, data: row.data, inSet: false });
    }
    for (const it of items) {
      if (it.operation === 'WITHDRAW') records.delete(it.entityId);
      else records.set(it.entityId, { type: it.entityType, data: it.after, inSet: true });
    }
    return new CandidateState(records);
  }

  /** A copy with some records replaced or added (what-if overrides); this state is not changed. */
  with(overrides: { id: string; candidate: Candidate }[]): CandidateState {
    const records = new Map(this.records);
    for (const o of overrides) records.set(o.id, o.candidate);
    return new CandidateState(records);
  }

  get<T extends EntityData>(id: string | null | undefined, type: EntityType): T | undefined {
    const c = id ? this.records.get(id) : undefined;
    return c?.type === type ? (c.data as T) : undefined;
  }

  has(id: string | null | undefined, type: EntityType): boolean {
    return this.get(id, type) !== undefined;
  }

  ofType<T extends EntityData>(type: EntityType): { id: string; data: T; inSet: boolean }[] {
    let list = this.byType.get(type);
    if (!list) {
      list = [...this.records].filter(([, c]) => c.type === type).map(([id, c]) => ({ id, data: c.data, inSet: c.inSet }));
      this.byType.set(type, list);
    }
    // A copy: callers sort the result in place.
    return list.slice() as { id: string; data: T; inSet: boolean }[];
  }
}

/** Whether each source document is only a secondary reference, or failed its weekly hash re-check. */
export async function loadSourceDocs(q: Queryable, ids: string[]) {
  const { rows } = await q.query<{ id: string; is_secondary: boolean; recheck_mismatch: boolean }>(
    'SELECT id, is_secondary, recheck_mismatch FROM ecr.source_document WHERE id = ANY($1::uuid[])',
    [[...new Set(ids)]],
  );
  return new Map(rows.map((r) => [r.id, { isSecondary: r.is_secondary, recheckMismatch: r.recheck_mismatch }]));
}
