import { useEffect, useState } from 'react';
import { api, Me } from '../api';
import { Badge, ErrorText, headStyle, Page, rowStyle, tableStyle, useStepUp, TableWrap } from '../ui';

interface CampaignSummary {
  id: string;
  periodLabel: string;
  status: 'OPEN' | 'CLOSED';
  startedAt: string;
  dueAt: string;
  closedAt: string | null;
  items: number;
  decided: number;
  revoked: number;
  escalated: number;
  waitingForYou: number;
}

interface ReviewItem {
  id: string;
  userId: string;
  user: string;
  email: string;
  userStatus: string;
  role: string;
  roleName: string;
  grantedAt: string;
  lastLoginAt: string | null;
  reviewerRole: 'USER_ADMIN' | 'SUPER_ADMIN';
  decision: 'KEEP' | 'REVOKE' | null;
  reason: string | null;
  reviewer: string | null;
  decidedAt: string | null;
  escalatedAt: string | null;
  roleLive: boolean;
  canDecide: boolean;
}

interface Campaign {
  id: string;
  periodLabel: string;
  status: 'OPEN' | 'CLOSED';
  startedAt: string;
  startedBy: string | null;
  dueAt: string;
  closedAt: string | null;
  closedBy: string | null;
  report: { contentSha256: string; signature: string; fileSha256: string; byteSize: number } | null;
  items: ReviewItem[];
}

interface Verification {
  valid: boolean;
  fileIntact: boolean;
  contentIntact: boolean;
  signatureValid: boolean;
}

const when = (d: string | null) => (d ? new Date(d).toLocaleString() : '—');
const day = (d: string | null) => (d ? new Date(d).toLocaleDateString() : 'never');
const muted = { fontSize: 12, color: 'var(--muted)' } as const;
const REVIEWER = { USER_ADMIN: 'User Admin', SUPER_ADMIN: 'Super Admin' };

/** Quarterly access reviews (PRD F-12): campaigns and their progress. */
export function AccessReviewsPage() {
  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api<CampaignSummary[]>('/admin/reviews').then(setCampaigns).catch(setError);
  }, []);
  return (
    <Page title="Access reviews" wide intro="Every quarter, confirm that each person still needs the access they have.">
      <details className="callout">
        <summary style={{ fontWeight: 700 }}>How this works</summary>
        <p style={{ marginBottom: 0 }}>
          Each quarter, on its first day at 08:00 WIB, ECR lists every role assignment. User Admins keep or remove each one;
          administrators' assignments are reviewed by a Super Admin. Assignments not reviewed within 14 days are escalated to
          Super Admins. When the last one is decided, a signed report is stored for auditors.
        </p>
      </details>
      <ErrorText error={error} />
      {campaigns?.length === 0 && <p>No access review has started yet.</p>}
      {campaigns && campaigns.length > 0 && (
        <TableWrap><table style={tableStyle}>
          <thead><tr style={headStyle}><th>Period</th><th>Status</th><th>Started</th><th>Due</th><th>Progress</th><th>Waiting for you</th></tr></thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.id} style={rowStyle}>
                <td><a href={`/admin/reviews/${c.id}`}>{c.periodLabel}</a></td>
                <td><Badge value={c.status} /></td>
                <td>{when(c.startedAt)}</td>
                <td>{c.status === 'OPEN' ? when(c.dueAt) : <span style={muted}>completed {when(c.closedAt)}</span>}</td>
                <td>
                  {c.decided} of {c.items} reviewed{c.revoked > 0 && `, ${c.revoked} revoked`}
                  {c.escalated > 0 && <> <Badge value="ESCALATED" title={`${c.escalated} not reviewed within 14 days`} /></>}
                </td>
                <td>{c.status === 'OPEN' ? c.waitingForYou : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table></TableWrap>
      )}
    </Page>
  );
}

/** One campaign: keep or revoke each assignment (US-12-P1), and the signed report once complete. */
export function AccessReviewDetail({ me, id }: { me: Me; id: string }) {
  const [c, setC] = useState<Campaign | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [filter, setFilter] = useState<'mine' | 'open' | 'all'>(me.user.permissions.includes('user.manage') ? 'mine' : 'all');
  const [revoking, setRevoking] = useState<{ itemId: string; reason: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [check, setCheck] = useState<Verification | null>(null);
  const { run, dialog } = useStepUp();

  useEffect(() => {
    api<Campaign>(`/admin/reviews/${id}`).then(setC).catch(setError);
  }, [id]);

  async function decide(itemId: string, decision: 'KEEP' | 'REVOKE', reason?: string) {
    setBusy(itemId);
    setError(null);
    try {
      await run(async () => {
        setC(await api<Campaign>(`/admin/reviews/${id}/items/${itemId}`, { method: 'POST', body: { decision, reason } }));
      });
      setRevoking(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  if (!c) return <Page title="Access review">{error ? <ErrorText error={error} /> : 'Loading…'}</Page>;
  const open = c.items.filter((i) => !i.decision);
  const shown = c.items.filter((i) => (filter === 'all' ? true : filter === 'open' ? !i.decision : i.canDecide));
  const count = (d: string) => c.items.filter((i) => i.decision === d).length;

  return (
    <Page title={`Access review ${c.periodLabel}`} wide>
      <p><a href="/admin/reviews">All access reviews</a></p>
      <dl style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: '4px 12px', fontSize: 14 }}>
        <dt>Status</dt><dd style={{ margin: 0 }}><Badge value={c.status} /></dd>
        <dt>Started</dt><dd style={{ margin: 0 }}>{when(c.startedAt)} by {c.startedBy ?? 'the quarterly job'}</dd>
        {c.status === 'OPEN'
          ? <><dt>Due</dt><dd style={{ margin: 0 }}>{when(c.dueAt)} — open assignments are then escalated to Super Admins</dd></>
          : <><dt>Completed</dt><dd style={{ margin: 0 }}>{when(c.closedAt)}, last decision by {c.closedBy}</dd></>}
        <dt>Progress</dt>
        <dd style={{ margin: 0 }}>{c.items.length - open.length} of {c.items.length} reviewed: {count('KEEP')} kept, {count('REVOKE')} revoked</dd>
      </dl>

      {c.report && (
        <section style={{ margin: '16px 0', padding: 12, border: '1px solid var(--line)', background: 'var(--ok)', borderRadius: 6, fontSize: 14 }}>
          <strong>Signed report</strong>{' '}
          <a href={`/api/admin/reviews/${c.id}/report`}>Download PDF</a>{' '}
          <button onClick={() => api<Verification>(`/admin/reviews/${c.id}/report/verify`).then(setCheck).catch(setError)}>Check integrity</button>
          {check && (
            <span role="status" style={{ marginLeft: 8, color: check.valid ? 'var(--ok-ink)' : 'var(--danger-ink)' }}>
              {check.valid
                ? 'Stored file, content hash and signature all check out.'
                : `Check failed: ${[!check.fileIntact && 'stored file changed', !check.contentIntact && 'content hash differs', !check.signatureValid && 'signature invalid'].filter(Boolean).join(', ')}.`}
            </span>
          )}
          <div style={{ ...muted, marginTop: 6, fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>
            Content SHA-256 {c.report.contentSha256}<br />Signature {c.report.signature}
          </div>
        </section>
      )}

      <ErrorText error={error} />
      <div role="radiogroup" aria-label="Show" style={{ display: 'flex', gap: 12, margin: '12px 0', fontSize: 14 }}>
        {([['mine', 'Waiting for me'], ['open', 'Not yet reviewed'], ['all', 'All']] as const).map(([v, label]) => (
          <label key={v}><input type="radio" name="filter" checked={filter === v} onChange={() => setFilter(v)} /> {label}</label>
        ))}
      </div>
      {shown.length === 0 && <p>{filter === 'mine' ? 'Nothing is waiting for you.' : 'No assignments.'}</p>}
      {shown.length > 0 && (
        <TableWrap><table style={tableStyle}>
          <thead>
            <tr style={headStyle}><th>User</th><th>Role</th><th>Last sign-in</th><th>Reviewed by</th><th>Decision</th><th /></tr>
          </thead>
          <tbody>
            {shown.map((i) => (
              <tr key={i.id} style={rowStyle}>
                <td>
                  <a href={`/admin/users?q=${encodeURIComponent(i.email)}`}>{i.user}</a>
                  <div style={muted}>{i.email}{i.userStatus !== 'ACTIVE' && ` · ${i.userStatus.toLowerCase().replace(/_/g, ' ')}`}</div>
                </td>
                <td>{i.roleName}<div style={muted}>since {day(i.grantedAt)}</div></td>
                <td>{day(i.lastLoginAt)}</td>
                <td>{REVIEWER[i.reviewerRole]}</td>
                <td>
                  {i.decision ? (
                    <>
                      <Badge value={i.decision} /> <span style={muted}>{i.reviewer}, {when(i.decidedAt)}</span>
                      {i.reason && <div style={{ fontSize: 13 }}>{i.reason}</div>}
                    </>
                  ) : (
                    <>
                      {i.escalatedAt && <Badge value="ESCALATED" title={`Escalated to Super Admins ${when(i.escalatedAt)}`} />}
                      {!i.roleLive && <div style={{ fontSize: 13, color: 'var(--warn-ink)' }}>Role already removed; record it as revoked.</div>}
                    </>
                  )}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {i.canDecide && revoking?.itemId !== i.id && (
                    <>
                      {i.roleLive && <button disabled={busy !== null} onClick={() => decide(i.id, 'KEEP')}>Keep</button>}{' '}
                      <button disabled={busy !== null} onClick={() => setRevoking({ itemId: i.id, reason: '' })}>Revoke…</button>
                    </>
                  )}
                  {revoking?.itemId === i.id && (
                    <form
                      style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 220 }}
                      onSubmit={(e) => { e.preventDefault(); void decide(i.id, 'REVOKE', revoking.reason); }}
                    >
                      <label style={{ fontSize: 12 }}>
                        Reason for revoking
                        <input autoFocus value={revoking.reason} onChange={(e) => setRevoking({ itemId: i.id, reason: e.target.value })} style={{ width: '100%' }} />
                      </label>
                      <span>
                        <button type="submit" disabled={busy !== null || revoking.reason.trim().length < 3}>Revoke role</button>{' '}
                        <button type="button" onClick={() => setRevoking(null)}>Cancel</button>
                      </span>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></TableWrap>
      )}
      {dialog}
    </Page>
  );
}
