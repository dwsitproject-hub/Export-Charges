/**
 * Corrects the "as printed" item number and the annex page of products already loaded from the official palm data
 * set, after the seed file itself was corrected (seed/official-palm-2026-11.json; Permenperin 32/2024 numbering).
 *
 * ECR publishes the correction by itself, like its automatic CPO and KMK updates: one change set under its own account
 * with an UPDATE of each product whose number or page differs, published directly (audited as
 * CHANGESET_PUBLISHED_DIRECT with the operator), and every user is told in ECR and by email. Products are matched by
 * group and Indonesian name (and HS codes where a name repeats); only those two fields change, so no charge changes.
 */
import { AUTO_UPDATE_ACTOR } from '../auto-update/system-account';
import type { Queryable } from '../db/db.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { CandidateState } from '../registry/candidate';
import type { ChangeSetsService } from '../registry/change-sets.service';
import type { GroupData, ProductData } from '../registry/entities';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const CORRECTION_TITLE = 'Permenperin 32/2024 item numbers and annex pages corrected — automatic update';
/** Title of the earlier version of this command, which left the correction for a Checker. */
export const CHECKER_DRAFT_TITLE = 'Permenperin 32/2024 item numbers and annex pages corrected — drafted by ECR for a Checker';

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
  /** The data version the correction was published as, or null when there was nothing to correct. */
  version: number | null;
  /** Earlier correction drafts still waiting for a Checker, cancelled because this one replaces them. */
  cancelled: string[];
  /** How many people were told. */
  notified: number;
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

/**
 * Publishes the correction and tells every user; does nothing when every product already matches the seed. A
 * correction an earlier run left for a Checker is cancelled first (this one replaces it), unless a Checker has already
 * taken it into review or approved it.
 */
export async function publishProductCorrections(
  sets: ChangeSetsService, notifications: NotificationsService, q: Queryable, seed: Json, operator: string,
): Promise<CorrectionResult> {
  const { rows: pending } = await q.query<{ id: string; status: string }>(
    `SELECT id, status FROM ecr.change_set
      WHERE created_by = $1 AND title = ANY($2::text[]) AND status IN ('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'REJECTED', 'APPROVED', 'SCHEDULED')
      ORDER BY created_at`,
    [AUTO_UPDATE_ACTOR.id, [CORRECTION_TITLE, CHECKER_DRAFT_TITLE]],
  );
  const busy = pending.find((p) => !['DRAFT', 'SUBMITTED', 'REJECTED'].includes(p.status));
  if (busy) {
    throw new Error(`A Checker already has the correction (${busy.status}): /change-sets/${busy.id}. Let them finish it, or reject it and run this again.`);
  }
  const cancelled: string[] = [];
  for (const p of pending) {
    if (p.status === 'SUBMITTED') await sets.withdraw(AUTO_UPDATE_ACTOR, p.id);
    await sets.discard(AUTO_UPDATE_ACTOR, p.id);
    cancelled.push(p.id);
  }

  const { corrections, unmatched } = await findProductCorrections(q, seed);
  if (!corrections.length) return { corrections, unmatched, setId: null, version: null, cancelled, notified: 0 };

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
  const what = `${numbers} item number(s) and ${pages} annex page(s), on ${corrections.length} product(s)`;
  const set = await sets.create(AUTO_UPDATE_ACTOR, {
    title: CORRECTION_TITLE,
    justification: `Correction of how products are numbered, requested by ${operator} and published by ECR without a Checker. `
      + `The item numbers and annex pages loaded from ${seed.version} did not follow Permenperin 32/2024 as printed (e.g. Group III `
      + 'skipped no. 3, so every later item was one too high; Group II printed two products as no. 10). Each was re-read from the '
      + `official PDF of Permenperin 32/2024, Lampiran, in annex order: ${what} change. `
      + 'Only these two fields change: names, specifications, HS codes, duty and levy are untouched, so no charge changes.',
  }) as { id: string };
  const state = await CandidateState.load(q);
  for (const c of corrections) {
    const current = state.get<ProductData>(c.entityId, 'PRODUCT')!;
    await sets.saveItem(AUTO_UPDATE_ACTOR, set.id, {
      entityType: 'PRODUCT', operation: 'UPDATE', entityId: c.entityId,
      after: { ...current, itemNoAsPrinted: c.itemNo.to, annexPage: c.annexPage.to },
    });
  }
  // Submitting runs the usual checks; a set that fails them stays a draft and nothing is published. Checkers get no
  // "waiting for review" notice: the set is published the moment it passes.
  try {
    await sets.submit(AUTO_UPDATE_ACTOR, set.id, { acknowledgeWarnings: true }, { notifyCheckers: false });
  } catch (err) {
    throw new Error(`The correction failed its checks (${(err as Error).message}); it is left as a draft: /change-sets/${set.id}.`);
  }
  const version = await sets.publishDirect(AUTO_UPDATE_ACTOR, set.id, `Permenperin 32/2024 numbering correction requested by ${operator}.`);
  const notified = await notifications.everyone(q, {
    kind: 'AUTO_UPDATE',
    title: 'Updated: Permenperin 32/2024 item numbers and annex pages corrected',
    body: `ECR corrected how ${corrections.length} palm products are numbered, to match the official Permenperin 32/2024 annex: `
      + `${numbers} item numbers (as printed) and ${pages} annex pages. Names, specifications, HS codes, duty and levy are unchanged. `
      + `It is published as data version ${version}.`,
    link: `/bulletins/${version}`, versionNo: version, changeSetId: set.id, dedupeKey: `published:${version}`,
  });
  return { corrections, unmatched, setId: set.id, version, cancelled, notified };
}
