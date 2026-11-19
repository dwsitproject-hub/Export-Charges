import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTO_UPDATE_USER_ID } from '../src/auto-update/system-account';
import { ChangeSetsService } from '../src/registry/change-sets.service';
import { SourceDocumentsService } from '../src/registry/source-documents.service';
import { CORRECTION_TITLE, draftProductCorrections, findProductCorrections } from '../src/scripts/official-corrections';
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
  let checker: Person;
  let viewer: { agent: Agent; me: Me };
  const send = (p: Person, path: string) => p.agent.post(path).set('X-CSRF-Token', p.me.csrfToken).send({});
  const catalogue = async () => ((await viewer.agent.get('/api/catalogue?date=2026-11-19&pageSize=200').expect(200)).body as { rows: Row[] }).rows;
  const row = (rows: Row[], nameId: string) => rows.find((r) => r.nameId === nameId)!;
  const POME = SEED.products.find((p: { key: string }) => p.key === '3-9').data.nameId as string;

  beforeAll(async () => {
    h = await startHarness();
    const maker = await h.privileged(['MAKER']);
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

  it('drafts one change set for a Checker; once approved the numbers match the annex and no charge changes', async () => {
    const before = await catalogue();
    expect(row(before, POME).itemNoAsPrinted).toBe('9');

    const r = await draftProductCorrections(h.app.get(ChangeSetsService), h.pool, SEED, 'Test Operator (op@example.com)');
    expect(r.unmatched).toEqual([]);
    expect(r.notSubmitted).toBeNull();
    // Every Group III product (all 18: their pages were wrong) and nothing else.
    expect(r.corrections).toHaveLength(18);
    expect(r.corrections.every((c) => c.group === 'III')).toBe(true);
    expect(r.corrections.find((c) => c.nameId === POME)).toMatchObject({ itemNo: { from: '9', to: '8' }, annexPage: { from: 23, to: 19 } });

    const { rows: [set] } = await h.pool.query('SELECT status, created_by, title, justification FROM ecr.change_set WHERE id = $1', [r.setId]);
    expect(set).toMatchObject({ status: 'SUBMITTED', created_by: AUTO_UPDATE_USER_ID, title: CORRECTION_TITLE });
    expect(set.justification).toContain('Test Operator (op@example.com)');
    const { rows: told } = await h.pool.query(`SELECT 1 FROM ecr.notification WHERE user_id = $1 AND kind = 'CHANGESET_SUBMITTED' AND link = $2`,
      [checker.me.user.id, `/change-sets/${r.setId}`]);
    expect(told).toHaveLength(1);

    // A second run while it waits is refused, so the Checkers never see two corrections.
    await expect(draftProductCorrections(h.app.get(ChangeSetsService), h.pool, SEED, 'x')).rejects.toThrow(/already waiting/);

    await send(checker, `/api/change-sets/${r.setId}/start-review`).expect(200);
    await send(checker, `/api/change-sets/${r.setId}/approve`).expect(200);

    const after = await catalogue();
    expect(row(after, POME).itemNoAsPrinted).toBe('8');
    expect(row(after, 'RBD Palm Olein').itemNoAsPrinted).toBe('9');
    for (const b of before) {
      const a = row(after, b.nameId);
      expect([a.bk.usdPerMt, a.pe.usdPerMt]).toEqual([b.bk.usdPerMt, b.pe.usdPerMt]);
    }
    // Nothing is left to correct, and running again drafts nothing.
    expect((await findProductCorrections(h.pool, SEED)).corrections).toEqual([]);
    expect((await draftProductCorrections(h.app.get(ChangeSetsService), h.pool, SEED, 'x')).setId).toBeNull();
  });
});
