import { useEffect, useState, type ReactNode } from 'react';
import { FollowButton } from './Notifications';
import {
  getProduct,
  getRegulation,
  HistoryEntry,
  listProducts,
  listRegulations,
  ProductSummary,
  RegulationView,
} from '../api';
import { Badge, ErrorText, headStyle, Page, rowStyle, tableStyle, TableWrap } from '../ui';
import { ProductCharges } from './Tariffs';

const RELATION_TEXT: Record<string, string> = {
  AMENDS: 'Amends', REVOKES: 'Revokes', IMPLEMENTS: 'Implements',
  AMENDED_BY: 'Amended by', REVOKED_BY: 'Revoked by', IMPLEMENTED_BY: 'Implemented by',
};

/** Loads data once and re-runs when `deps` change; returns [data, error]. */
function useLoad<T>(load: () => Promise<T>, deps: unknown[]): [T | null, unknown] {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    load().then((d) => live && setData(d)).catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, deps);
  return [data, error];
}

function SearchBox({ placeholder, onSearch }: { placeholder: string; onSearch: (q: string) => void }) {
  const [q, setQ] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSearch(q); }} style={{ marginBottom: 16 }}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label={placeholder} style={{ width: 320 }} />{' '}
      <button type="submit">Search</button>
    </form>
  );
}

// ---------------------------------------------------------------- regulations

export function RegulationsPage() {
  const [q, setQ] = useState('');
  const [regs, error] = useLoad(() => listRegulations(q), [q]);
  return (
    <Page title="Regulations" wide intro="The official decrees behind every rate, with their PDFs. Search by number, title or issuing ministry.">
      <SearchBox placeholder="Search number, title or issuer" onSearch={setQ} />
      <ErrorText error={error} />
      {regs && regs.length === 0 && <p>No published regulations{q ? ' match the search' : ' yet'}.</p>}
      {regs && regs.length > 0 && (
        <TableWrap><table style={tableStyle}>
          <thead><tr style={headStyle}><th>Regulation</th><th>Title</th><th>Status</th><th>Effective</th><th>Links</th><th>Source</th></tr></thead>
          <tbody>
            {regs.map((r) => (
              <tr key={r.entityId} style={rowStyle}>
                <td style={{ whiteSpace: 'nowrap' }}><a href={`/regulations/${r.entityId}`}>{r.label}</a></td>
                <td>{r.titleId}{r.titleEn && <><br /><span style={{ color: 'var(--muted)' }}>{r.titleEn}</span></>}</td>
                <td><Badge value={r.status} /></td>
                <td style={{ whiteSpace: 'nowrap' }}>{r.effectiveOn ?? '—'}{r.endsOn && <> – {r.endsOn}</>}</td>
                <td style={{ fontSize: 13 }}>
                  {[...r.relations.map((x) => ({ ...x, label: x.label ?? '' })), ...r.relatedBy].map((x, i) => (
                    <div key={i}>{RELATION_TEXT[x.relation]} <a href={`/regulations/${x.regulationId}`}>{x.label}</a></div>
                  ))}
                </td>
                <td style={{ fontSize: 13 }}>{r.documents.filter((d) => !d.isSecondary).length} official PDF</td>
              </tr>
            ))}
          </tbody>
        </table></TableWrap>
      )}
    </Page>
  );
}

export function RegulationDetail({ id }: { id: string }) {
  const [r, error] = useLoad(() => getRegulation(id), [id]);
  if (error) return <Page title="Regulation"><ErrorText error={error} /></Page>;
  if (!r) return <Page title="Regulation">Loading…</Page>;
  return (
    <Page title={r.label} wide>
      <p><Badge value={r.status} /> {r.titleId}</p>
      {r.titleEn && <p style={{ color: 'var(--muted)', marginTop: -8 }}>{r.titleEn}</p>}
      <Facts rows={[
        ['Issuer', r.issuer],
        ['Promulgated', r.promulgatedOn],
        ['Effective', r.effectiveOn],
        ['Ends', r.endsOn],
        ['Official page', r.officialUrl && <a href={r.officialUrl} target="_blank" rel="noreferrer noopener">{r.officialUrl}</a>],
        ['BPK status page', r.bpkStatusUrl && <a href={r.bpkStatusUrl} target="_blank" rel="noreferrer noopener">{r.bpkStatusUrl}</a>],
        ['Data version', `v${r.versionFrom}`],
      ]} />

      <h2 style={{ fontSize: 18 }}>Source documents</h2>
      <TableWrap><table style={tableStyle}>
        <thead><tr style={headStyle}><th>Document</th><th>Role</th><th>Publisher</th><th>SHA-256</th></tr></thead>
        <tbody>
          {r.documents.map((d) => (
            <tr key={d.sourceDocumentId} style={rowStyle}>
              <td><a href={`/api/source-documents/${d.sourceDocumentId}/file`} target="_blank" rel="noopener">{d.title}</a>{d.isSecondary && <> <Badge value="SECONDARY" /></>}</td>
              <td>{d.role}</td>
              <td>{d.publisherName ?? '—'}</td>
              <td><code style={{ fontSize: 11 }}>{d.sha256}</code></td>
            </tr>
          ))}
        </tbody>
      </table></TableWrap>

      {(r.relations.length > 0 || r.relatedBy.length > 0) && (
        <>
          <h2 style={{ fontSize: 18 }}>Amendment chain</h2>
          <ul>
            {[...r.relations.map((x) => ({ ...x, label: x.label ?? '' })), ...r.relatedBy].map((x, i) => (
              <li key={i}>{RELATION_TEXT[x.relation]} <a href={`/regulations/${x.regulationId}`}>{x.label}</a></li>
            ))}
          </ul>
        </>
      )}

      {r.classifiedProducts.length > 0 && (
        <>
          <h2 style={{ fontSize: 18 }}>Products classified under it ({r.classifiedProducts.length})</h2>
          <ul>{r.classifiedProducts.map((p) => <li key={p.entityId}><a href={`/products/${p.entityId}`}>{p.itemNoAsPrinted ? `${p.itemNoAsPrinted}. ` : ''}{p.nameId}</a></li>)}</ul>
        </>
      )}
      <History entries={r.history} />
    </Page>
  );
}

// ---------------------------------------------------------------- products

export function ProductsPage() {
  const [q, setQ] = useState('');
  const [products, error] = useLoad(() => listProducts(q), [q]);
  return (
    <Page title="Product list" wide intro="All products with their HS codes. Open one to see its duty and levy.">
      <SearchBox placeholder="Search name, synonym or HS code" onSearch={setQ} />
      <ErrorText error={error} />
      {products && products.length === 0 && <p>No published products{q ? ' match the search' : ' yet'}.</p>}
      {products && products.length > 0 && <ProductTable products={products} />}
    </Page>
  );
}

function ProductTable({ products }: { products: ProductSummary[] }) {
  return (
    <TableWrap><table style={tableStyle}>
      <thead><tr style={headStyle}><th>Group</th><th>No.</th><th>Product</th><th>HS code(s)</th><th>Key spec</th><th>Classification</th></tr></thead>
      <tbody>
        {products.map((p) => (
          <tr key={p.entityId} style={rowStyle}>
            <td style={{ whiteSpace: 'nowrap' }}>{p.group?.label ?? '—'}</td>
            <td>{p.itemNoAsPrinted ?? ''}</td>
            <td><a href={`/products/${p.entityId}`}>{p.nameId}</a>{p.nameEn && <><br /><span style={{ color: 'var(--muted)' }}>{p.nameEn}</span></>}</td>
            <td style={{ whiteSpace: 'nowrap' }}>
              {p.hsCodes.map((h) => <div key={h.code}>{h.isEx && 'ex '}{h.code}</div>)}
              {p.sharedHs && <Badge value="SHARED HS" title="Another product is classified on the same HS code" />}
            </td>
            <td>{p.keySpec ?? '—'}</td>
            <td style={{ whiteSpace: 'nowrap' }}>{p.classificationRegulation ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table></TableWrap>
  );
}

export function ProductDetail({ id }: { id: string }) {
  const [p, error] = useLoad(() => getProduct(id), [id]);
  if (error) return <Page title="Product"><ErrorText error={error} /></Page>;
  if (!p) return <Page title="Product">Loading…</Page>;
  return (
    <Page title={p.nameId} wide>
      {p.nameEn && <p style={{ color: 'var(--muted)', marginTop: -8 }}>{p.nameEn}</p>}
      <p><FollowButton productId={p.entityId} /></p>
      <Facts rows={[
        ['Commodity', p.commodity && `${p.commodity.code} — ${p.commodity.nameId}`],
        ['Group', p.group?.label],
        ['Item no. (as printed)', p.itemNoAsPrinted],
        ['Classification', p.classificationRegulation && <a href={`/regulations/${p.classificationRegulation.entityId}`}>{p.classificationRegulation.label}</a>],
        ['Annex page', p.annexPage],
        ['Valid', `${p.validFrom ?? '—'}${p.validTo ? ` – ${p.validTo}` : ' onwards'}`],
        ['Synonyms', p.synonyms.join(', ')],
        ['IDR at PEB date (special goods)', p.fxOnPebDate ? 'Yes' : null],
        ['Other obligations', p.otherObligationsNote],
      ]} />
      <ProductCharges productId={p.entityId} />
      {p.definition && <><h2 style={{ fontSize: 18 }}>Definition</h2><p>{p.definition}</p></>}

      <h2 style={{ fontSize: 18 }}>HS codes</h2>
      <TableWrap><table style={tableStyle}>
        <thead><tr style={headStyle}><th>Code</th><th>Ex-code description</th><th>Also classified on this code</th></tr></thead>
        <tbody>
          {p.hsCodes.map((h) => (
            <tr key={h.code} style={rowStyle}>
              <td>{h.isEx && 'ex '}{h.code}</td>
              <td>{h.exDescription ?? '—'}</td>
              <td>
                {h.sharedWith?.length
                  ? h.sharedWith.map((o) => <div key={o.entityId}><a href={`/products/${o.entityId}`}>{o.nameId}</a></div>)
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table></TableWrap>

      {p.parameters.length > 0 && (
        <>
          <h2 style={{ fontSize: 18 }}>Technical parameters</h2>
          <TableWrap><table style={tableStyle}>
            <thead><tr style={headStyle}><th>Parameter</th><th>Value</th><th>Unit</th><th /></tr></thead>
            <tbody>
              {p.parameters.map((x, i) => (
                <tr key={i} style={rowStyle}>
                  <td>{x.name}</td>
                  <td>{x.operator === 'TEXT' || x.operator === 'RANGE' ? '' : `${x.operator} `}{x.valueText}</td>
                  <td>{x.unit ?? ''}</td>
                  <td>{x.isPrimary && <Badge value="KEY SPEC" />}</td>
                </tr>
              ))}
            </tbody>
          </table></TableWrap>
        </>
      )}
      {p.notes.length > 0 && <><h2 style={{ fontSize: 18 }}>Notes</h2><ul>{p.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></>}
      <History entries={p.history} />
    </Page>
  );
}

// ---------------------------------------------------------------- shared

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px', fontSize: 14 }}>
      {rows.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}><dt style={{ color: 'var(--muted)' }}>{k}</dt><dd style={{ margin: 0 }}>{v}</dd></div>
      ))}
    </dl>
  );
}

/** Version history (US-30-P1): each published version, its change set and approver. */
function History({ entries }: { entries: HistoryEntry[] }) {
  return (
    <>
      <h2 style={{ fontSize: 18 }}>History</h2>
      <TableWrap><table style={tableStyle}>
        <thead><tr style={headStyle}><th>Version</th><th>Published</th><th>Rate update</th><th>Approved by</th><th /></tr></thead>
        <tbody>
          {entries.map((h) => (
            <tr key={h.versionFrom} style={rowStyle}>
              <td>v{h.versionFrom}</td>
              <td>{new Date(h.publishedAt).toLocaleString()}</td>
              <td>{h.changeSetTitle}</td>
              <td>{h.approvedBy ?? '—'}</td>
              <td>{h.versionTo === null ? <Badge value="CURRENT" /> : <span style={{ color: 'var(--muted)' }}>until v{h.versionTo}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table></TableWrap>
    </>
  );
}
