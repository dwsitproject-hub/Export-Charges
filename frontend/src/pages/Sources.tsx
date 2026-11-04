import { useEffect, useState, type FormEvent } from 'react';
import { listSourceDocuments, SourceDocument } from '../api';
import { Badge, ErrorText, Page, TableWrap } from '../ui';

const KIND_TEXT: Record<string, string> = {
  REGULATION: 'Regulation',
  ANNEX: 'Annex',
  REF_PRICE_DECREE: 'Reference price decree',
  HE_DECISION: 'Harga Ekspor decision',
  FX_DECREE: 'KMK exchange rate',
  OTHER: 'Other',
};

const size = (bytes: string) => {
  const n = Number(bytes);
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
};

/** PRD F-21 / F-31: every official document ECR's data comes from, to open, download and check. */
export function SourcesPage() {
  const [docs, setDocs] = useState<SourceDocument[] | null>(null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [error, setError] = useState<unknown>(null);

  const load = (text = q) => listSourceDocuments(text).then(setDocs).catch(setError);
  useEffect(() => {
    void load('');
  }, []);

  function search(e: FormEvent) {
    e.preventDefault();
    void load();
  }

  const shown = (docs ?? []).filter((d) => !kind || d.docKind === kind);
  const kinds = [...new Set((docs ?? []).map((d) => d.docKind))];

  return (
    <Page title="Official documents" wide intro="The original PDFs behind the data: regulations, reference-price decrees and exchange-rate decisions, exactly as published.">
      <details className="callout">
        <summary style={{ fontWeight: 700 }}>Can I trust these copies?</summary>
        <p style={{ marginBottom: 0 }}>
          Each document is stored as downloaded from its publisher with its SHA-256 fingerprint. Compare the fingerprint with the
          file on the official site to confirm it is unchanged.
        </p>
      </details>
      <form onSubmit={search} className="actions" style={{ marginBottom: 12 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title or number, e.g. PMK 68 or 2064" aria-label="Search documents"
          style={{ flex: '1 1 260px' }} />
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind of document">
          <option value="">All kinds</option>
          {kinds.map((k) => <option key={k} value={k}>{KIND_TEXT[k] ?? k}</option>)}
        </select>
        <button type="submit">Search</button>
      </form>
      <ErrorText error={error} />
      {!docs && !error && <p>Loading…</p>}
      {docs && shown.length === 0 && <p className="muted">No documents match.</p>}
      {shown.length > 0 && (
        <TableWrap>
          <table>
            <thead>
              <tr><th>Document</th><th>Used for</th><th>Publisher</th><th>File</th></tr>
            </thead>
            <tbody>
              {shown.map((d) => (
                <tr key={d.id}>
                  <td>
                    <a href={`/api/source-documents/${d.id}/file`} target="_blank" rel="noopener">{d.title}</a>
                    <div className="small muted">
                      {KIND_TEXT[d.docKind] ?? d.docKind}{d.docNumber ? ` · No. ${d.docNumber}` : ''}{d.docDate ? ` · ${d.docDate}` : ''}
                    </div>
                    {d.isSecondary && <Badge value="SECONDARY" title="A secondary reference, not a source of record" />}
                    {d.recheckMismatch && <Badge value="ERROR" title="The file at the official address no longer matches this copy" />}
                  </td>
                  <td className="small">
                    {(d.regulations ?? []).map((r) => <div key={r.id}><a href={`/regulations/${r.id}`}>{r.label}</a></div>)}
                    {(d.values ?? []).map((v) => <div key={v.id + v.label}><a href={`/prices/${v.id}`}>{v.label}</a></div>)}
                    {!d.regulations?.length && !d.values?.length && <span className="muted">Not cited by published data</span>}
                  </td>
                  <td className="small">
                    {d.publisherName ?? '—'}
                    {d.officialUrl && <div><a href={d.officialUrl} target="_blank" rel="noreferrer noopener">Official page</a></div>}
                  </td>
                  <td className="small" style={{ whiteSpace: 'nowrap' }}>
                    <div className="actions">
                      <a className="button" href={`/api/source-documents/${d.id}/file`} target="_blank" rel="noopener">Open PDF</a>
                      <a className="button" href={`/api/source-documents/${d.id}/file?download=1`}>Download</a>
                    </div>
                    <div className="muted" style={{ marginTop: 4 }} title={`SHA-256 ${d.sha256}`}>
                      {size(d.byteSize)} · SHA-256 <code>{d.sha256.slice(0, 12)}…</code>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Page>
  );
}
