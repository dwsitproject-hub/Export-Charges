import { ApiError } from '../common/api-error';
import { wibMidnight, wibToday } from '../common/fields';
import type { Queryable } from '../db/db.service';
import { CandidateItem, CandidateState } from '../registry/candidate';
import type { EntityData, EntityType } from '../registry/entities';
import type { RefSeriesData, RefValueData } from '../tariffs/tariff-entities';

export interface DataView {
  state: CandidateState;
  date: string;
  versionNo: number;
  publishedAt: Date | null;
  /** Approved change sets scheduled to take effect on or before a future date, applied on top (US-45-N1 AC2). */
  scheduledApplied: { changeSetId: string; title: string; effectiveAt: Date }[];
  notices: string[];
}

/**
 * The data a read sees for business date D and data version V (Technical Design §4.3.1). V defaults to the
 * latest published version. For a future D on the latest version, approved sets scheduled by D are included.
 */
export async function dataView(q: Queryable, date: string, requestedVersion?: number): Promise<DataView> {
  const { rows: [latest] } = await q.query<{ v: number | null }>('SELECT max(version_no) AS v FROM ecr.data_version');
  const latestNo = latest.v ?? 0;
  const versionNo = requestedVersion ?? latestNo;
  if (versionNo < 0 || versionNo > latestNo) throw new ApiError(400, 'INVALID_INPUT', `Data version ${versionNo} does not exist (latest is ${latestNo}).`);

  const notices: string[] = [];
  const scheduledApplied: DataView['scheduledApplied'] = [];
  let state: CandidateState;
  if (versionNo < latestNo) {
    state = await CandidateState.load(q, [], versionNo);
    notices.push(`Showing data version ${versionNo}; version ${latestNo} is the latest.`);
  } else if (date > wibToday()) {
    const { rows } = await q.query<{ id: string; title: string; effective_at: Date; entity_type: EntityType; entity_id: string; operation: CandidateItem['operation']; after: EntityData }>(
      `SELECT cs.id, cs.title, cs.effective_at, i.entity_type, i.entity_id, i.operation, i.after
         FROM ecr.change_set cs JOIN ecr.change_item i ON i.change_set_id = cs.id
        WHERE cs.status = 'SCHEDULED' AND cs.effective_at <= $1
        ORDER BY cs.approved_at, i.created_at`,
      [wibMidnight(date)],
    );
    state = await CandidateState.load(q, rows.map((r) => ({ entityType: r.entity_type, entityId: r.entity_id, operation: r.operation, after: r.after })));
    for (const r of rows) {
      if (!scheduledApplied.some((s) => s.changeSetId === r.id)) scheduledApplied.push({ changeSetId: r.id, title: r.title, effectiveAt: r.effective_at });
    }
    notices.push(scheduledApplied.length
      ? `Future date — ${scheduledApplied.length} scheduled change set(s) applied; values not yet published are not known.`
      : 'Future date — no scheduled changes; values not yet published are not known.');
  } else {
    state = await CandidateState.load(q);
  }

  // US-45-N1 AC1: say when the date is before the earliest loaded reference price.
  const priceSeries = new Set(state.ofType<RefSeriesData>('REF_SERIES').filter((s) => s.data.kind === 'REFERENCE_PRICE').map((s) => s.id));
  const earliest = state.ofType<RefValueData>('REF_VALUE').filter((v) => priceSeries.has(v.data.seriesId ?? ''))
    .map((v) => v.data.periodFrom).sort()[0];
  if (earliest && date < earliest) notices.push(`No reference prices loaded before ${earliest}.`);

  const { rows: [published] } = await q.query<{ published_at: Date | null }>(
    'SELECT published_at FROM ecr.data_version WHERE version_no = $1', [versionNo],
  );
  return { state, date, versionNo, publishedAt: published?.published_at ?? null, scheduledApplied, notices };
}
