import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Charge, formatDecimal, Me } from '../api';
import { Category, CATEGORIES, CATEGORY_TEXT, CatalogueResponse, CatalogueRow, exportCatalogue, Facet, getCatalogue } from '../api-catalogue';
import { hubTrack } from '../hubSdk';
import { Badge, ErrorText, Page, TableWrap } from '../ui';

const wibToday = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const LIST_KEYS = ['commodity', 'group', 'category', 'regulation'] as const;
type ListKey = (typeof LIST_KEYS)[number];

/** Filters live in the URL, so the address is a permalink (PRD FR-EXP-03, US-45-P1 AC2). */
function readParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

const listOf = (p: URLSearchParams, key: string) => (p.get(key) ?? '').split(',').filter(Boolean);
const longDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function CataloguePage({ me }: { me: Me }) {
  const [params, setParams] = useState(readParams);
  const [copied, setCopied] = useState(false);
  const canExport = me.user.permissions.includes('export.run');
  const [data, setData] = useState<CatalogueResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [exporting, setExporting] = useState(false);
  const [queued, setQueued] = useState<{ id: string; rows: number } | null>(null);

  async function runExport(format: 'csv' | 'xlsx') {
    setExporting(true);
    setError(null);
    setQueued(null);
    try {
      const result = await exportCatalogue(format, params);
      hubTrack('catalogue_exported', { format });
      if (result.queued) setQueued({ id: result.job.id, rows: result.rows });
    } catch (e) {
      setError(e);
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    let live = true;
    setError(null);
    getCatalogue(params).then((d) => live && setData(d)).catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, [params.toString()]);

  function update(changes: Record<string, string | null>, resetPage = true) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) (v ? next.set(k, v) : next.delete(k));
    if (resetPage) next.delete('page');
    window.history.replaceState(null, '', `${window.location.pathname}${next.toString() ? `?${next}` : ''}`);
    setParams(next);
  }
  const toggle = (key: ListKey, id: string) => {
    const current = listOf(params, key);
    update({ [key]: (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]).join(',') });
  };
  const clearFilters = () => {
    setSearch('');
    update({ q: null, commodity: null, group: null, category: null, regulation: null, sharedHs: null });
  };
  const sortBy = (key: string) => {
    const same = (params.get('sort') ?? 'default') === key;
    update({ sort: key === 'default' ? null : key, dir: same && params.get('dir') !== 'desc' ? 'desc' : null }, false);
  };

  const date = params.get('date') ?? wibToday();
  const words = (data?.query ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const active: { key: ListKey | 'sharedHs' | 'q'; id: string; label: string }[] = data ? [
    ...(data.query ? [{ key: 'q' as const, id: '', label: `“${data.query}”` }] : []),
    ...LIST_KEYS.flatMap((key) => listOf(params, key).map((id) => ({
      key, id, label: key === 'category' ? CATEGORY_TEXT[id as Category] : (data.facets[key].find((f) => f.id === id)?.label ?? id),
    }))),
    ...(params.get('sharedHs') === 'true' ? [{ key: 'sharedHs' as const, id: '', label: 'Shared HS' }] : []),
  ] : [];

  return (
    <Page title="Full product table" wide intro={<>Every product with its duty and levy per tonne. Filter on the left, or <a href="/find">find one product</a> for a plain answer.</>}>
      <div className="catalogue-toolbar">
        <form className="catalogue-search" onSubmit={(e) => { e.preventDefault(); update({ q: search.trim() || null }); }} data-tour="search">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, synonym, HS code or keyword"
            aria-label="Search the catalogue" />
          <button type="submit">Search</button>
        </form>
        <label style={{ fontSize: 13 }}>As-of (PEB) date
          <input type="date" value={date} onChange={(e) => update({ date: e.target.value && e.target.value !== wibToday() ? e.target.value : null })} style={{ display: 'block' }} />
        </label>
        <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', fontSize: 14, alignItems: 'center' }}>
          {/* US-47-P1 AC2: the address already holds the search, filters, sort and as-of date. */}
          <button type="button" onClick={() => navigator.clipboard.writeText(window.location.href).then(() => setCopied(true))}>
            {copied ? 'Link copied' : 'Copy link'}
          </button>
          {canExport && (
            <>
              <button type="button" disabled={exporting} onClick={() => runExport('xlsx')}>Export XLSX</button>
              <button type="button" disabled={exporting} onClick={() => runExport('csv')}>Export CSV</button>
            </>
          )}
        </div>
      </div>
      {queued && (
        <p role="status" style={{ background: 'var(--info)', padding: '6px 10px', borderRadius: 6, fontSize: 14 }}>
          {queued.rows.toLocaleString('en')} {queued.rows === 1 ? 'row is' : 'rows are'} too many to download at once, so the export is being prepared. You will be
          notified here and by email when it is ready; <a href={`/exports/${queued.id}`}>follow it</a>.
        </p>
      )}
      <ErrorText error={error} />

      {data && (
        <>
          <RefPricePanel data={data} onApply={(v) => update({ refPrice: v }, false)} />
          <p role="status" className="small muted" style={{ margin: '0 0 8px' }}>
            Viewing as of <strong>{longDate(data.date)}</strong> (data version {data.versionNo})
            {data.referencePrices.filter((p) => p.kind === 'FX_RATE').map((p) => (
              <span key={p.seriesId}> · KMK rate {p.value
                ? <>Rp {formatDecimal(p.value.value, 0)} per USD ({longDate(p.value.periodFrom)} – {longDate(p.value.periodTo)})</>
                : <strong style={{ color: 'var(--warn-ink)' }}>not yet published</strong>}</span>
            ))}
          </p>
          {data.notices.map((n) => <p key={n} style={{ background: 'var(--warn)', padding: '6px 10px', borderRadius: 6, fontSize: 14 }}>{n}</p>)}

          <KpiTiles data={data} onCategory={(c) => update({ category: c, sharedHs: null })} onShared={() => update({ sharedHs: 'true', category: null })}
            onAll={() => update({ category: null, sharedHs: null })} />

          {active.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', margin: '8px 0', fontSize: 13 }}>
              {active.map((a) => (
                <button key={`${a.key}:${a.id}`} aria-label={`Remove filter ${a.label}`}
                  onClick={() => (a.key === 'q' ? (setSearch(''), update({ q: null })) : a.key === 'sharedHs' ? update({ sharedHs: null }) : toggle(a.key, a.id))}
                  style={{ borderRadius: 12, border: '1px solid var(--line)', background: 'var(--panel)', padding: '1px 8px' }}>
                  {a.label} ×
                </button>
              ))}
              <button onClick={clearFilters}>Clear all</button>
            </div>
          )}

          <div className="catalogue-grid">
            <aside aria-label="Filters" style={{ fontSize: 13 }} data-tour="filters">
              <FacetGroup title="Charge" facets={data.facets.category.map((f) => ({ ...f, label: CATEGORY_TEXT[f.id as Category] }))}
                selected={listOf(params, 'category')} onToggle={(id) => toggle('category', id)} />
              <FacetGroup title="Commodity" facets={data.facets.commodity} selected={listOf(params, 'commodity')} onToggle={(id) => toggle('commodity', id)} />
              <FacetGroup title="Group" facets={data.facets.group} selected={listOf(params, 'group')} onToggle={(id) => toggle('group', id)} />
              <FacetGroup title="Regulation" facets={data.facets.regulation} selected={listOf(params, 'regulation')} onToggle={(id) => toggle('regulation', id)} />
              <label style={{ display: 'block', marginTop: 8 }}>
                <input type="checkbox" checked={params.get('sharedHs') === 'true'} onChange={(e) => update({ sharedHs: e.target.checked ? 'true' : null })} />
                {' '}Shared HS only ({data.facets.sharedHs})
              </label>
            </aside>

            <div style={{ overflowX: 'auto' }} data-tour="table">
              {data.rows.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', border: '1px dashed var(--line)', borderRadius: 8 }}>
                  <p>No products match these filters.</p>
                  {data.suggestion && (
                    <p>Did you mean <button onClick={() => { setSearch(data.suggestion!); update({ q: data.suggestion }); }}>{data.suggestion}</button>?</p>
                  )}
                  <button onClick={clearFilters}>Clear filters</button>
                </div>
              ) : (
                <CatalogueTable rows={data.rows} words={words} sort={params.get('sort') ?? 'default'} dir={params.get('dir') ?? 'asc'} onSort={sortBy} date={data.date} />
              )}
              {data.total > data.pageSize && (
                <nav aria-label="Pages" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, fontSize: 14 }}>
                  <button disabled={data.page <= 1} onClick={() => update({ page: String(data.page - 1) }, false)}>Previous</button>
                  Page {data.page} of {Math.ceil(data.total / data.pageSize)} ({data.total} products)
                  <button disabled={data.page * data.pageSize >= data.total} onClick={() => update({ page: String(data.page + 1) }, false)}>Next</button>
                </nav>
              )}
            </div>
          </div>
          <p style={{ fontSize: 12, color: 'var(--muted)' }}>
            Amounts are USD per metric tonne from the published data version shown. Duty applies at the PEB registration date; use the calculator for
            quantities and IDR.
          </p>
        </>
      )}
    </Page>
  );
}

/**
 * The CPO reference price that decides the duty band, and a what-if: type another price to see which band it falls in and
 * every product's duty and levy at it (worked out by the API from the published tables; nothing is saved).
 */
function RefPricePanel({ data, onApply }: { data: CatalogueResponse; onApply: (value: string | null) => void }) {
  const cpo = data.referencePrices.find((p) => p.code === 'CPO');
  const published = data.simulation ? data.simulation.published : cpo;
  const [price, setPrice] = useState(data.simulation?.value ?? '');
  useEffect(() => setPrice(data.simulation?.value ?? ''), [data.simulation?.value]);
  if (!cpo && !data.simulation) return null;
  const band = (p: typeof cpo) => p?.bands[0] ? `band ${p.bands[0].ordinal} (${p.bands[0].label})` : null;
  const usd = (v: string) => `US$ ${formatDecimal(v)}`;
  const crude = data.rows.find((r) => r.hsCodes.some((h) => h.code === '1511.10.00' && !h.isEx));

  return (
    <section className={`refprice${data.simulation ? ' simulating' : ''}`} aria-labelledby="refprice-title" data-tour="refprice">
      <div className="refprice-now">
        <h2 id="refprice-title">CPO reference price</h2>
        <p>
          {published?.value
            ? <>Published for {longDate(data.date)}: <strong>{usd(published.value.value)}/MT</strong> ({longDate(published.value.periodFrom)} – {longDate(published.value.periodTo)}){band(published) && <>, {band(published)}</>}</>
            : <>No CPO reference price is published for {longDate(data.date)} yet.</>}
        </p>
      </div>
      <form className="refprice-form" onSubmit={(e) => { e.preventDefault(); const v = price.trim(); onApply(v && Number(v) > 0 ? v : null); }}>
        <label className="field-stack">
          <span>Try another price <span className="help">(US$/MT)</span></span>
          <input type="number" inputMode="decimal" min="0.01" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="e.g. 1050" />
        </label>
        <button type="submit" className="primary">Show charges</button>
        {data.simulation && <button type="button" onClick={() => { setPrice(''); onApply(null); }}>Back to the published price</button>}
      </form>
      {data.simulation && (
        <div className="refprice-result" role="status">
          <p>
            At <strong>{usd(data.simulation.value)}/MT</strong> the CPO price falls in <strong>{band(cpo) ?? 'no band'}</strong>
            {published?.value && band(published) && band(published) !== band(cpo) && <> (the published price is in {band(published)})</>}.
            Every export duty (BK) and levy (PE) below is worked out at this price.
          </p>
          {crude && (
            <p>
              {crude.nameEn ?? crude.nameId}: duty <strong>{crude.bk.usdPerMt !== null ? usd(crude.bk.usdPerMt) : '—'}</strong>
              {crude.pe.usdPerMt !== null && <>, levy <strong>{usd(crude.pe.usdPerMt)}</strong>{crude.pe.rate && ` (${crude.pe.rate}% of the price)`}</>}
              {crude.totalUsdPerMt !== null && <>, total <strong>{usd(crude.totalUsdPerMt)}</strong></>} per tonne.
            </p>
          )}
          <p className="small">A what-if only: nothing is saved, and exports and calculations use the published price.</p>
        </div>
      )}
    </section>
  );
}

function KpiTiles({ data, onCategory, onShared, onAll }: {
  data: CatalogueResponse; onCategory: (c: Category) => void; onShared: () => void; onAll: () => void;
}) {
  const tile = (label: string, value: number, onClick: () => void, key: string) => (
    <button key={key} onClick={onClick} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '8px 12px', background: 'var(--panel)', textAlign: 'left', minWidth: 110 }}>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</div>
    </button>
  );
  return (
    <div role="group" aria-label="Summary" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '12px 0' }}>
      {tile('Products shown', data.kpis.shown, onAll, 'shown')}
      {CATEGORIES.map((c) => tile(CATEGORY_TEXT[c], data.kpis[c], () => onCategory(c), c))}
      {tile('Shared HS code', data.kpis.sharedHs, onShared, 'shared')}
    </div>
  );
}

function FacetGroup({ title, facets, selected, onToggle }: { title: string; facets: Facet[]; selected: string[]; onToggle: (id: string) => void }) {
  if (!facets.length) return null;
  return (
    <fieldset style={{ border: 'none', background: 'none', padding: 0, margin: '0 0 12px' }}>
      <legend style={{ fontWeight: 600, padding: 0 }}>{title}</legend>
      {facets.map((f) => (
        <label key={f.id} style={{ display: 'block', color: f.count || selected.includes(f.id) ? undefined : 'var(--muted)' }}>
          <input type="checkbox" checked={selected.includes(f.id)} onChange={() => onToggle(f.id)} /> {f.label} ({f.count})
        </label>
      ))}
    </fieldset>
  );
}

/** Marks the searched words; React escapes the text, so any input stays literal (US-41-N1 AC1). */
function Highlight({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const hit = words.map((w) => ({ w, at: lower.indexOf(w, i) })).filter((x) => x.at >= 0).sort((a, b) => a.at - b.at)[0];
    if (!hit) break;
    parts.push(text.slice(i, hit.at), <mark key={hit.at}>{text.slice(hit.at, hit.at + hit.w.length)}</mark>);
    i = hit.at + hit.w.length;
  }
  parts.push(text.slice(i));
  return <>{parts}</>;
}

function ChargeCell({ c }: { c: Charge }) {
  if (c.status === 'NOT_LISTED') return <span style={{ color: 'var(--muted)' }} title={`Not subject to ${c.chargeType}`}>Not listed</span>;
  if (c.status === 'LISTED_ZERO') return <span>Listed at 0</span>;
  if (c.status !== 'CHARGED') return <span title={c.message ?? ''} style={{ color: 'var(--warn-ink)' }}>n/a{c.rate ? ` (${c.rate} % of HE)` : ''}</span>;
  return (
    <span>
      {formatDecimal(c.usdPerMt)}
      <div style={{ fontSize: 11, color: 'var(--muted)' }}>{c.band ? `band ${c.band.label}` : c.rate ? `${c.rate} %${c.basisType === 'AD_VALOREM_PCT' ? ' of HE' : ''}` : ''}</div>
    </span>
  );
}

function CatalogueTable({ rows, words, sort, dir, onSort, date }: {
  rows: CatalogueRow[]; words: string[]; sort: string; dir: string; onSort: (key: string) => void; date: string;
}) {
  const th = (key: string, label: string, numeric = false) => (
    <th aria-sort={sort === key ? (dir === 'desc' ? 'descending' : 'ascending') : 'none'} style={{ textAlign: numeric ? 'right' : 'left' }}>
      <button type="button" className="sort" onClick={() => onSort(key)}>
        {label}{sort === key ? (dir === 'desc' ? ' ▼' : ' ▲') : ''}
      </button>
    </th>
  );
  return (
    <TableWrap><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--line)' }}>
          {th('default', 'Group / no.')}{th('name', 'Product')}{th('hs', 'HS code')}<th style={{ textAlign: 'left' }}>Key spec</th>
          {th('bk', 'BK (USD/MT)', true)}{th('pe', 'PE (USD/MT)', true)}{th('total', 'Total', true)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.productId} style={{ borderBottom: '1px solid var(--line)', verticalAlign: 'top' }} data-tour={i === 0 ? 'product-row' : undefined}>
            <td style={{ whiteSpace: 'nowrap' }}>{r.group}{r.itemNoAsPrinted && <div style={{ color: 'var(--muted)' }}>no. {r.itemNoAsPrinted}</div>}</td>
            <td>
              <a href={`/products/${r.productId}?date=${date}`}><Highlight text={r.nameId} words={words} /></a>
              {r.nameEn && <div style={{ color: 'var(--muted)' }}><Highlight text={r.nameEn} words={words} /></div>}
              <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                {r.sharedHs && <Badge value="SHARED HS" title="Another product is classified on the same HS code" />}
                {r.draftClassification && <Badge value="DRAFT_RANCANGAN" title="Classification based on a draft regulation" />}
              </div>
            </td>
            <td style={{ whiteSpace: 'nowrap' }}>{r.hsCodes.map((h) => <div key={h.code}>{h.isEx && 'ex '}<Highlight text={h.code} words={words} /></div>)}</td>
            <td>{r.keySpec ?? '—'}</td>
            <td style={{ textAlign: 'right' }}><ChargeCell c={r.bk} /></td>
            <td style={{ textAlign: 'right' }}><ChargeCell c={r.pe} /></td>
            <td style={{ textAlign: 'right', fontWeight: 600 }}>{r.totalUsdPerMt !== null ? formatDecimal(r.totalUsdPerMt) : <span style={{ fontWeight: 400, color: 'var(--warn-ink)' }}>{r.totalNote}</span>}</td>
          </tr>
        ))}
      </tbody>
    </table></TableWrap>
  );
}
