import { useEffect, useState, type ReactNode } from 'react';
import { ApiFailure, formatDecimal, Me } from '../api';
import {
  CalcInput,
  CalcResult,
  calcProducts,
  createEvidence,
  evidenceFileUrl,
  EvidenceCheck,
  exportUrl,
  getCalculation,
  listCalculations,
  previewCalculation,
  saveCalculation,
  verifyCalculation,
  verifyEvidence,
} from '../api-catalogue';
import { Badge, ErrorText, headStyle, Page, rowStyle, tableStyle, TableWrap } from '../ui';
import { chargeText } from './ChangeSets';

const wibToday = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const MAX_LINES = 50;

/**
 * Inputs from the URL (permalink, no personal data): ?lines=<productId>:<qty>,…&peb=&pay=&override=
 */
function readInput(): CalcInput {
  const p = new URLSearchParams(window.location.search);
  const lines = (p.get('lines') ?? '').split(',').filter(Boolean).map((s) => {
    const [productId, quantityMt = '1'] = s.split(':');
    return { productId, quantityMt };
  });
  const peb = p.get('peb') ?? wibToday();
  return { lines: lines.length ? lines : [{ productId: '', quantityMt: '1' }], pebDate: peb, paymentDate: p.get('pay') ?? peb, refPriceOverride: p.get('override') ?? '' };
}

function writeInput(input: CalcInput) {
  const p = new URLSearchParams();
  const lines = input.lines.filter((l) => l.productId).map((l) => `${l.productId}:${l.quantityMt}`).join(',');
  if (lines) p.set('lines', lines);
  p.set('peb', input.pebDate);
  if (input.paymentDate !== input.pebDate) p.set('pay', input.paymentDate);
  if (input.refPriceOverride) p.set('override', input.refPriceOverride);
  window.history.replaceState(null, '', `/calculator?${p}`);
}

const STEPS = [
  { label: 'Products', hint: 'What and how much' },
  { label: 'Dates', hint: 'When it ships' },
  { label: 'Result', hint: 'Your total to pay' },
];

/** Three steps (products, dates, result); every input change clears the result so it never shows next to other inputs. */
export function CalculatorPage() {
  const [input, setInput] = useState<CalcInput>(readInput);
  const [step, setStep] = useState(1);
  const [products, setProducts] = useState<{ entityId: string; nameId: string; nameEn: string | null; hsCodes: string[] }[]>([]);
  const [result, setResult] = useState<CalcResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    calcProducts(input.pebDate).then(setProducts).catch(setError);
  }, [input.pebDate]);

  const set = (patch: Partial<CalcInput>) => {
    const next = { ...input, ...patch };
    setInput(next);
    writeInput(next);
    setSaved(null);
    setCopied(false);
    // A result never stays on screen next to inputs it was not calculated from.
    setResult(null);
  };
  const setLine = (i: number, patch: Partial<CalcInput['lines'][number]>) => set({ lines: input.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });

  async function run(save: boolean) {
    setBusy(true);
    setError(null);
    try {
      const body = { ...input, lines: input.lines.filter((l) => l.productId) };
      if (save) {
        const r = await saveCalculation(body);
        setResult(r);
        setSaved(r.id);
      } else {
        setResult(await previewCalculation(body));
      }
    } catch (e) {
      setError(e);
      setResult(null);
      // Problems with a product or quantity are fixed on the first step.
      if (e instanceof ApiFailure && Array.isArray(e.details?.fields)) setStep(1);
    } finally {
      setBusy(false);
    }
  }

  function goTo(n: number) {
    setStep(n);
    window.scrollTo({ top: 0 });
    if (n === 3 && !result) void run(false);
  }

  const fieldErrors = error instanceof ApiFailure && Array.isArray(error.details?.fields) ? (error.details.fields as { field: string; message: string }[]) : [];
  const errorFor = (field: string) => fieldErrors.find((f) => f.field === field)?.message;
  const chosen = input.lines.filter((l) => l.productId);
  const nameOf = (id: string) => {
    const p = products.find((x) => x.entityId === id);
    return p ? p.nameEn ?? p.nameId : 'Product';
  };
  const totalMt = chosen.reduce((s, l) => s + (Number(l.quantityMt) || 0), 0);

  return (
    <Page title="Calculate a shipment" wide>
      <p className="muted" style={{ marginTop: 0, fontSize: 17 }}>
        Three short steps. Nothing is saved until you choose to save it. <a href="/calculations">Your saved calculations</a>
      </p>

      <ol className="stepper" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s.label} className={i + 1 < step ? 'done' : undefined}>
            <button type="button" aria-current={i + 1 === step ? 'step' : undefined} disabled={i > 0 && !chosen.length} onClick={() => goTo(i + 1)}>
              <span className="dot">{i + 1}</span>
              <span className="lbl"><strong>{s.label}</strong><span>{s.hint}</span></span>
            </button>
          </li>
        ))}
      </ol>

      <div className="split">
        <section className="panel main">
          {step === 1 && (
            <>
              <h2 style={{ marginTop: 0, fontSize: 24, fontWeight: 800 }}>What are you shipping?</h2>
              {input.lines.map((l, i) => (
                <div className="line-card" key={i}>
                  <div className="grow">
                    <ProductPicker n={i + 1} products={products} value={l.productId} onChange={(productId) => setLine(i, { productId })} />
                    {errorFor(`lines[${i}].productId`) && <div className="error small">{errorFor(`lines[${i}].productId`)}</div>}
                  </div>
                  <label className="field-stack" style={{ flex: '0 1 180px' }}>
                    Weight (tonnes)
                    <input value={l.quantityMt} onChange={(e) => setLine(i, { quantityMt: e.target.value })} inputMode="decimal"
                      aria-invalid={!!errorFor(`lines[${i}].quantityMt`)} style={{ fontVariantNumeric: 'tabular-nums' }} />
                    {errorFor(`lines[${i}].quantityMt`) && <span className="error small" style={{ fontWeight: 400 }}>{errorFor(`lines[${i}].quantityMt`)}</span>}
                  </label>
                  {input.lines.length > 1 && (
                    <button type="button" aria-label={`Remove product ${i + 1}`} title="Remove" style={{ width: 52, height: 52, padding: 0 }}
                      onClick={() => set({ lines: input.lines.filter((_, j) => j !== i) })}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
                    </button>
                  )}
                </div>
              ))}
              <button type="button" className="add-line" disabled={input.lines.length >= MAX_LINES}
                onClick={() => set({ lines: [...input.lines, { productId: '', quantityMt: '1' }] })}>
                + Add another product
              </button>
            </>
          )}

          {step === 2 && (
            <>
              <h2 style={{ marginTop: 0, fontSize: 24, fontWeight: 800 }}>When does it ship?</h2>
              <div className="form-row">
                <label className="field-stack" style={{ flex: '1 1 240px' }}>
                  Shipping date (PEB date)
                  <input type="date" value={input.pebDate} onChange={(e) => e.target.value && set({ pebDate: e.target.value, paymentDate: input.paymentDate === input.pebDate ? e.target.value : input.paymentDate })} />
                  <span className="help">Decides which rates and reference price apply.</span>
                </label>
                <label className="field-stack" style={{ flex: '1 1 240px' }}>
                  Payment date
                  <input type="date" value={input.paymentDate} onChange={(e) => e.target.value && set({ paymentDate: e.target.value })} />
                  <span className="help">Decides the USD to Rupiah rate (KMK). Usually the same day.</span>
                </label>
              </div>
              <details className="callout" style={{ marginTop: 20 }} open={!!input.refPriceOverride}>
                <summary style={{ fontWeight: 700 }}>Try a different reference price (what-if)</summary>
                <p style={{ margin: '10px 0' }}>For planning only. The result is marked as a simulation and can't be used as evidence.</p>
                <label className="field-stack" style={{ maxWidth: 280 }}>
                  Reference price (USD per tonne)
                  <input value={input.refPriceOverride} onChange={(e) => set({ refPriceOverride: e.target.value })} inputMode="decimal" />
                </label>
              </details>
              {input.refPriceOverride && (
                <p role="status" className="callout danger" style={{ fontWeight: 700 }}>SIMULATION — results use your reference price and are not official evidence.</p>
              )}
            </>
          )}

          {step === 3 && (
            <>
              <h2 style={{ marginTop: 0, fontSize: 24, fontWeight: 800 }}>Your total</h2>
              {busy && !result && <p className="muted">Calculating…</p>}
              {fieldErrors.length === 0 && <ErrorText error={error} />}
              {result && (
                <>
                  <div className="total-hero">
                    <div>
                      <div className="k">{result.isSimulation ? 'SIMULATION · ' : ''}Total to pay for {totalMt.toLocaleString('en')} tonnes</div>
                      <div className="v">IDR {formatDecimal(result.totals.idr, 0)}</div>
                      <div className="p">= USD {formatDecimal(result.totals.usd)}</div>
                    </div>
                    <div className="parts">
                      <div><span>Duty (BK)</span><strong>USD {formatDecimal(result.totals.bkUsd)}</strong></div>
                      <div><span>Levy (PE)</span><strong>USD {formatDecimal(result.totals.peUsd)}</strong></div>
                    </div>
                  </div>
                  <div className="actions">
                    <button type="button" className="primary big" disabled={busy || !!saved} onClick={() => run(true)}>
                      {saved ? 'Saved' : 'Save this calculation'}
                    </button>
                    <button type="button" className="big" onClick={() => window.print()}>Print</button>
                    <button type="button" className="big" onClick={() => navigator.clipboard.writeText(window.location.href).then(() => setCopied(true))}>
                      {copied ? 'Link copied' : 'Copy link'}
                    </button>
                  </div>
                  {saved && <p role="status" className="callout ok">Saved. <a href={`/calculations/${saved}`}>Open the saved calculation</a> to download its evidence PDF.</p>}
                  <h3 style={{ fontSize: 18, marginTop: 28 }}>Breakdown by product</h3>
                  <CalcResultView result={result} />
                </>
              )}
            </>
          )}

          {step < 3 && fieldErrors.length === 0 && <ErrorText error={error} />}
          <div className="wizard-nav">
            <button type="button" className="big" disabled={step === 1} onClick={() => goTo(step - 1)}>Back</button>
            {step < 3 && (
              <button type="button" className="primary big" disabled={!chosen.length || busy} onClick={() => goTo(step + 1)}>
                {step === 2 ? 'Calculate' : 'Next'}
              </button>
            )}
          </div>
        </section>

        <aside className="panel side" aria-label="Shipment summary">
          <h2 style={{ marginTop: 0, fontSize: 20, fontWeight: 800 }}>Your shipment</h2>
          {!chosen.length && <p className="muted" style={{ margin: 0 }}>No products yet. Choose one to start.</p>}
          {chosen.map((l, i) => (
            <div className="summary-row" key={i}><span>{nameOf(l.productId)}</span><strong style={{ whiteSpace: 'nowrap' }}>{Number(l.quantityMt) ? Number(l.quantityMt).toLocaleString('en') : l.quantityMt} t</strong></div>
          ))}
          {chosen.length > 0 && <div className="summary-row total"><span>Total weight</span><span>{totalMt.toLocaleString('en')} t</span></div>}
          <div className="summary-row"><span className="muted">Shipping date</span><span>{input.pebDate}</span></div>
          <p className="callout" style={{ background: 'var(--levy)', color: 'var(--levy-ink)', borderColor: 'transparent', marginBottom: 0 }}>
            Tip: check a single product first on <a href="/find">Find a product</a>.
          </p>
        </aside>
      </div>
    </Page>
  );
}

function ProductPicker({ n, products, value, onChange }: {
  n: number; products: { entityId: string; nameId: string; nameEn: string | null; hsCodes: string[] }[]; value: string; onChange: (id: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const shown = products.filter((p) => p.entityId === value || `${p.nameId} ${p.nameEn ?? ''} ${p.hsCodes.join(' ')} ${p.hsCodes.map((h) => h.replace(/\./g, '')).join(' ')}`
    .toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="form-row">
      <label className="field-stack" style={{ flex: '0 1 170px' }}>
        <span>Search <span className="help">(name or HS)</span></span>
        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="e.g. olein" />
      </label>
      <label className="field-stack" style={{ flex: '1 1 260px', minWidth: 0 }}>
        Product {n}
        <select value={value} onChange={(e) => onChange(e.target.value)} style={{ width: '100%' }}>
          <option value="">— choose a product —</option>
          {shown.map((p) => <option key={p.entityId} value={p.entityId}>{p.nameEn ?? p.nameId} ({p.hsCodes.join(', ')})</option>)}
        </select>
      </label>
    </div>
  );
}

/** Opens the official decree a value came from in the browser's PDF viewer. */
function SourceLink({ id }: { id: string }) {
  return <a href={`/api/source-documents/${id}/file`} target="_blank" rel="noopener">(PDF)</a>;
}

/** The result with every value it used and where it came from (US-44-P1 AC2, BR-CAL-08, BR-CAL-10). */
export function CalcResultView({ result }: { result: CalcResult }) {
  const fx = [...new Map(result.lines.filter((l) => l.fx).map((l) => [l.fx!.periodFrom, l.fx!])).values()];
  return (
    <section aria-label="Result" style={{ marginTop: 16 }}>
      {result.isSimulation && <p style={{ background: 'var(--danger)', color: 'var(--danger-ink)', padding: 8, fontWeight: 700 }}>SIMULATION — reference price {result.refPriceOverride} USD/MT</p>}
      {result.notices?.map((n) => <p key={n} style={{ background: 'var(--warn)', padding: '6px 10px', borderRadius: 6 }}>{n}</p>)}
      {result.missing.length > 0 && (
        <div role="alert" style={{ background: 'var(--warn)', padding: '6px 10px', borderRadius: 6 }}>
          <strong>Not complete:</strong>
          <ul style={{ margin: 0 }}>{result.missing.map((m) => <li key={m}>{m}</li>)}</ul>
        </div>
      )}
      <p style={{ fontSize: 14 }}>
        PEB date {result.pebDate} · payment date {result.paymentDate} · data version {result.versionNo}
        {fx.map((f) => (
          <span key={f.periodFrom}> · KMK {formatDecimal(f.value, 2)} IDR/USD ({f.periodFrom} – {f.periodTo}{f.sourceReference ? `, ${f.sourceReference}` : ''})
            {f.sourceDocumentId && <> <SourceLink id={f.sourceDocumentId} /></>}</span>
        ))}
      </p>
      <TableWrap><table style={tableStyle}>
        <thead>
          <tr style={headStyle}>
            <th>Product</th><th style={{ textAlign: 'right' }}>MT</th><th>BK per MT</th><th style={{ textAlign: 'right' }}>BK USD</th>
            <th>PE per MT</th><th style={{ textAlign: 'right' }}>PE USD</th><th style={{ textAlign: 'right' }}>Total USD</th><th style={{ textAlign: 'right' }}>Total IDR</th>
          </tr>
        </thead>
        <tbody>
          {result.lines.map((l) => (
            <tr key={l.ordinal} style={rowStyle}>
              <td>
                <a href={`/products/${l.productId}?date=${result.pebDate}`}>{l.product}</a>
                {[l.bk, l.pe].filter((c) => c.line).map((c) => (
                  <div key={c.chargeType} style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {c.chargeType}: <a href={`/regulations/${c.line!.regulationId}`}>{c.line!.regulation}</a> {c.line!.annexLabel}{c.line!.kelompok && `, Kelompok ${c.line!.kelompok}`}{c.line!.itemNo && `, no. ${c.line!.itemNo}`}
                    {c.referencePrice && ` · ${c.referencePrice.seriesCode} ${c.referencePrice.value} (${c.referencePrice.periodFrom} – ${c.referencePrice.periodTo})`}
                    {c.referencePrice?.sourceDocumentId && <> <SourceLink id={c.referencePrice.sourceDocumentId} /></>}
                    {c.hargaEkspor && ` · Harga Ekspor ${c.hargaEkspor.value} (${c.hargaEkspor.periodFrom} – ${c.hargaEkspor.periodTo})`}
                  </div>
                ))}
                {l.warnings.map((w) => <div key={w} style={{ fontSize: 12, color: 'var(--warn-ink)' }}>⚠ {w}</div>)}
              </td>
              <td style={{ textAlign: 'right' }}>{l.quantityMt}</td>
              <td>{chargeText(l.bk)}</td>
              <td style={{ textAlign: 'right' }}>{formatDecimal(l.bk.totalUsd)}</td>
              <td>{chargeText(l.pe)}</td>
              <td style={{ textAlign: 'right' }}>{formatDecimal(l.pe.totalUsd)}</td>
              <td style={{ textAlign: 'right' }}>{formatDecimal(l.totalUsd)}</td>
              <td style={{ textAlign: 'right' }}>{formatDecimal(l.totalIdr, 0)}</td>
            </tr>
          ))}
          <tr style={{ fontWeight: 700 }}>
            <td colSpan={3}>Total {result.status === 'INCOMPLETE' && <Badge value="WARNING" title="Some values are missing" />}</td>
            <td style={{ textAlign: 'right' }}>{formatDecimal(result.totals.bkUsd)}</td>
            <td />
            <td style={{ textAlign: 'right' }}>{formatDecimal(result.totals.peUsd)}</td>
            <td style={{ textAlign: 'right' }}>{formatDecimal(result.totals.usd)}</td>
            <td style={{ textAlign: 'right' }}>{formatDecimal(result.totals.idr, 0)}</td>
          </tr>
        </tbody>
      </table></TableWrap>
      <p style={{ fontSize: 12, color: 'var(--muted)' }}>{result.disclaimer}</p>
    </section>
  );
}

export function CalculationsPage() {
  const [list, setList] = useState<Awaited<ReturnType<typeof listCalculations>> | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    listCalculations().then(setList).catch(setError);
  }, []);
  return (
    <Page title="Saved calculations" wide intro="Calculations you saved, with their evidence PDF for customs or finance."
      actions={<a className="button primary" href="/calculator">New calculation</a>}>
      <ErrorText error={error} />
      {list && list.length === 0 && (
        <div className="empty"><strong>No saved calculations yet</strong><p>Calculate a shipment and choose "Save this calculation" to keep it here.</p>
          <a className="button primary" href="/calculator">Calculate a shipment</a></div>
      )}
      {list && list.length > 0 && (
        <TableWrap><table style={tableStyle}>
          <thead><tr style={headStyle}><th>Saved</th><th>Products</th><th>PEB date</th><th>Version</th><th style={{ textAlign: 'right' }}>Total USD</th><th style={{ textAlign: 'right' }}>Total IDR</th><th>Evidence</th></tr></thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id} style={rowStyle}>
                <td><a href={`/calculations/${c.id}`}>{new Date(c.createdAt).toLocaleString()}</a>{c.isSimulation && <> <Badge value="SIMULATION" /></>}</td>
                <td>{c.products}</td>
                <td>{c.pebDate}</td>
                <td>v{c.versionNo}</td>
                <td style={{ textAlign: 'right' }}>{formatDecimal(c.totalUsd)}</td>
                <td style={{ textAlign: 'right' }}>{formatDecimal(c.totalIdr, 0)}</td>
                <td>{c.evidenceId && <a href={`/verify/${c.evidenceId}`}><Badge value="PDF/A" title={c.evidenceId} /></a>}</td>
              </tr>
            ))}
          </tbody>
        </table></TableWrap>
      )}
    </Page>
  );
}

export function CalculationDetail({ me, id }: { me: Me; id: string }) {
  const [calc, setCalc] = useState<Awaited<ReturnType<typeof getCalculation>> | null>(null);
  const [verify, setVerify] = useState<Awaited<ReturnType<typeof verifyCalculation>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    getCalculation(id).then(setCalc).catch(setError);
  }, [id]);
  if (!calc) return <Page title="Saved calculation">{error ? <ErrorText error={error} /> : 'Loading…'}</Page>;

  const can = (permission: string) => me.user.permissions.includes(permission);
  // BR-CAL-12 and FR-EXP-02: only a complete, official calculation becomes evidence.
  const evidenceBlocked = calc.isSimulation ? 'A simulation cannot become evidence.'
    : calc.status !== 'COMPLETE' ? 'A value is missing, so this calculation cannot become evidence.' : null;

  async function makeEvidence() {
    setBusy(true);
    setError(null);
    try {
      const pack = await createEvidence(id);
      setCalc((c) => (c ? { ...c, evidenceId: pack.evidenceId } : c));
      window.location.assign(evidenceFileUrl(pack.evidenceId));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="Saved calculation" wide>
      <p style={{ fontSize: 13, color: 'var(--muted)' }}>
        Saved {calc.createdAt && new Date(calc.createdAt).toLocaleString()} · result hash <code>{calc.resultHash.slice(0, 16)}…</code>{' '}
        <button onClick={() => verifyCalculation(id).then(setVerify).catch(setError)}>Replay and verify</button>
      </p>
      {verify && (
        <p role="status" style={{ color: verify.match ? 'var(--ok-ink)' : 'var(--danger-ink)', fontWeight: 600 }}>
          {verify.match
            ? `Replayed at data version ${verify.versionNo}: identical result.`
            : `Replay at data version ${verify.versionNo} does not match the stored result — report this to the ECR administrators.`}
        </p>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', fontSize: 14, margin: '8px 0 16px' }}>
        {can('export.run') && (
          <>
            <a href={exportUrl(`calculations/${id}`, 'xlsx')} download>Export XLSX</a>
            <a href={exportUrl(`calculations/${id}`, 'csv')} download>Export CSV</a>
          </>
        )}
        {calc.evidenceId ? (
          <>
            <a href={evidenceFileUrl(calc.evidenceId)} download>Download evidence pack (PDF/A)</a>
            <a href={`/verify/${calc.evidenceId}`}>Verify {calc.evidenceId}</a>
          </>
        ) : can('evidence.create') && (
          evidenceBlocked
            ? <span style={{ color: 'var(--muted)' }}>{evidenceBlocked}</span>
            : <button disabled={busy} onClick={makeEvidence}>{busy ? 'Generating…' : 'Generate evidence pack (PDF/A)'}</button>
        )}
      </div>
      <ErrorText error={error} />
      <CalcResultView result={calc} />
    </Page>
  );
}

/** Opened from the link printed on every page of an evidence pack (Technical Design §4.3.3). */
export function VerifyEvidencePage({ id }: { id: string }) {
  const [check, setCheck] = useState<EvidenceCheck | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [file, setFile] = useState<{ name: string; sha256: string } | null>(null);
  useEffect(() => {
    verifyEvidence(id).then(setCheck).catch(setError);
  }, [id]);

  // The file is hashed in the browser; it is never uploaded.
  async function compare(f: File | undefined) {
    if (!f) return;
    const digest = await crypto.subtle.digest('SHA-256', await f.arrayBuffer());
    setFile({ name: f.name, sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('') });
  }

  if (!check) return <Page title="Verify evidence pack">{error ? <ErrorText error={error} /> : 'Checking…'}</Page>;
  const ok = (v: boolean) => <strong style={{ color: v ? 'var(--ok-ink)' : 'var(--danger-ink)' }}>{v ? 'Yes' : 'No'}</strong>;
  const row = (label: string, value: ReactNode) => (
    <tr style={rowStyle}><th style={{ textAlign: 'left', width: 280, fontWeight: 500 }}>{label}</th><td>{value}</td></tr>
  );
  return (
    <Page title="Verify evidence pack" wide>
      <p role="status" style={{ background: check.valid ? 'var(--ok)' : 'var(--danger)', color: check.valid ? 'var(--ok-ink)' : 'var(--danger-ink)', padding: '8px 12px', borderRadius: 6, fontWeight: 700 }}>
        {check.valid
          ? `${check.evidenceId} is genuine: the stored pack is intact and the calculation replays to the same result.`
          : `${check.evidenceId} failed verification — do not rely on it and report it to the ECR administrators.`}
      </p>
      <TableWrap><table style={{ ...tableStyle, maxWidth: 820 }}>
        <tbody>
          {row('Generated', `${new Date(check.createdAt).toLocaleString()} by ${check.createdBy}`)}
          {row('PEB date · payment date', `${check.pebDate} · ${check.paymentDate}`)}
          {row('Data version', `v${check.versionNo}`)}
          {row('Total USD · total IDR', `${formatDecimal(check.totals.usd)} · ${formatDecimal(check.totals.idr, 0)}`)}
          {row('Stored PDF matches its checksum', ok(check.checks.pdfIntact))}
          {row('Printed content matches its hash', ok(check.checks.payloadIntact))}
          {row('Calculation replays identically', ok(check.checks.replayMatch))}
          {row('Content SHA-256 (page footer)', <code style={{ wordBreak: 'break-all' }}>{check.contentSha256}</code>)}
          {row('PDF file SHA-256', <code style={{ wordBreak: 'break-all' }}>{check.pdfSha256}</code>)}
        </tbody>
      </table></TableWrap>
      <h2 style={{ fontSize: 16, marginTop: 24 }}>Lines</h2>
      <TableWrap><table style={{ ...tableStyle, maxWidth: 820 }}>
        <thead><tr style={headStyle}><th>Product</th><th style={{ textAlign: 'right' }}>Quantity MT</th><th style={{ textAlign: 'right' }}>Total USD</th></tr></thead>
        <tbody>
          {check.lines.map((l, i) => (
            <tr key={i} style={rowStyle}>
              <td>{l.product}</td>
              <td style={{ textAlign: 'right' }}>{formatDecimal(l.quantityMt, 3)}</td>
              <td style={{ textAlign: 'right' }}>{formatDecimal(l.totalUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table></TableWrap>
      <h2 style={{ fontSize: 16, marginTop: 24 }}>Compare a file you hold</h2>
      <p style={{ fontSize: 14 }}>
        Choose the PDF you received. It is checked in your browser and not uploaded.{' '}
        <input type="file" accept="application/pdf,.pdf" aria-label="PDF to compare" onChange={(e) => void compare(e.target.files?.[0])} />
      </p>
      {file && (
        <p role="status" style={{ color: file.sha256 === check.pdfSha256 ? 'var(--ok-ink)' : 'var(--danger-ink)', fontWeight: 600 }}>
          {file.sha256 === check.pdfSha256
            ? `${file.name} is identical to the evidence pack ECR issued.`
            : `${file.name} is not the file ECR issued (SHA-256 ${file.sha256.slice(0, 16)}…). It may have been altered.`}
        </p>
      )}
      {check.canDownload && <p style={{ fontSize: 14 }}><a href={evidenceFileUrl(check.evidenceId)} download>Download the original</a></p>}
    </Page>
  );
}
