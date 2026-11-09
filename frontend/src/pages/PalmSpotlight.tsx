import { useEffect, useMemo, useState } from 'react';
import { Charge, formatDecimal } from '../api';
import { CatalogueResponse, CatalogueRow, getCatalogue } from '../api-catalogue';
import { ErrorText } from '../ui';

const longDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortRange = (from: string, to: string) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).formatRange(new Date(`${from}T00:00:00Z`), new Date(`${to}T00:00:00Z`));
/** How many rows "All groups" shows before "Show all". */
const FIRST_ROWS = 12;

/** Loads today's catalogue once; Home uses it for the palm spotlight and the reference prices in the hero. */
export function useTodayCatalogue(allowed: boolean): { data: CatalogueResponse | null; error: unknown } {
  const [data, setData] = useState<CatalogueResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (allowed) getCatalogue(new URLSearchParams({ pageSize: '200' })).then(setData).catch(setError);
  }, []);
  return { data, error };
}

/** Today's reference prices as one line each, for the hero. */
export function HeroPrices({ data }: { data: CatalogueResponse | null }) {
  const prices = data?.referencePrices.filter((p) => p.value) ?? [];
  if (!prices.length) return null;
  return (
    <div className="hero-prices">
      {prices.map((p) => (
        <a key={p.seriesId} className="hero-price" href={`/prices/${p.seriesId}`}>
          <span className="k">{p.kind === 'FX_RATE' ? 'Exchange rate (KMK)' : p.kind === 'REFERENCE_PRICE' ? `${p.code} reference price` : p.name}</span>
          <span className="v">{p.unit.startsWith('IDR') ? 'Rp ' : ''}{formatDecimal(p.value!.value)} <small>{p.unit.startsWith('IDR') ? `per ${p.unit.split('/')[1] ?? 'USD'}` : p.unit}</small></span>
          <span className="p">
            Valid {shortRange(p.value!.periodFrom, p.value!.periodTo)}{p.bands[0]?.label ? ` · band ${p.bands[0].label}` : ''}{p.value!.fallback ? ' · carried forward' : ''}
          </span>
        </a>
      ))}
    </div>
  );
}

/** Every palm oil product with the duty, levy and total per tonne for shipping today; one click opens the full answer. */
export function PalmSpotlight({ data, error }: { data: CatalogueResponse | null; error: unknown }) {
  const [group, setGroup] = useState<string>('');
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);

  const palm = useMemo(() => data?.rows.filter((r) => r.commodityCode === 'PALM') ?? [], [data]);
  const groups = useMemo(() => {
    const seen = new Map<string, number>();
    for (const r of palm) if (r.group) seen.set(r.group, (seen.get(r.group) ?? 0) + 1);
    return [...seen];
  }, [palm]);
  const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching = palm.filter((r) => (!group || r.group === group) && words.every((w) => haystack(r).includes(w)));
  const limited = !group && !words.length && !showAll;
  const shown = limited ? matching.slice(0, FIRST_ROWS) : matching;
  const charged = palm.filter((r) => r.totalUsdPerMt !== null && Number(r.totalUsdPerMt) > 0).length;

  return (
    <section className="panel spotlight" aria-labelledby="palm-title">
      <div className="panel-head">
        <div>
          <p className="spot-eyebrow">In the spotlight</p>
          <h2 id="palm-title">Palm oil products</h2>
          {data && (
            <p className="muted spot-sub">
              {palm.length} products · charges per tonne if you ship today, {longDate(data.date)} · {charged} of them pay duty or levy
            </p>
          )}
        </div>
        <a href="/catalogue">Full product table →</a>
      </div>

      <ErrorText error={error} />
      {!data && !error && <p className="muted">Loading palm oil products…</p>}
      {data && !palm.length && <p className="muted">No palm oil products are published yet.</p>}

      {palm.length > 0 && (
        <>
          <div className="spot-tools">
            <div className="seg" role="group" aria-label="Product group">
              <button type="button" aria-pressed={!group} onClick={() => setGroup('')}>All <span>{palm.length}</span></button>
              {groups.map(([g, n]) => (
                <button key={g} type="button" aria-pressed={group === g} onClick={() => setGroup(g)}>{g} <span>{n}</span></button>
              ))}
            </div>
            <label className="spot-filter">
              <span className="sr-only">Filter palm oil products</span>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
              <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter: olein, stearin, 1511…" autoComplete="off" />
            </label>
          </div>

          <div className="palm-list" role="table" aria-label="Palm oil products and their charges today">
            <div className="palm-row head" role="row">
              <span role="columnheader">Product</span>
              <span role="columnheader">Key spec</span>
              <span role="columnheader">Export duty (BK)</span>
              <span role="columnheader">Export levy (PE)</span>
              <span role="columnheader">Total per tonne</span>
            </div>
            {shown.map((r) => (
              <a key={r.productId} className="palm-row" role="row" href={`/find?q=${encodeURIComponent(r.nameEn ?? r.nameId)}&pick=${r.productId}`}>
                <span className="nm" role="cell">
                  <strong>{r.nameEn ?? r.nameId}</strong>
                  <small>HS {r.hsCodes.map((h) => `${h.isEx ? 'ex ' : ''}${h.code}`).join(', ')}{r.group ? ` · ${r.group}` : ''}</small>
                </span>
                <span className="spec" role="cell" data-label="Key spec">{r.keySpec ?? <span className="muted">—</span>}</span>
                <ChargeCell c={r.bk} />
                <ChargeCell c={r.pe} />
                <span className="tot" role="cell" data-label="Total per t">
                  {r.totalUsdPerMt !== null ? <>USD {formatDecimal(r.totalUsdPerMt)}</> : <span className="muted">Check</span>}
                </span>
              </a>
            ))}
            {!shown.length && <p className="muted" style={{ padding: '16px 4px', margin: 0 }}>No palm oil product matches “{filter}”.</p>}
          </div>
          {limited && matching.length > FIRST_ROWS && (
            <button type="button" className="spot-more" onClick={() => setShowAll(true)}>Show all {matching.length} palm oil products</button>
          )}
        </>
      )}
    </section>
  );
}

function ChargeCell({ c }: { c: Charge }) {
  const label = c.chargeType === 'BK' ? 'Duty (BK)' : 'Levy (PE)';
  const [text, kind] =
    c.status === 'CHARGED' ? [`USD ${formatDecimal(c.usdPerMt)}`, 'amt']
    : c.status === 'LISTED_ZERO' ? ['USD 0', 'zero']
    : c.status === 'NOT_LISTED' ? ['None', 'none']
    : ['Not available', 'missing'];
  // A levy charged as a share of the CPO reference price shows that share under the amount.
  const pct = c.basisType === 'PCT_OF_REF_PRICE' && c.rate ? `${Number(c.rate).toLocaleString('en-US', { maximumFractionDigits: 4 })}% of CPO ref. price` : null;
  return (
    <span className={`chg ${kind}${c.chargeType === 'PE' ? ' levy' : ''}`} role="cell" data-label={label} title={c.message ?? undefined}>
      {text}
      {pct && <small>{pct}</small>}
    </span>
  );
}

const haystack = (r: CatalogueRow) =>
  [r.nameEn, r.nameId, r.keySpec, r.group, ...r.hsCodes.map((h) => h.code), ...r.hsCodes.map((h) => h.code.replace(/\./g, ''))].join(' ').toLowerCase();
