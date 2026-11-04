import { useEffect, useState, type FormEvent } from 'react';
import { ApiFailure, commitImport, getImport, ImportJob, ImportReportEntry, listImports, uploadImport } from '../api';
import { Badge, ErrorText, headStyle, Page, rowStyle, tableStyle, TableWrap } from '../ui';

/** Excel bulk import (PRD F-28): template, upload with dry run, report, change set. */
export function ImportsPage() {
  const [list, setList] = useState<Awaited<ReturnType<typeof listImports>> | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    listImports().then(setList).catch(setError);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const job = await uploadImport(file);
      window.location.assign(`/imports/${job.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const outdated = error instanceof ApiFailure && error.code === 'TEMPLATE_OUTDATED';
  return (
    <Page title="Import a file" wide intro="Add many rates or products at once from an Excel file. Nothing goes live until a second person approves it.">
      <ol style={{ fontSize: 14, paddingLeft: 18 }}>
        <li><a href="/api/imports/template" download>Download the import template</a> (its <em>Lists</em> sheet shows the codes ECR knows today).</li>
        <li>Fill the Products, Lines and Prices sheets you need — values only, no formulas.</li>
        <li>Upload it. ECR checks every row and the rules for the whole set; nothing is saved until you create the rate update.</li>
      </ol>
      <form onSubmit={submit} style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0' }}>
        <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="Workbook to import"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button type="submit" disabled={!file || busy}>{busy ? 'Checking…' : 'Upload and check'}</button>
      </form>
      <ErrorText error={error} />
      {outdated && <p style={{ fontSize: 14 }}><a href="/api/imports/template" download>Download the current template</a> and copy your rows into it.</p>}

      <h2 style={{ fontSize: 18 }}>My imports</h2>
      {list && list.length === 0 && <p>No imports yet.</p>}
      {list && list.length > 0 && (
        <TableWrap><table style={tableStyle}>
          <thead><tr style={headStyle}><th>Uploaded</th><th>File</th><th>Status</th><th>Rows</th><th>Errors</th><th>Warnings</th><th>Rate update</th></tr></thead>
          <tbody>
            {list.map((j) => (
              <tr key={j.id} style={rowStyle}>
                <td><a href={`/imports/${j.id}`}>{new Date(j.createdAt).toLocaleString()}</a></td>
                <td>{j.fileName}</td>
                <td><Badge value={j.status} /></td>
                <td>{j.rowCount}</td>
                <td>{j.errorCount}</td>
                <td>{j.warningCount}</td>
                <td>{j.changeSetId ? <a href={`/change-sets/${j.changeSetId}`}>Open</a> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table></TableWrap>
      )}
    </Page>
  );
}

export function ImportDetail({ id }: { id: string }) {
  const [job, setJob] = useState<ImportJob | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [title, setTitle] = useState('');
  const [justification, setJustification] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportReportEntry[] | null>(null);

  useEffect(() => {
    getImport(id).then((j) => {
      setJob(j);
      setTitle(`Import ${j.fileName}`);
    }).catch(setError);
  }, [id]);

  async function commit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const done = await commitImport(id, { title, justification, acknowledgeWarnings: ack });
      window.location.assign(`/change-sets/${done.changeSetId}`);
    } catch (err) {
      // A commit re-checks the file; show the fresh report when it changed.
      if (err instanceof ApiFailure && Array.isArray(err.details?.report)) setReport(err.details.report as ImportReportEntry[]);
      setError(err);
      setBusy(false);
    }
  }

  if (!job) return <Page title="Import">{error ? <ErrorText error={error} /> : 'Loading…'}</Page>;
  const entries = report ?? job.report;
  const errors = entries.filter((e) => e.severity === 'ERROR').length;
  const warnings = entries.filter((e) => e.severity === 'WARNING').length;
  return (
    <Page title={`Import: ${job.fileName}`} wide>
      <p>
        <Badge value={job.status} /> {job.rowCount} rows · {errors} errors · {warnings} warnings · template {job.templateVersion} · uploaded{' '}
        {new Date(job.createdAt).toLocaleString()}
      </p>
      <p style={{ fontSize: 13, color: 'var(--muted)' }}>SHA-256 <code>{job.fileSha256}</code> · <a href={`/api/imports/${job.id}/report`} download>Download the report (Excel)</a> · <a href="/imports">All imports</a></p>

      {entries.length === 0 && <p role="status" style={{ color: 'var(--ok-ink)' }}>Every row passed the checks.</p>}
      {entries.length > 0 && (
        <TableWrap><table style={tableStyle}>
          <thead><tr style={headStyle}><th>Sheet</th><th>Row</th><th>Column</th><th>Severity</th><th>Rule</th><th>Message</th></tr></thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i} style={rowStyle}>
                <td>{e.sheet}</td>
                <td>{e.row ?? '—'}</td>
                <td>{e.column ? `${e.column}${e.field ? ` (${e.field})` : ''}` : (e.field ?? '—')}</td>
                <td><Badge value={e.severity} /></td>
                <td><code style={{ fontSize: 12 }}>{e.code}</code></td>
                <td>{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table></TableWrap>
      )}

      <ErrorText error={error} />
      {job.status === 'COMMITTED' && job.changeSetId && (
        <p>Created <a href={`/change-sets/${job.changeSetId}`}>the rate update</a>; send it for review from there.</p>
      )}
      {job.status === 'VALIDATED_WITH_ERRORS' && !report && (
        <p style={{ fontSize: 14 }}>Fix the errors in your file and <a href="/imports">upload it again</a>. Nothing was saved.</p>
      )}
      {job.status === 'VALIDATED' && (
        <form onSubmit={commit} style={{ background: 'var(--subtle)', borderRadius: 8, padding: 12, marginTop: 16, display: 'grid', gap: 8, maxWidth: 640 }}>
          <strong>Create the rate update</strong>
          <label style={{ fontSize: 13 }}>Title<input value={title} onChange={(e) => setTitle(e.target.value)} style={{ display: 'block', width: '100%' }} /></label>
          <label style={{ fontSize: 13 }}>Justification<textarea value={justification} onChange={(e) => setJustification(e.target.value)} rows={3} style={{ display: 'block', width: '100%' }} /></label>
          {warnings > 0 && (
            <label style={{ fontSize: 13 }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have reviewed the {warnings} warning(s)</label>
          )}
          <div><button type="submit" disabled={busy || (warnings > 0 && !ack)}>{busy ? 'Creating…' : 'Create rate update'}</button></div>
        </form>
      )}
    </Page>
  );
}
