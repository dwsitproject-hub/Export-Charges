/**
 * Corrects the "as printed" item number and the annex page of products already loaded from the official palm data
 * set, after the seed file itself was corrected (seed/official-palm-2026-11.json; Permenperin 32/2024 numbering).
 *
 * Nothing is changed directly: ECR drafts one change set (under its own account, like its regulation drafts) with an
 * UPDATE of each product whose number or page differs, and submits it, so the Checkers are notified and one of them
 * approves it in ECR. Products are matched by group and Indonesian name (and HS codes where a name repeats); only
 * those two fields change.
 */
import { AUTO_UPDATE_ACTOR } from '../auto-update/system-account';
import { submitForChecker } from '../auto-update/drafts';
import type { Queryable } from '../db/db.service';
import { CandidateState } from '../registry/candidate';
import type { ChangeSetsService } from '../registry/change-sets.service';
import type { GroupData, ProductData } from '../registry/entities';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const CORRECTION_TITLE = 'Permenperin 32/2024 item numbers and annex pages corrected — drafted by ECR for a Checker';

export interface ProductCorrection {
  entityId: string;
  group: string;
  nameId: string;
  itemNo: { from: string | null; to: string | null };
  annexPage: { from: number | null; to: number | null };
}

export interface CorrectionResult {
  corrections: ProductCorrection[];
  /** Seed products with no single published product of the same group and name (left alone). */
  unmatched: string[];
  setId: string | null;
  /** Why the change set could not be submitted (it then stays a draft), or null. */
  notSubmitted: string | null;
}

const key = (group: string, nameId: string) => `${group}\u0000${nameId.trim().toLowerCase()}`;

/** What would change: published products whose item number or annex page differs from the seed. */
export async function findProductCorrections(q: Queryable, seed: Json): Promise<{ corrections: ProductCorrection[]; unmatched: string[] }> {
  const state = await CandidateState.load(q);
  const groupCode = new Map(state.ofType<GroupData>('PRODUCT_GROUP').map((g) => [g.id, g.data.code]));
  const published = new Map<string, { id: string; data: ProductData }[]>();
  for (const p of state.ofType<ProductData>('PRODUCT')) {
    const k = key(groupCode.get(p.data.groupId ?? '') ?? '', p.data.nameId);
    published.set(k, [...(published.get(k) ?? []), p]);
  }
  const corrections: ProductCorrection[] = [];
  const unmatched: string[] = [];
  // Two products can share a name in a group (Group V has two "Biosurfactant"); their HS codes tell them apart.
  const hs = (codes: { code: string }[]) => codes.map((h) => h.code).sort().join(',');
  for (const s of seed.products as Json[]) {
    let matches = published.get(key(s.group, s.data.nameId)) ?? [];
    if (matches.length > 1) matches = matches.filter((p) => hs(p.data.hsCodes) === hs(s.data.hsCodes));
    if (matches.length !== 1) {
      unmatched.push(`Group ${s.group} ${s.data.nameId}${matches.length ? ` (${matches.length} products share this name)` : ''}`);
      continue;
    }
    const [p] = matches;
    const itemNo = s.data.itemNoAsPrinted ?? null;
    const annexPage = s.data.annexPage ?? null;
    if (p.data.itemNoAsPrinted === itemNo && p.data.annexPage === annexPage) continue;
    corrections.push({
      entityId: p.id, group: s.group, nameId: p.data.nameId,
      itemNo: { from: p.data.itemNoAsPrinted, to: itemNo }, annexPage: { from: p.data.annexPage, to: annexPage },
    });
  }
  return { corrections, unmatched };
}

/** Drafts and submits the correction change set; does nothing when every product already matches the seed. */
export async function draftProductCorrections(sets: ChangeSetsService, q: Queryable, seed: Json, operator: string): Promise<CorrectionResult> {
  const { rows: pending } = await q.query<{ id: string; status: string }>(
    `SELECT id, status FROM ecr.change_set
      WHERE created_by = $1 AND title = $2 AND status IN ('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'REJECTED', 'APPROVED', 'SCHEDULED')`,
    [AUTO_UPDATE_ACTOR.id, CORRECTION_TITLE],
  );
  if (pending[0]) {
    throw new Error(`A correction is already waiting (${pending[0].status}): /change-sets/${pending[0].id}. Approve, reject or cancel it first.`);
  }

  const { corrections, unmatched } = await findProductCorrections(q, seed);
  if (!corrections.length) return { corrections, unmatched, setId: null, notSubmitted: null };

  // A product that is already in someone's open change set cannot be added; stop before drafting half a correction.
  const { rows: held } = await q.query<{ entity_id: string; title: string }>(
    `SELECT i.entity_id, cs.title FROM ecr.change_item i JOIN ecr.change_set cs ON cs.id = i.change_set_id
      WHERE i.entity_type = 'PRODUCT' AND i.is_open AND i.entity_id = ANY($1::uuid[])`,
    [corrections.map((c) => c.entityId)],
  );
  if (held.length) {
    const names = held.map((h) => `${corrections.find((c) => c.entityId === h.entity_id)!.nameId} (in "${h.title}")`);
    throw new Error(`These products are in open change sets; finish those first: ${names.join('; ')}.`);
  }

  const numbers = corrections.filter((c) => c.itemNo.from !== c.itemNo.to).length;
  const pages = corrections.filter((c) => c.annexPage.from !== c.annexPage.to).length;
  const set = await sets.create(AUTO_UPDATE_ACTOR, {
    title: CORRECTION_TITLE,
    justification: `Correction of how products are numbered, requested by ${operator}. The item numbers and annex pages loaded from `
      + `${seed.version} did not follow Permenperin 32/2024 as printed (e.g. Group III skipped no. 3, so every later item was one too high; `
      + 'Group II printed two products as no. 10). Each was re-read from the official PDF of Permenperin 32/2024, Lampiran, '
      + `in annex order: ${numbers} item number(s) and ${pages} annex page(s) change, on ${corrections.length} product(s). `
      + 'Only these two fields change: names, specifications, HS codes, duty and levy are untouched, so no charge changes. '
      + 'Please compare a few items with the PDF before approving.',
  }) as { id: string };
  const state = await CandidateState.load(q);
  for (const c of corrections) {
    const current = state.get<ProductData>(c.entityId, 'PRODUCT')!;
    await sets.saveItem(AUTO_UPDATE_ACTOR, set.id, {
      entityType: 'PRODUCT', operation: 'UPDATE', entityId: c.entityId,
      after: { ...current, itemNoAsPrinted: c.itemNo.to, annexPage: c.annexPage.to },
    });
  }
  const notSubmitted = await submitForChecker(sets, set.id);
  return { corrections, unmatched, setId: set.id, notSubmitted };
}
