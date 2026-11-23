import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTO_UPDATE_ACTOR, AUTO_UPDATE_USER_ID } from '../src/auto-update/system-account';
import { NotificationsService } from '../src/notifications/notifications.service';
import { CandidateState } from '../src/registry/candidate';
import { ChangeSetsService } from '../src/registry/change-sets.service';
import { SourceDocumentsService } from '../src/registry/source-documents.service';
import { CHECKER_DRAFT_TITLE, CORRECTION_TITLE, findProductCorrections, publishProductCorrections } from '../src/scripts/official-corrections';
import { loadOfficialSeed } from '../src/scripts/official-seed';
import { Agent, Harness, Me, Person, startHarness } from './harness';

const SEED = JSON.parse(readFileSync(join(__dirname, '..', 'seed', 'official-palm-2026-11.json'), 'utf8'));
type Row = { nameId: string; nameEn: string | null; itemNoAsPrinted: string | null; bk: { usdPerMt: string | null }; pe: { usdPerMt: string | null } };

/** The seed as first loaded: Group III numbered from 4 after no. 2 (no. 3 skipped), and some annex pages wrong. */
function oldSeed() {
  const seed = structuredClone(SEED);
  for (const p of seed.products) {
    const no = Number(p.data.itemNoAsPrinted);
    if (p.group === 'III' && no >= 3) p.data.itemNoAsPrinted = String(no + 1);
    if (p.group === 'III') p.data.annexPage += 4;
  }
  return seed;
}

describe('correcting Permenperin item numbers in a loaded registry', () => {
  let h: Harness;
  let maker: Person;
  let checker: Person;
  let viewer: { agent: Agent; me: Me };
  const send = (p: Person, path: string) => p.agent.post(path).set('X-CSRF-Token', p.me.csrfToken).send({});
  const catalogue = async () => ((await viewer.agent.get('/api/catalogue?date=2026-11-19&pageSize=200').expect(200)).body as { rows: Row[] }).rows;
  const row = (rows: Row[], nameId: string) => rows.find((r) => r.nameId === nameId)!;
  const POME = SEED.products.find((p: { key: string }) => p.key === '3-9').data.nameId as string;
  const correct = (operator: string) =>
    publishProductCorrections(h.app.get(ChangeSetsService), h.app.get(NotificationsService), h.pool, SEED, operator);

  /** A correction left for a Checker by the earlier version of the command (one product, submitted). */
  async function checkerDraft() {
    const sets = h.app.get(ChangeSetsService);
    const { corrections } = await findProductCorrections(h.pool, SEED);
    const c = corrections.find((x) => x.nameId === POME)!;
    const set = await sets.create(AUTO_UPDATE_ACTOR, { title: CHECKER_DRAFT_TITLE, justification: 'Drafted for a Checker by the earlier command.' }) as { id: string };
    const state = await CandidateState.load(h.pool);
    await sets.saveItem(AUTO_UPDATE_ACTOR, set.id, {
      entityType: 'PRODUCT', operation: 'UPDATE', entityId: c.entityId,
      after: { ...state.get(c.entityId, 'PRODUCT')!, itemNoAsPrinted: '8', annexPage: 19 },
    });
    await sets.submit(AUTO_UPDATE_ACTOR, set.id, { acknowledgeWarnings: true });
    return set.id;
  }

  beforeAll(async () => {
    h = await startHarness();
    maker = await h.privileged(['MAKER']);
    checker = await h.privileged(['CHECKER']);
    viewer = await h.signedIn(['VIEWER']);
    await loadOfficialSeed(h.app.get(ChangeSetsService), h.app.get(SourceDocumentsService),
      { id: maker.me.user.id, permissions: new Set(), sessionId: '00000000-0000-0000-0000-000000000000', ip: '127.0.0.1', userAgent: 'test' },
      oldSeed(), 'Registry with the old numbering', async (d) => Buffer.from(`%PDF-1.7\n% ${d.key}\n%%EOF\n`));
  });
  afterAll(async () => h?.close());

  it('the corrected seed numbers every group 1, 2, 3 … without gaps or repeats', () => {
    for (const g of ['I', 'II', 'III', 'IV', 'V']) {
      const nos = SEED.products.filter((p: { group: string; classification: string }) => p.group === g && p.classification === 'PERMEN32')
        .map((p: { data: { itemNoAsPrinted: string } }) => Number(p.data.itemNoAsPrinted));
      expect(nos).toEqual(nos.map((_: number, i: number) => i + 1));
    }
    expect(SEED.products.find((p: { key: string }) => p.key === '3-9').data).toMatchObject({ itemNoAsPrinted: '8', annexPage: 19 });
  });

  it('publishes the correction without a Checker, replaces a waiting draft, tells everyone, and changes no charge', async () => {
    const before = await catalogue();
    expect(row(before, POME).itemNoAsPrinted).toBe('9');
    const waiting = await checkerDraft();

    const r = await correct('Test Operator (op@example.com)');
    expect(r.unmatched).toEqual([]);
    expect(r.cancelled).toEqual([waiting]);
    // Every Group III product (all 18: their pages were wrong) and nothing else.
    expect(r.corrections).toHaveLength(18);
    expect(r.corrections.every((c) => c.group === 'III')).toBe(true);
    expect(r.corrections.find((c) => c.nameId === POME)).toMatchObject({ itemNo: { from: '9', to: '8' }, annexPage: { from: 23, to: 19 } });
    expect(r.version).toEqual(expect.any(Number));

    // The waiting draft is cancelled; the correction is published directly by ECR, never reviewed.
    expect((await h.pool.query('SELECT status FROM ecr.change_set WHERE id = $1', [waiting])).rows[0].status).toBe('CANCELLED');
    const { rows: [set] } = await h.pool.query(
      'SELECT status, created_by, reviewed_by, version_no, title, justification FROM ecr.change_set WHERE id = $1', [r.setId]);
    expect(set).toMatchObject({ status: 'PUBLISHED', created_by: AUTO_UPDATE_USER_ID, reviewed_by: null, version_no: r.version, title: CORRECTION_TITLE });
    expect(set.justification).toContain('Test Operator (op@example.com)');
    const { rows: audit } = await h.pool.query(`SELECT 1 FROM ecr.audit_event WHERE action = 'CHANGESET_PUBLISHED_DIRECT' AND entity_id = $1`, [r.setId]);
    expect(audit).toHaveLength(1);

    // Every active user is told once, with a link to the bulletin of the new version.
    const { rows: told } = await h.pool.query(
      `SELECT user_id, title, body FROM ecr.notification WHERE kind = 'AUTO_UPDATE' AND link = $1`, [`/bulletins/${r.version}`]);
    const { rows: active } = await h.pool.query(`SELECT id FROM ecr.app_user WHERE status = 'ACTIVE'`);
    expect(told.map((n) => n.user_id).sort()).toEqual(active.map((u) => u.id).sort());
    expect(told[0].title).toBe('Updated: Permenperin 32/2024 item numbers and annex pages corrected');
    expect(told[0].body).toContain('18 palm products');
    expect(told[0].body).toContain('duty and levy are unchanged');
    // No "waiting for review" notice for a change that is already published.
    const { rows: review } = await h.pool.query(`SELECT 1 FROM ecr.notification WHERE kind = 'CHANGESET_SUBMITTED' AND change_set_id = $1`, [r.setId]);
    expect(review).toEqual([]);

    const after = await catalogue();
    expect(row(after, POME).itemNoAsPrinted).toBe('8');
    expect(row(after, 'RBD Palm Olein').itemNoAsPrinted).toBe('9');
    for (const b of before) {
      const a = row(after, b.nameId);
      expect([a.bk.usdPerMt, a.pe.usdPerMt]).toEqual([b.bk.usdPerMt, b.pe.usdPerMt]);
    }
    // Nothing is left to correct, and running again publishes nothing and tells no one.
    expect((await findProductCorrections(h.pool, SEED)).corrections).toEqual([]);
    expect(await correct('x')).toMatchObject({ setId: null, version: null, notified: 0, cancelled: [] });
  });

  it('leaves a correction alone once a Checker has taken it into review', async () => {
    const sets = h.app.get(ChangeSetsService);
    const set = await sets.create(AUTO_UPDATE_ACTOR, { title: CHECKER_DRAFT_TITLE, justification: 'Drafted for a Checker by the earlier command.' }) as { id: string };
    const { rows: [p] } = await h.pool.query(`SELECT entity_id FROM ecr.product WHERE name_id = $1 AND version_to IS NULL`, [POME]);
    const state = await CandidateState.load(h.pool);
    await sets.saveItem(AUTO_UPDATE_ACTOR, set.id, {
      entityType: 'PRODUCT', operation: 'UPDATE', entityId: p.entity_id,
      after: { ...state.get(p.entity_id, 'PRODUCT')!, annexPage: 20 },
    });
    await sets.submit(AUTO_UPDATE_ACTOR, set.id, { acknowledgeWarnings: true });
    await send(checker, `/api/change-sets/${set.id}/start-review`).expect(200);

    await expect(correct('x')).rejects.toThrow(/A Checker already has the correction \(IN_REVIEW\)/);
    expect((await h.pool.query('SELECT status FROM ecr.change_set WHERE id = $1', [set.id])).rows[0].status).toBe('IN_REVIEW');
  });
});
