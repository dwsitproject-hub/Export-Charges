import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { api, Me } from '../api';
import { Badge, ErrorText, headStyle, Page, rowStyle, tableStyle, TableWrap } from '../ui';

interface AuditEvent {
  chainSeq: number;
  occurredAt: string;
  actorKind: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actorName: string | null;
  sessionId: string | null;
  ip: string | null;
  userAgent: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  hash: string;
}

interface Facet {
  value: string;
  count: number;
}

const FILTERS = ['actor', 'action', 'entityType', 'entityId', 'from', 'to'] as const;
type Filters = Record<(typeof FILTERS)[number], string>;
const EMPTY: Filters = { actor: '', action: '', entityType: '', entityId: '', from: '', to: '' };

/** Timestamps in WIB, the time the PRD and the regulations use (US-50-P1 AC1). */
const wib = (iso: string) =>
  `${new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' })} WIB`;

/** Where an audited record can be opened in ECR, when it has a page. */
function entityLink(type: string | null, id: string | null): string | null {
  if (!type || !id) return null;
  if (type === 'CHANGE_SET') return `/change-sets/${id}`;
  if (type === 'IMPORT_JOB') return `/imports/${id}`;
  if (type === 'EVIDENCE_PACK') return `/verify/${id}`;
  return null;
}

function readFilters(): Filters {
  const p = new URLSearchParams(window.location.search);
  return Object.fromEntries(FILTERS.map((k) => [k, p.get(k) ?? ''])) as Filters;
}

const query = (f: Filters) => new URLSearchParams(Object.entries(f).filter(([, v]) => v.trim())).toString();

/** Audit log search for Auditors and Super Admins (PRD F-50, US-50-P1). Read-only; filters live in the URL. */
export function AuditLogPage({ me }: { me: Me }) {
  const [form, setForm] = useState<Filters>(readFilters);
  const [applied, setApplied] = useState<Filters>(readFilters);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [facets, setFacets] = useState<{ actions: Facet[]; entityTypes: Facet[] } | null>(null);
  const [chain, setChain] = useState<{ intact: boolean; brokenAtChainSeq: number | null; events: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const canExport = me.user.permissions.includes('audit.export');

  useEffect(() => {
    api<{ actions: Facet[]; entityTypes: Facet[] }>('/audit-events/facets').then(setFacets).catch(setError);
  }, []);

  useEffect(() => {
    let live = true;
    setError(null);
    api<{ items: AuditEvent[]; nextBefore: number | null }>(`/audit-events?${query(applied)}`)
      .then((r) => {
        if (!live) return;
        setEvents(r.items);
        setNext(r.nextBefore);
      })
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, [query(applied)]);

  function search(e: FormEvent) {
    e.preventDefault();
    const q = query(form);
    window.history.replaceState(null, '', `${window.location.pathname}${q ? `?${q}` : ''}`);
    setOpen(null);
    setApplied({ ...form });
  }

  async function more() {
    if (next === null) return;
    try {
      const r = await api<{ items: AuditEvent[]; nextBefore: number | null }>(`/audit-events?${query(applied)}&before=${next}`);
      setEvents((list) => [...(list ?? []), ...r.items]);
      setNext(r.nextBefore);
    } catch (e) {
      setError(e);
    }
  }

  async function verify() {
    setChecking(true);
    try {
      setChain(await api('/audit-events/verify'));
    } catch (e) {
      setError(e);
    } finally {
      setChecking(false);
    }
  }

  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const field = { display: 'block', width: '100%' } as const;
  return (
    <Page title="Audit log" wide intro="A permanent record of who did what, and when. Filter by person, action or date.">
      <form onSubmit={search} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, alignItems: 'end' }}>
        <label style={{ fontSize: 13 }}>Who (name, email or “system”)<input value={form.actor} onChange={set('actor')} style={field} /></label>
        <label style={{ fontSize: 13 }}>Action
          <select value={form.action} onChange={set('action')} style={field}>
            <option value="">Any</option>
            {facets?.actions.map((a) => <option key={a.value} value={a.value}>{a.value} ({a.count})</option>)}
          </select>
        </label>
        <label style={{ fontSize: 13 }}>Entity type
          <select value={form.entityType} onChange={set('entityType')} style={field}>
            <option value="">Any</option>
            {facets?.entityTypes.map((a) => <option key={a.value} value={a.value}>{a.value} ({a.count})</option>)}
          </select>
        </label>
        <label style={{ fontSize: 13 }}>Entity id<input value={form.entityId} onChange={set('entityId')} style={field} /></label>
        <label style={{ fontSize: 13 }}>From (WIB)<input type="date" value={form.from} onChange={set('from')} style={field} /></label>
        <label style={{ fontSize: 13 }}>To (WIB)<input type="date" value={form.to} onChange={set('to')} style={field} /></label>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="submit">Search</button>
          <button type="button" onClick={() => { setForm(EMPTY); setApplied(EMPTY); window.history.replaceState(null, '', window.location.pathname); }}>Clear</button>
        </div>
      </form>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', margin: '12px 0', fontSize: 14 }}>
        <button type="button" disabled={checking} onClick={verify}>{checking ? 'Checking…' : 'Verify hash chain'}</button>
        {chain && (
          <span role="status" style={{ color: chain.intact ? 'var(--ok-ink)' : 'var(--danger-ink)', fontWeight: 600 }}>
            {chain.intact ? `Intact: all ${chain.events.toLocaleString('en')} events verified.` : `BROKEN at event ${chain.brokenAtChainSeq}: treat as a security incident.`}
          </span>
        )}
        {canExport && (
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 12 }}>
            <a href={`/api/audit-events/export?${query(applied)}${query(applied) ? '&' : ''}format=csv`} download>Export CSV</a>
            <a href={`/api/audit-events/export?${query(applied)}${query(applied) ? '&' : ''}format=xlsx`} download>Export XLSX</a>
          </span>
        )}
      </div>
      <ErrorText error={error} />

      {events && events.length === 0 && <p>No events match.</p>}
      {events && events.length > 0 && (
        <TableWrap><table style={tableStyle}>
          <thead><tr style={headStyle}><th>#</th><th>Time (WIB)</th><th>Who</th><th>Action</th><th>Entity</th><th>Reason</th><th>IP</th></tr></thead>
          <tbody>
            {events.map((e) => {
              const link = entityLink(e.entityType, e.entityId);
              return (
                <Fragment key={e.chainSeq}>
                  <tr style={{ ...rowStyle, cursor: 'pointer', background: open === e.chainSeq ? 'var(--accent-soft)' : undefined }}
                    onClick={() => setOpen(open === e.chainSeq ? null : e.chainSeq)} aria-expanded={open === e.chainSeq}>
                    <td style={{ fontSize: 12, color: 'var(--muted)' }}>{e.chainSeq}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{wib(e.occurredAt)}</td>
                    <td>{e.actorKind === 'USER' ? (e.actorName ?? e.actorEmail ?? e.actorUserId) : <Badge value={e.actorKind} />}
                      {e.actorEmail && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{e.actorEmail}</div>}</td>
                    <td><code style={{ fontSize: 12 }}>{e.action}</code></td>
                    <td style={{ fontSize: 13 }}>{e.entityType}{e.entityId && <div style={{ fontSize: 12, color: 'var(--muted)', wordBreak: 'break-all' }}>
                      {link ? <a href={link} onClick={(ev) => ev.stopPropagation()}>{e.entityId}</a> : e.entityId}</div>}</td>
                    <td style={{ fontSize: 13 }}>{e.reason}</td>
                    <td style={{ fontSize: 12 }}>{e.ip}</td>
                  </tr>
                  {open === e.chainSeq && (
                    <tr style={rowStyle}>
                      <td />
                      <td colSpan={6} style={{ fontSize: 13, paddingBottom: 12 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                          <div><strong>Before</strong><pre style={{ whiteSpace: 'pre-wrap', background: 'var(--danger)', padding: 8, margin: '4px 0', fontSize: 12 }}>{e.before === null ? '—' : JSON.stringify(e.before, null, 2)}</pre></div>
                          <div><strong>After</strong><pre style={{ whiteSpace: 'pre-wrap', background: 'var(--ok)', padding: 8, margin: '4px 0', fontSize: 12 }}>{e.after === null ? '—' : JSON.stringify(e.after, null, 2)}</pre></div>
                        </div>
                        <div style={{ color: 'var(--muted)' }}>User agent: {e.userAgent ?? '—'} · Session: {e.sessionId ?? '—'}</div>
                        <div style={{ color: 'var(--muted)', wordBreak: 'break-all' }}>Hash: <code style={{ fontSize: 11 }}>{e.hash}</code></div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table></TableWrap>
      )}
      {next !== null && <p><button onClick={more}>Load older events</button></p>}
    </Page>
  );
}
