import { useEffect, useState } from 'react';
import { ExportJob, exportJobFileUrl, getExportJob, listExportJobs } from '../api-catalogue';
import { Badge, ErrorText, headStyle, Page, rowStyle, tableStyle, TableWrap } from '../ui';

const kb = (n: number | null) => (n === null ? '—' : `${Math.max(1, Math.round(n / 1024)).toLocaleString('en')} KB`);
const when = (d: string | null) => (d ? new Date(d).toLocaleString() : '—');

/** Large catalogue exports prepared in the background (US-47-N1 AC3); only their requester sees them. */
export function ExportsPage() {
  const [jobs, setJobs] = useState<ExportJob[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    listExportJobs().then(setJobs).catch(setError);
  }, []);
  return (
    <Page title="My downloads" wide intro="Big downloads are prepared here. Each file is only for you and stays available for 24 hours.">
      <ErrorText error={error} />
      {jobs && jobs.length === 0 && (
        <div className="empty"><strong>Nothing here yet</strong><p>When a download from the full product table is too big to send straight away, it appears here.</p></div>
      )}
      {jobs && jobs.length > 0 && (
        <TableWrap><table style={tableStyle}>
          <thead><tr style={headStyle}><th>Requested</th><th>Status</th><th>As-of date</th><th>Version</th><th>Rows</th><th>Available until</th></tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} style={rowStyle}>
                <td><a href={`/exports/${j.id}`}>{when(j.createdAt)}</a> ({j.format.toUpperCase()})</td>
                <td><Badge value={j.status} /></td>
                <td>{j.date}</td>
                <td>v{j.versionNo}</td>
                <td>{j.rowCount?.toLocaleString('en') ?? '—'}</td>
                <td>{j.status === 'READY' ? when(j.expiresAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table></TableWrap>
      )}
    </Page>
  );
}

/** Opened from the "export ready" notice; refreshes while the file is being prepared. */
export function ExportDetail({ id }: { id: string }) {
  const [job, setJob] = useState<ExportJob | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = () => getExportJob(id).then((j) => {
      if (!live) return;
      setJob(j);
      if (j.status === 'QUEUED' || j.status === 'RUNNING') timer = setTimeout(load, 5000);
    }).catch((e) => live && setError(e));
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id]);

  if (!job) return <Page title="Large export">{error ? <ErrorText error={error} /> : 'Loading…'}</Page>;
  return (
    <Page title="Large export" wide>
      <p><Badge value={job.status} /> {job.format.toUpperCase()} · catalogue as of {job.date} · data version v{job.versionNo}{job.search && <> · search “{job.search}”</>}</p>
      {(job.status === 'QUEUED' || job.status === 'RUNNING') && <p role="status">Being prepared… you will be notified when it is ready. This page refreshes by itself.</p>}
      {job.status === 'READY' && (
        <p>
          {job.rowCount?.toLocaleString('en')} {job.rowCount === 1 ? 'row' : 'rows'}, {kb(job.byteSize)}. Available until {when(job.expiresAt)}.{' '}
          <a href={exportJobFileUrl(job.id)} download>Download {job.fileName}</a>
        </p>
      )}
      {job.status === 'EXPIRED' && <p>The 24 hours have passed and the file was removed. <a href="/catalogue">Export again from the catalogue</a>.</p>}
      {job.status === 'FAILED' && <p style={{ color: 'var(--danger-ink)' }}>The export could not be prepared: {job.error}</p>}
      <p style={{ fontSize: 14 }}><a href="/exports">All my large exports</a></p>
    </Page>
  );
}
