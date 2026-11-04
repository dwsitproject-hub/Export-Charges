import { useEffect, useState } from 'react';
import { api, Me } from '../api';
import { Badge, ErrorText, Page } from '../ui';

interface WatchItem {
  id: string;
  kind: 'STATUS_CHANGE' | 'NEW_DOCUMENT' | 'NEW_FILE' | 'FILE_CHANGED';
  title: string;
  detail: string;
  url: string;
  source: string;
  status: 'OPEN' | 'DONE' | 'DISMISSED';
  detectedAt: string;
  regulationId: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

interface WatchList {
  items: WatchItem[];
  lastRun: { at: string; status: string; details: { reads?: number; unreachable?: string[] } | null } | null;
}

const KIND_TEXT: Record<WatchItem['kind'], string> = {
  STATUS_CHANGE: 'Status change',
  NEW_DOCUMENT: 'New document',
  NEW_FILE: 'New file',
  FILE_CHANGED: 'File changed',
};
const when = (d: string) => new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** PRD FR-SRC-03 / FR-SRC-04: what the daily check of the official publishers found, for Makers to act on. */
export function SourceWatchPage({ me }: { me: Me }) {
  const [data, setData] = useState<WatchList | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const canResolve = me.user.permissions.includes('changeset.create');

  const load = () => api<WatchList>('/source-watch').then(setData).catch(setError);
  useEffect(() => {
    void load();
  }, []);

  async function resolve(id: string, status: 'DONE' | 'DISMISSED', reason: string | null) {
    setError(null);
    try {
      await api(`/source-watch/${id}/resolve`, { method: 'POST', body: { status, note: reason } });
      setDismissing(null);
      setNote('');
      await load();
    } catch (e) {
      setError(e);
    }
  }

  if (!data) return <Page title="Source watch">{error ? <ErrorText error={error} /> : 'Loading…'}</Page>;
  const open = data.items.filter((i) => i.status === 'OPEN');
  const closed = data.items.filter((i) => i.status !== 'OPEN');
  const run = data.lastRun;

  return (
    <Page title="New regulation watch" wide intro="Each morning the system checks government websites for new or changed regulations. Review what it found and enter what applies as a rate update.">
      <details className="callout">
        <summary style={{ fontWeight: 700 }}>How this works</summary>
        <p style={{ marginBottom: 0 }}>
          Every morning at 06:00 WIB ECR reads the BPK regulation database, JDIH Kemenkeu and JDIH Kemendag. It reports regulations
          amended or revoked, new documents on export duty, levy and reference prices, and official files that changed. It never
          changes data: register what applies in a rate update, then mark the item done.
        </p>
      </details>
      {run && (
        <p className={`callout${run.status === 'OK' ? '' : ' danger'}`}>
          Last check {when(run.at)}: {run.status === 'OK' ? 'completed' : 'failed'}
          {run.details?.unreachable?.length ? ` — ${run.details.unreachable.length} of ${run.details.reads} pages could not be read` : ''}.
        </p>
      )}
      {!run && <p className="callout">The check has not run yet. A Super Admin can run it now on the Jobs page.</p>}
      <ErrorText error={error} />

      <h2>Open ({open.length})</h2>
      {open.length === 0 && <p className="muted">Nothing waiting.</p>}
      <ul className="list">
        {open.map((i) => (
          <li key={i.id}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <Badge value={i.kind === 'FILE_CHANGED' || i.kind === 'STATUS_CHANGE' ? 'WARNING' : 'OPEN'} title={KIND_TEXT[i.kind]} />
              <strong>{i.title}</strong>
            </div>
            <div className="small" style={{ margin: '4px 0' }}>{i.detail}</div>
            <div className="small muted">
              {KIND_TEXT[i.kind]} · {i.source} · found {when(i.detectedAt)} · <a href={i.url} target="_blank" rel="noreferrer noopener">Open the official page</a>
              {i.regulationId && <> · <a href={`/regulations/${i.regulationId}`}>Regulation in ECR</a></>}
            </div>
            {canResolve && dismissing !== i.id && (
              <div className="actions" style={{ marginTop: 8 }}>
                <a className="button" href="/change-sets">Open rate updates</a>
                <button type="button" onClick={() => resolve(i.id, 'DONE', null)}>Mark done</button>
                <button type="button" onClick={() => { setDismissing(i.id); setNote(''); }}>Dismiss…</button>
              </div>
            )}
            {canResolve && dismissing === i.id && (
              <form className="actions" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); void resolve(i.id, 'DISMISSED', note); }}>
                <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why no change is needed" aria-label="Reason to dismiss"
                  style={{ flex: '1 1 260px' }} />
                <button type="submit" disabled={note.trim().length < 3}>Dismiss</button>
                <button type="button" onClick={() => setDismissing(null)}>Cancel</button>
              </form>
            )}
          </li>
        ))}
      </ul>

      {closed.length > 0 && (
        <details style={{ marginTop: 24 }}>
          <summary>Resolved ({closed.length})</summary>
          <ul className="list">
            {closed.map((i) => (
              <li key={i.id}>
                <Badge value={i.status} /> {i.title}
                <div className="small muted">
                  {i.resolvedBy} · {i.resolvedAt && when(i.resolvedAt)}{i.resolutionNote ? ` · ${i.resolutionNote}` : ''} · <a href={i.url} target="_blank" rel="noreferrer noopener">official page</a>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Page>
  );
}
