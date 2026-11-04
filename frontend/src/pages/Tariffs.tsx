import { useEffect, useState } from 'react';
import {
  Charge,
  formatDecimal,
  getProductCharges,
  getRefSeries,
  getSchedule,
  listBandTables,
  listRefSeries,
  listSchedules,
} from '../api';
import { Badge, ErrorText, headStyle, Page, rowStyle, tableStyle, TableWrap } from '../ui';
import { chargeText } from './ChangeSets';

const BASIS_TEXT: Record<string, string> = {
  BAND_USD_PER_MT: 'USD/MT by price band',
  BAND_PCT: '% by price band × Harga Ekspor',
  AD_VALOREM_PCT: '% × Harga Ekspor',
  PCT_OF_REF_PRICE: '% of reference price',
  FIXED_USD_PER_MT: 'Fixed USD/MT',
  ZERO_LISTED: 'Listed at 0',
};

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

const monthName = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// ---------------------------------------------------------------- reference prices

export function PricesPage() {
  const [series, error] = useLoad(() => listRefSeries(), []);
  return (
    <Page title="Reference prices" wide intro="The prices and exchange rates that decide how much duty and levy you pay, as in force today (WIB).">
      <ErrorText error={error} />
      {series && series.length === 0 && <p>No series published yet.</p>}
      {series && series.length > 0 && (
        <TableWrap><table style={tableStyle}>
          <thead><tr style={headStyle}><th>Series</th><th>Kind</th><th>In force today</th><th>Period</th><th>Latest published</th></tr></thead>
          <tbody>
            {series.map((s) => (
              <tr key={s.entityId} style={rowStyle}>
                <td><a href={`/prices/${s.entityId}`}>{s.code}</a><br /><span style={{ color: 'var(--muted)' }}>{s.name}{s.product && ` — ${s.product}`}</span></td>
                <td>{s.kind.replace(/_/g, ' ')}<br /><span style={{ color: 'var(--muted)' }}>{s.unit}, {s.cadence.toLowerCase().replace('_', '-')}</span></td>
                <td>
                  {s.current
                    ? <strong>{formatDecimal(s.current.value, s.kind === 'FX_RATE' ? 0 : 2)}</strong>
                    : <Badge value="WARNING" title="US-27-N2" />}
                  {!s.current && <div style={{ fontSize: 13, color: 'var(--warn-ink)' }}>Not yet published for {monthName(new Date().toISOString().slice(0, 10))}</div>}
                </td>
                <td>{s.current ? `${s.current.periodFrom} – ${s.current.periodTo}` : '—'}</td>
                <td>{s.latest ? `${formatDecimal(s.latest.value, s.kind === 'FX_RATE' ? 0 : 2)} (${s.latest.periodFrom} – ${s.latest.periodTo})` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table></TableWrap>
      )}
    </Page>
  );
}

export function SeriesDetail({ id }: { id: string }) {
  const [s, error] = useLoad(() => getRefSeries(id), [id]);
  if (error) return <Page title="Series"><ErrorText error={error} /></Page>;
  if (!s) return <Page title="Series">Loading…</Page>;
  return (
    <Page title={`${s.code} — ${s.name}`} wide>
      <p style={{ fontSize: 14 }}>{s.kind.replace(/_/g, ' ')} · {s.unit} · published {s.cadence.toLowerCase().replace('_', '-')}{s.product && ` · ${s.product}`}</p>
      <TableWrap><table style={tableStyle}>
        <thead><tr style={headStyle}><th>Period</th><th style={{ textAlign: 'right' }}>Value</th><th>Decree</th><th>Source document</th></tr></thead>
        <tbody>
          {s.values.map((v) => (
            <tr key={v.entityId} style={rowStyle}>
              <td>{v.periodFrom} – {v.periodTo}</td>
              <td style={{ textAlign: 'right' }}>{v.value}</td>
              <td>{v.sourceReference ?? '—'}</td>
              <td>
                {v.sourceDocument
                  ? <><a href={`/api/source-documents/${v.sourceDocument.id}/file`} target="_blank" rel="noopener">{v.sourceDocument.title}</a><br /><code style={{ fontSize: 11 }}>{v.sourceDocument.sha256.slice(0, 16)}…</code> {v.sourceDocument.publisher}</>
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table></TableWrap>
    </Page>
  );
}

// ---------------------------------------------------------------- schedules

export function SchedulesPage() {
  const [schedules, error] = useLoad(() => listSchedules(), []);
  const [tables, tablesError] = useLoad(() => listBandTables(), []);
  return (
    <Page title="Rate tables" wide intro="The duty (BK) and levy (PE) tables from each regulation: the amount per tonne for each price band.">
      <ErrorText error={error ?? tablesError} />
      {schedules && schedules.length === 0 && <p>No schedules published yet.</p>}
      {schedules && schedules.length > 0 && (
        <TableWrap><table style={tableStyle}>
          <thead><tr style={headStyle}><th>Charge</th><th>Regulation</th><th>Annex</th><th>Commodity</th><th>Lines</th></tr></thead>
          <tbody>
            {schedules.map((s) => (
              <tr key={s.entityId} style={rowStyle}>
                <td><Badge value={s.chargeType} /></td>
                <td>{s.regulationId ? <a href={`/regulations/${s.regulationId}`}>{s.regulation}</a> : '—'}</td>
                <td><a href={`/schedules/${s.entityId}`}>{s.annexLabel}</a></td>
                <td>{s.commodity}</td>
                <td>{s.lineCount}</td>
              </tr>
            ))}
          </tbody>
        </table></TableWrap>
      )}
      {tables && tables.length > 0 && (
        <>
          <h2 style={{ fontSize: 18 }}>Band tables</h2>
          {tables.map((t) => (
            <div key={t.entityId} style={{ marginBottom: 12 }}>
              <strong>{t.code}</strong> — {t.name} <span style={{ color: 'var(--muted)' }}>(on {t.refSeries}, lower edge exclusive, upper inclusive)</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                {t.bands.map((b, i) => <span key={i} style={{ border: '1px solid var(--line)', borderRadius: 4, padding: '0 6px', fontSize: 13 }}>{i + 1}: {b.label}</span>)}
              </div>
            </div>
          ))}
        </>
      )}
    </Page>
  );
}

export function ScheduleDetail({ id }: { id: string }) {
  const [s, error] = useLoad(() => getSchedule(id), [id]);
  if (error) return <Page title="Schedule"><ErrorText error={error} /></Page>;
  if (!s) return <Page title="Schedule">Loading…</Page>;
  return (
    <Page title={`${s.chargeType === 'BK' ? 'Export duty (BK)' : 'Export levy (PE)'} — ${s.regulation} ${s.annexLabel}`} wide>
      <TableWrap><table style={tableStyle}>
        <thead><tr style={headStyle}><th>Kelompok</th><th>No.</th><th>Uraian</th><th>Basis</th><th>Rate</th><th>Products</th><th>Valid</th></tr></thead>
        <tbody>
          {s.lines.map((l) => (
            <tr key={l.entityId} style={rowStyle}>
              <td>{l.kelompok ?? ''}</td>
              <td>{l.itemNo ?? ''}</td>
              <td style={{ maxWidth: 320 }}>{l.uraian}</td>
              <td>{BASIS_TEXT[l.basisType] ?? l.basisType}{l.refSeries && <div style={{ color: 'var(--muted)', fontSize: 13 }}>on {l.refSeries}</div>}</td>
              <td style={{ fontSize: 13 }}>
                {l.pct && `${l.pct} %`}
                {l.usdPerMt && `USD ${l.usdPerMt}/MT`}
                {l.bandTable && (
                  <TableWrap><table style={{ borderCollapse: 'collapse' }}>
                    <tbody>
                      {l.bandTable.bands.map((b, i) => (
                        <tr key={i}><td style={{ paddingRight: 8, color: 'var(--muted)' }}>{b.label}</td><td style={{ textAlign: 'right' }}>{l.bandValues[i]}{l.basisType === 'BAND_PCT' ? ' %' : ''}</td></tr>
                      ))}
                    </tbody>
                  </table></TableWrap>
                )}
              </td>
              <td>{l.products.map((p) => <div key={p.entityId}><a href={`/products/${p.entityId}`}>{p.nameId}</a></div>)}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{l.validFrom}{l.validTo ? ` – ${l.validTo}` : ' →'}</td>
            </tr>
          ))}
        </tbody>
      </table></TableWrap>
    </Page>
  );
}

// ---------------------------------------------------------------- product charges

/** BK and PE per tonne for one product on a date, with legal basis and values used (PRD FR-CAT-05, BR-CAL-08, BR-CAL-10). */
export function ProductCharges({ productId }: { productId: string }) {
  // The catalogue and calculator link here with ?date= so the product shows the same as-of date.
  const [date, setDate] = useState(() => new URLSearchParams(window.location.search).get('date') ?? new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10));
  const [charges, error] = useLoad(() => getProductCharges(productId, date), [productId, date]);
  return (
    <section className="panel" aria-labelledby="charges-title" style={{ margin: '20px 0' }}>
      <div className="panel-head" style={{ alignItems: 'flex-end' }}>
        <h2 id="charges-title">Duty and levy per tonne</h2>
        <label className="field-stack">
          Shipping date (PEB date)
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </label>
      </div>
      <ErrorText error={error} />
      {charges && (
        <div className="charge-grid">
          <ChargeCard title="Export duty · Bea Keluar" c={charges.bk} />
          <ChargeCard title="Export levy · Pungutan Ekspor" c={charges.pe} />
        </div>
      )}
      <div className="actions" style={{ marginTop: 16 }}>
        <a className="button primary" href={`/calculator?lines=${productId}:1&peb=${date}`}>Calculate a shipment</a>
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>
        From the published data. Duty applies at the PEB registration date; the Rupiah amount uses the KMK rate on the payment date (see the calculator).
      </p>
    </section>
  );
}

function ChargeCard({ title, c }: { title: string; c: Charge }) {
  const problem = c.status === 'MISSING_VALUE' || c.status === 'DATA_ERROR';
  return (
    <div className={`charge${c.chargeType === 'PE' ? ' levy' : ''}`} style={problem ? { background: 'var(--warn)' } : undefined}>
      <span className="k">{title}</span>
      <span className={`v${c.status === 'CHARGED' ? '' : ' text'}`}>
        {c.status === 'CHARGED' ? `USD ${formatDecimal(c.usdPerMt)}` : chargeText(c)}
      </span>
      {c.basisType && <div style={{ fontSize: 13 }}>{BASIS_TEXT[c.basisType]}{c.rate && ` — ${c.rate} %`}{c.band && ` — band ${c.band.ordinal} (${c.band.label})`}</div>}
      {c.referencePrice && (
        <div style={{ fontSize: 13 }}>
          {c.referencePrice.seriesCode} {formatDecimal(c.referencePrice.value)} {c.referencePrice.unit} ({c.referencePrice.periodFrom} – {c.referencePrice.periodTo}
          {c.referencePrice.sourceReference && `, ${c.referencePrice.sourceReference}`})
          {c.referencePrice.sourceDocumentId && <> · <a href={`/api/source-documents/${c.referencePrice.sourceDocumentId}/file`} target="_blank" rel="noopener">decree</a></>}
        </div>
      )}
      {c.hargaEkspor && (
        <div style={{ fontSize: 13 }}>
          Harga Ekspor {formatDecimal(c.hargaEkspor.value)} {c.hargaEkspor.unit} ({c.hargaEkspor.periodFrom} – {c.hargaEkspor.periodTo})
          {c.hargaEkspor.fallback && <strong style={{ color: 'var(--warn-ink)' }}> — previous period, the new decision is not yet published</strong>}
        </div>
      )}
      {c.line && (
        <div style={{ fontSize: 13, marginTop: 6, color: 'var(--muted)' }}>
          {c.line.regulationId ? <a href={`/regulations/${c.line.regulationId}`}>{c.line.regulation}</a> : c.line.regulation} {c.line.annexLabel}
          {c.line.kelompok && `, Kelompok ${c.line.kelompok}`}{c.line.itemNo && `, no. ${c.line.itemNo}`}
          <div style={{ fontStyle: 'italic' }}>“{c.line.uraian}”</div>
        </div>
      )}
    </div>
  );
}
