import { useEffect, useState } from 'react';
import { api, Me } from '../api';
import { Badge, ErrorText, headStyle, Page, rowStyle, tableStyle, useStepUp, TableWrap } from '../ui';

interface JobRun {
  id: string;
  jobName: string;
  status: 'RUNNING' | 'OK' | 'FAILED';
  startedAt: string;
  finishedAt: string | null;
  details: Record<string, unknown> | null;
  error: string | null;
  triggeredBy: string | null;
}

interface Job {
  name: string;
  description: string;
  schedule: string;
  lastRun: JobRun | null;
}

interface DqFinding {
  ruleCode: string;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  entityType: string | null;
  field: string | null;
  message: string;
  label: string | null;
  link: string | null;
}

const when = (d: string | null) => (d ? new Date(d).toLocaleString() : '—');

/** Short plain-text summary of a run's details, e.g. "errors 1 · warnings 3". */
function summary(details: Record<string, unknown> | null): string {
  if (!details) return '';
  const label = (k: string) => k.replace(/([A-Z])/g, ' $1').toLowerCase();
  return Object.entries(details)
    .filter(([, v]) => v !== null && (typeof v !== 'object' || Array.isArray(v)))
    .map(([k, v]) => Array.isArray(v)
      ? `${label(k)}: ${v.length ? v.map((x) => (x && typeof x === 'object' && 'code' in x ? String(x.code) : JSON.stringify(x))).join(', ') : 'none'}`
      : `${label(k)} ${String(v)}`)
    .join(' · ');
}

/** Scheduled jobs (Technical Design §4.2.7): last run of each, history, and "Run now" for Super Admins. */
export function JobsPage({ me }: { me: Me }) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [history, setHistory] = useState<{ name: string; runs: JobRun[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const { run, dialog } = useStepUp();
  const canRun = me.user.permissions.includes('config.manage');

  const load = () => api<Job[]>('/jobs').then(setJobs).catch(setError);
  useEffect(() => {
    void load();
  }, []);

  async function runNow(name: string) {
    setBusy(name);
    setError(null);
    try {
      await run(async () => { await api<JobRun>(`/jobs/${name}/run`, { method: 'POST' }); });
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Page title="Background jobs" wide intro="Tasks the system runs by itself on a timetable (WIB), and whether their last run worked.">
      <ErrorText error={error} />
      {jobs && (
        <TableWrap><table style={tableStyle}>
          <thead><tr style={headStyle}><th>Job</th><th>When</th><th>Last run</th><th>Result</th>{canRun && <th />}</tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.name} style={rowStyle}>
                <td><button style={{ all: 'unset', cursor: 'pointer', color: 'var(--info-ink)' }} onClick={() => api<JobRun[]>(`/jobs/${j.name}/runs`).then((runs) => setHistory({ name: j.name, runs })).catch(setError)}>{j.name}</button>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{j.description}</div></td>
                <td>{j.schedule}</td>
                <td>{j.lastRun ? <>{when(j.lastRun.startedAt)}{j.lastRun.triggeredBy && <div style={{ fontSize: 12, color: 'var(--muted)' }}>by {j.lastRun.triggeredBy}</div>}</> : 'Not yet'}</td>
                <td>{j.lastRun && <><Badge value={j.lastRun.status} /> <span style={{ fontSize: 13 }}>{j.lastRun.error ?? summary(j.lastRun.details)}</span></>}</td>
                {canRun && <td><button disabled={busy !== null} onClick={() => runNow(j.name)}>{busy === j.name ? 'Running…' : 'Run now'}</button></td>}
              </tr>
            ))}
          </tbody>
        </table></TableWrap>
      )}
      {history && (
        <section style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 18 }}>Last runs of {history.name}</h2>
          <TableWrap><table style={tableStyle}>
            <thead><tr style={headStyle}><th>Started</th><th>Finished</th><th>Result</th><th>Details</th></tr></thead>
            <tbody>
              {history.runs.map((r) => (
                <tr key={r.id} style={rowStyle}>
                  <td>{when(r.startedAt)}{r.triggeredBy && <div style={{ fontSize: 12, color: 'var(--muted)' }}>run now by {r.triggeredBy}</div>}</td>
                  <td>{when(r.finishedAt)}</td>
                  <td><Badge value={r.status} /></td>
                  <td style={{ fontSize: 13 }}>{r.error ?? summary(r.details)}</td>
                </tr>
              ))}
            </tbody>
          </table></TableWrap>
        </section>
      )}
      {dialog}
    </Page>
  );
}

/** US-51-P1: the nightly data-quality findings on published data. */
export function DataQualityPage() {
  const [data, setData] = useState<{ run: { at: string; records: number; errors: number; warnings: number; info: number } | null; findings: DqFinding[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api<typeof data>('/dq/findings').then(setData).catch(setError);
  }, []);
  if (!data) return <Page title="Data checks">{error ? <ErrorText error={error} /> : 'Loading…'}</Page>;
  return (
    <Page title="Data checks" wide intro="Every night the system checks the published data for gaps and mistakes. Fix what it finds with a rate update.">
      {!data.run && <p>The nightly check has not run yet.</p>}
      {data.run && (
        <p>
          Nightly check of {data.run.records} published records, {when(data.run.at)}: <strong>{data.run.errors} errors</strong>,
          {' '}{data.run.warnings} warnings, {data.run.info} notes.{data.run.errors + data.run.warnings > 0 && ' Fix them with a rate update.'}
        </p>
      )}
      {data.run && data.findings.length === 0 && <p role="status" style={{ color: 'var(--ok-ink)' }}>No findings.</p>}
      {data.findings.length > 0 && (
        <TableWrap><table style={tableStyle}>
          <thead><tr style={headStyle}><th>Severity</th><th>Rule</th><th>Record</th><th>Message</th></tr></thead>
          <tbody>
            {data.findings.map((f, i) => (
              <tr key={i} style={rowStyle}>
                <td><Badge value={f.severity} /></td>
                <td><code style={{ fontSize: 12 }}>{f.ruleCode}</code></td>
                <td>{f.link ? <a href={f.link}>{f.label ?? f.entityType}</a> : (f.label ?? f.entityType ?? '—')}</td>
                <td>{f.message}</td>
              </tr>
            ))}
          </tbody>
        </table></TableWrap>
      )}
    </Page>
  );
}
