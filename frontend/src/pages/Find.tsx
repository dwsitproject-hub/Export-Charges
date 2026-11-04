import { useEffect, useState } from 'react';
import { Charge, formatDecimal } from '../api';
import { CatalogueResponse, CatalogueRow, getCatalogue } from '../api-catalogue';
import { ErrorText, Page } from '../ui';

const wibToday = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const longDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * Find a product: one plain answer (duty, levy, total per tonne and why) for the product picked from a catalogue search.
 * The address holds ?q=&date=&pick=, so it is a permalink like the catalogue's.
 */
export function FindPage() {
  const [params, setParams] = useState(() => new URLSearchParams(window.location.search));
  const [text, setText] = useState(params.get('q') ?? '');
  const [data, setData] = useState<CatalogueResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);
  const date = params.get('date') ?? wibToday();

  useEffect(() => {
    let live = true;
    setError(null);
    const query = new URLSearchParams({ pageSize: '30' });
    if (params.get('q')) query.set('q', params.get('q')!);
    if (params.get('date')) query.set('date', params.get('date')!);
    getCatalogue(query).then((d) => live && setData(d)).catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, [params.get('q'), params.get('date')]);

  function update(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) (v ? next.set(k, v) : next.delete(k));
    window.history.replaceState(null, '', `/find${next.toString() ? `?${next}` : ''}`);
    setParams(next);
    setCopied(false);
  }

  const rows = data?.rows ?? [];
  const picked = rows.find((r) => r.productId === params.get('pick')) ?? (params.get('q') ? rows[0] : undefined);

  return (
    <Page title="Find a product" wide>
      <form className="form-row" role="search" onSubmit={(e) => { e.preventDefault(); update({ q: text.trim() || null, pick: null }); }}>
        <label className="field-stack" style={{ flex: '1 1 380px' }}>
          Product name or HS code
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. crude palm oil, or 1511.10.00" autoComplete="off" />
        </label>
        <label className="field-stack" style={{ flex: '0 1 220px' }}>
          <span>Shipping date <span className="help">(PEB date)</span></span>
          <input type="date" value={date} onChange={(e) => e.target.value && update({ date: e.target.value === wibToday() ? null : e.target.value })} />
        </label>
        <button type="submit" className="primary big">Check</button>
      </form>
      <ErrorText error={error} />
      {!data && !error && <p className="muted">Loading…</p>}

      {data && data.notices.map((n) => <p key={n} className="callout warn">{n}</p>)}

      {data && rows.length === 0 && (
        <div className="answer" style={{ alignItems: 'flex-start' }}>
          <h2 style={{ fontSize: 24 }}>No product matches “{data.query}”</h2>
          <p style={{ margin: 0 }}>Try a shorter word, the Indonesian name, or the HS code.</p>
          {data.suggestion && (
            <button type="button" className="primary" onClick={() => { setText(data.suggestion!); update({ q: data.suggestion, pick: null }); }}>
              Search for “{data.suggestion}” instead
            </button>
          )}
        </div>
      )}

      {data && picked && <Answer row={picked} date={data.date} copied={copied} onCopy={() => navigator.clipboard.writeText(linkFor(picked, params)).then(() => setCopied(true))} />}

      {data && rows.length > 0 && (
        <div className="split">
          {picked && (
            <section className="panel main" aria-labelledby="why-title">
              <h2 id="why-title" style={{ marginTop: 0, fontSize: 22, fontWeight: 800 }}>How we got this number</h2>
              <Why row={picked} />
            </section>
          )}
          <section className={`panel ${picked ? 'side' : 'main'}`} aria-labelledby="list-title">
            <h2 id="list-title" style={{ marginTop: 0, fontSize: 22, fontWeight: 800 }}>
              {picked ? (rows.length > 1 ? 'Other matches' : 'Matches') : data.query ? `Products matching “${data.query}”` : 'Choose a product'}
            </h2>
            <ul className="pick-list">
              {rows.map((r) => (
                <li key={r.productId}>
                  <button type="button" aria-current={r === picked} onClick={() => { update({ pick: r.productId }); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                    <span className="nm">{r.nameEn ?? r.nameId}<small>HS {r.hsCodes.map((h) => h.code).join(', ')}</small></span>
                    <span className="tag">{r.totalUsdPerMt !== null ? `USD ${formatDecimal(r.totalUsdPerMt)}/t` : kindText(r)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {data.total > rows.length && (
              <p className="small" style={{ marginBottom: 0 }}>
                Showing {rows.length} of {data.total}. <a href={`/catalogue${data.query ? `?q=${encodeURIComponent(data.query)}` : ''}`}>See them all in the full table</a>
              </p>
            )}
          </section>
        </div>
      )}

      {data && (
        <p className="callout" style={{ background: 'var(--info)', color: 'var(--info-ink)', borderColor: 'transparent' }}>
          Not sure this is the right product? <a href="/catalogue">Browse the full product table</a>, or ask your trade team.
          Figures come from official data version {data.versionNo}.
        </p>
      )}
    </Page>
  );
}

function linkFor(row: CatalogueRow, params: URLSearchParams): string {
  const p = new URLSearchParams(params);
  p.set('pick', row.productId);
  return `${window.location.origin}/find?${p}`;
}

function kindText(r: CatalogueRow): string {
  if (r.bk.status === 'NOT_LISTED' && r.pe.status === 'NOT_LISTED') return 'No charge';
  if (r.bk.status === 'LISTED_ZERO' && r.pe.status !== 'CHARGED') return 'Zero';
  return 'Check';
}

function Answer({ row, date, copied, onCopy }: { row: CatalogueRow; date: string; copied: boolean; onCopy: () => void }) {
  const hs = row.hsCodes.map((h) => `${h.isEx ? 'ex ' : ''}${h.code}`).join(', ');
  return (
    <section className="answer" aria-labelledby="answer-title">
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="meta">HS {hs}{row.group ? ` · ${row.group}` : ''}</span>
          <h2 id="answer-title">{row.nameEn ?? row.nameId}</h2>
          {row.nameEn && <span className="muted">Also called: {row.nameId}</span>}
          {row.keySpec && <span className="muted small">Specification: {row.keySpec}</span>}
        </div>
        <div className="actions">
          <button type="button" onClick={onCopy}>{copied ? 'Link copied' : 'Copy link'}</button>
          <button type="button" onClick={() => window.print()}>Print</button>
        </div>
      </div>

      <p className="sentence">
        {row.totalUsdPerMt !== null
          ? <>If you ship <strong>1 tonne</strong> on <strong>{longDate(date)}</strong>, you pay <strong className="amount">USD {formatDecimal(row.totalUsdPerMt)}</strong> in total: duty plus levy.</>
          : <>We can't give a total for <strong>{longDate(date)}</strong> yet. {row.totalNote}</>}
      </p>

      <div className="charge-grid">
        <ChargeCard c={row.bk} />
        <ChargeCard c={row.pe} />
        <div className="charge total">
          <span className="k">Total per tonne</span>
          <span className="v">{row.totalUsdPerMt !== null ? `USD ${formatDecimal(row.totalUsdPerMt)}` : '—'}</span>
          <span className="p">Rupiah amount: use the calculator</span>
        </div>
      </div>

      {row.draftClassification && (
        <p className="callout warn" style={{ margin: 0 }}>This product's classification comes from a draft regulation{row.classificationRegulation ? ` (${row.classificationRegulation})` : ''}. Check before relying on it.</p>
      )}
      {row.sharedHs && (
        <p className="callout" style={{ margin: 0 }}>Another product uses the same HS code. Make sure the description matches what you ship.</p>
      )}

      <div className="actions">
        <a className="button primary big" href={`/calculator?lines=${row.productId}:1&peb=${date}`}>Calculate for my shipment →</a>
        <a className="button big" href={`/products/${row.productId}?date=${date}`}>All product details</a>
      </div>
    </section>
  );
}

const CHARGE_NAME = { BK: { name: 'Export duty · Bea Keluar', to: 'paid to Customs' }, PE: { name: 'Export levy · Pungutan Ekspor', to: 'paid to BPDP' } };

function ChargeCard({ c }: { c: Charge }) {
  const n = CHARGE_NAME[c.chargeType];
  const [value, note, isText] =
    c.status === 'CHARGED' ? [`USD ${formatDecimal(c.usdPerMt)}`, `per tonne · ${n.to}`, false]
    : c.status === 'LISTED_ZERO' ? ['USD 0', 'listed, but zero at this price', false]
    : c.status === 'NOT_LISTED' ? ['None', `this product has no ${c.chargeType === 'BK' ? 'export duty' : 'export levy'}`, true]
    : ['Not available', c.message ?? 'A value is missing for this date', true];
  return (
    <div className={`charge${c.chargeType === 'PE' ? ' levy' : ''}`}>
      <span className="k">{n.name}</span>
      <span className={`v${isText ? ' text' : ''}`}>{value}</span>
      <span className="p">{note}</span>
    </div>
  );
}

/** The chain behind each charge: reference price → band or rate → the regulation line (BR-CAL-08). */
function Why({ row }: { row: CatalogueRow }) {
  const charges = [row.bk, row.pe].filter((c) => c.line || c.referencePrice);
  const ref = row.bk.referencePrice ?? row.pe.referencePrice;
  if (!charges.length) return <p className="muted" style={{ margin: 0 }}>This product isn't listed in a duty or levy regulation for this date, so nothing is charged.</p>;
  let n = 0;
  return (
    <ol className="steps-list">
      {ref && (
        <li>
          <span className="num">{++n}</span>
          <span className="body">
            <strong>The reference price is {formatDecimal(ref.value)} {ref.unit}</strong>
            <span>{ref.seriesCode}, valid {longDate(ref.periodFrom)} – {longDate(ref.periodTo)}{ref.fallback ? ' (last known value carried forward)' : ''}.
              {ref.sourceDocumentId && <> <a href={`/api/source-documents/${ref.sourceDocumentId}/file`} target="_blank" rel="noopener">Official PDF</a></>}</span>
          </span>
        </li>
      )}
      {charges.map((c) => (
        <li key={c.chargeType}>
          <span className="num">{++n}</span>
          <span className="body">
            <strong>
              {c.chargeType === 'BK' ? 'Duty' : 'Levy'}: {c.band ? `price band ${c.band.label} gives ` : c.rate ? `${c.rate} % of the export price gives ` : ''}
              {c.status === 'CHARGED' ? `USD ${formatDecimal(c.usdPerMt)} per tonne` : c.status === 'LISTED_ZERO' ? 'zero' : (c.message ?? 'no amount')}
            </strong>
            {c.line && (
              <span>
                From {c.line.regulationId ? <a href={`/regulations/${c.line.regulationId}`}>{c.line.regulation}</a> : c.line.regulation}
                {c.line.annexLabel && `, ${c.line.annexLabel}`}{c.line.kelompok && `, group ${c.line.kelompok}`}{c.line.itemNo && `, line ${c.line.itemNo}`}.
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
