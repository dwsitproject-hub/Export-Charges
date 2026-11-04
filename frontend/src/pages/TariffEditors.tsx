import { useState } from 'react';
import {
  BandTableData,
  BASES_FOR,
  CADENCES,
  CHARGE_TYPES,
  RefSeriesData,
  RefValueData,
  ScheduleData,
  ScheduleLineData,
  SERIES_KINDS,
} from '../api';
import { Choice, DocumentPicker, grid, input, label, plain, RefOptions, Text } from './Editors';

const ALL_BASES = [...new Set(Object.values(BASES_FOR).flat())];
const BANDED = ['BAND_USD_PER_MT', 'BAND_PCT'];

export function RefSeriesForm({ d, set, refs }: { d: RefSeriesData; set: (p: Partial<RefSeriesData>) => void; refs: RefOptions }) {
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Reference series</h3>
      <div style={grid}>
        <Text name="Code" value={d.code} onChange={(v) => set({ code: (v ?? '').toUpperCase() })} required />
        <Text name="Name" value={d.name} onChange={(v) => set({ name: v ?? '' })} required />
        <Choice name="Kind" value={d.kind} options={plain(SERIES_KINDS)} onChange={(v) => set({ kind: v ?? 'REFERENCE_PRICE' })} required />
        <Text name="Unit" value={d.unit} onChange={(v) => set({ unit: v ?? '' })} required />
        <Choice name="Published" value={d.cadence} options={plain(CADENCES)} onChange={(v) => set({ cadence: v ?? 'MONTHLY' })} required />
        {d.kind === 'HARGA_EKSPOR' && <Choice name="Product" value={d.productId} options={refs.products} onChange={(v) => set({ productId: v })} required />}
      </div>
      <p style={{ fontSize: 13, color: 'var(--muted)' }}>
        e.g. CPO (reference price, USD/MT, monthly, Kepmendag) · FX-USDIDR (IDR/USD, weekly, KMK) · HE-… (Harga Ekspor of one product, MK/BC decision).
      </p>
    </>
  );
}

export function RefValueForm({ d, set, refs }: { d: RefValueData; set: (p: Partial<RefValueData>) => void; refs: RefOptions }) {
  const [docLabel, setDocLabel] = useState<string | null>(d.sourceDocumentId ? (refs.labels[d.sourceDocumentId] ?? null) : null);
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Reference value</h3>
      <div style={grid}>
        <Choice name="Series" value={d.seriesId} options={refs.refSeries} onChange={(v) => set({ seriesId: v })} required />
        <Text name="Period from" type="date" value={d.periodFrom} onChange={(v) => set({ periodFrom: v ?? '' })} required />
        <Text name="Period to" type="date" value={d.periodTo} onChange={(v) => set({ periodTo: v ?? '' })} required />
        <Text name="Value" value={d.value} onChange={(v) => set({ value: v ?? '' })} required />
        <Text name="Decree number" value={d.sourceReference} onChange={(v) => set({ sourceReference: v })} />
      </div>
      <h4>Source decree</h4>
      <p style={{ fontSize: 14 }}>
        {d.sourceDocumentId ? <>Attached: <strong>{docLabel ?? d.sourceDocumentId}</strong></> : <span style={{ color: 'var(--warn-ink)' }}>The official decree is required before submitting.</span>}
      </p>
      <DocumentPicker defaultKind="REF_PRICE_DECREE" exclude={d.sourceDocumentId ? [d.sourceDocumentId] : []}
        onPick={(doc) => { setDocLabel(doc.title); set({ sourceDocumentId: doc.id }); }} />
    </>
  );
}

/** "680, 730, 780" → ≤ 680 · 680–730 · 730–780 · > 780 (the last band has no ceiling). */
function bandsFromEdges(text: string): BandTableData['bands'] {
  const edges = text.split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean);
  return [...edges, null].map((upper, i) => ({ lowerExclusive: i === 0 ? null : edges[i - 1], upperInclusive: upper, label: '' }));
}

export function BandTableForm({ d, set, refs }: { d: BandTableData; set: (p: Partial<BandTableData>) => void; refs: RefOptions }) {
  const [edges, setEdges] = useState('');
  const band = (i: number, patch: Partial<BandTableData['bands'][number]>) => set({ bands: d.bands.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Band table</h3>
      <div style={grid}>
        <Text name="Code" value={d.code} onChange={(v) => set({ code: (v ?? '').toUpperCase() })} required />
        <Text name="Name" value={d.name} onChange={(v) => set({ name: v ?? '' })} required />
        <Choice name="Reference series" value={d.refSeriesId} options={refs.refSeries.filter((s) => s.kind === 'REFERENCE_PRICE')}
          onChange={(v) => set({ refSeriesId: v })} required />
      </div>
      <h4>Bands (lower edge exclusive, upper edge inclusive; first from 0, last without ceiling)</h4>
      <div style={{ display: 'flex', gap: 8, alignItems: 'end', marginBottom: 8 }}>
        <Text name="Fill from upper edges, e.g. 680, 730, 780" value={edges} onChange={(v) => setEdges(v ?? '')} />
        <button type="button" disabled={!edges.trim()} onClick={() => set({ bands: bandsFromEdges(edges) })}>Fill bands</button>
      </div>
      {d.bands.map((b, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
          <span style={{ width: 24, fontSize: 13 }}>{i + 1}.</span>
          <Text name="Above" value={b.lowerExclusive} onChange={(v) => band(i, { lowerExclusive: v })} />
          <Text name="Up to and including" value={b.upperInclusive} onChange={(v) => band(i, { upperInclusive: v })} />
          <Text name="Label (blank = automatic)" value={b.label} onChange={(v) => band(i, { label: v ?? '' })} />
          <button type="button" onClick={() => set({ bands: d.bands.filter((_, j) => j !== i) })}>Remove</button>
        </div>
      ))}
      <button type="button" style={{ marginTop: 8 }}
        onClick={() => set({ bands: [...d.bands, { lowerExclusive: d.bands.at(-1)?.upperInclusive ?? null, upperInclusive: null, label: '' }] })}>
        Add band
      </button>
    </>
  );
}

export function ScheduleForm({ d, set, refs }: { d: ScheduleData; set: (p: Partial<ScheduleData>) => void; refs: RefOptions }) {
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Schedule (annex)</h3>
      <div style={grid}>
        <Choice name="Regulation" value={d.regulationId} options={refs.regulations} onChange={(v) => set({ regulationId: v })} required />
        <Choice name="Charge" value={d.chargeType} options={[{ id: 'BK', label: 'BK — export duty' }, { id: 'PE', label: 'PE — export levy' }]}
          onChange={(v) => set({ chargeType: v ?? CHARGE_TYPES[0] })} required />
        <Text name="Annex (Lampiran)" value={d.annexLabel} onChange={(v) => set({ annexLabel: v ?? '' })} required />
        <Choice name="Commodity" value={d.commodityId} options={refs.commodities} onChange={(v) => set({ commodityId: v })} required />
      </div>
    </>
  );
}

export function ScheduleLineForm({ d, set, refs }: { d: ScheduleLineData; set: (p: Partial<ScheduleLineData>) => void; refs: RefOptions }) {
  const [filter, setFilter] = useState('');
  const schedule = refs.schedules.find((s) => s.id === d.scheduleId);
  const bases = schedule ? BASES_FOR[schedule.chargeType] : ALL_BASES;
  const banded = BANDED.includes(d.basisType);
  const table = refs.bandTables.find((t) => t.id === d.bandTableId);
  const unit = d.basisType === 'BAND_PCT' ? '%' : 'USD/MT';

  function chooseTable(id: string | null) {
    const t = refs.bandTables.find((x) => x.id === id);
    // One amount per band; keep what was typed where the band still exists.
    set({ bandTableId: id, refSeriesId: t?.refSeriesId ?? d.refSeriesId, bandValues: t ? t.bands.map((_, i) => d.bandValues[i] ?? '') : [] });
  }

  return (
    <>
      <h3 style={{ marginTop: 0 }}>Schedule line</h3>
      <div style={grid}>
        <Choice name="Schedule" value={d.scheduleId} options={refs.schedules} onChange={(v) => set({ scheduleId: v })} required />
        <Text name="Kelompok" value={d.kelompok} onChange={(v) => set({ kelompok: v })} />
        <Text name="Item no." value={d.itemNo} onChange={(v) => set({ itemNo: v })} />
        <Text name="Valid from" type="date" value={d.validFrom} onChange={(v) => set({ validFrom: v })} required />
        <Text name="Valid to" type="date" value={d.validTo} onChange={(v) => set({ validTo: v })} />
      </div>
      <label style={label}>Uraian (verbatim from the annex) *
        <textarea rows={3} value={d.uraian} onChange={(e) => set({ uraian: e.target.value })} style={input} />
      </label>

      <h4>Rate</h4>
      <div style={grid}>
        <Choice name="Basis" value={d.basisType} options={plain(bases)} onChange={(v) => set({ basisType: v ?? bases[0] })} required />
        {(d.basisType === 'PCT_OF_REF_PRICE' || d.basisType === 'AD_VALOREM_PCT') && (
          <Text name={d.basisType === 'AD_VALOREM_PCT' ? 'Rate (% of Harga Ekspor)' : 'Rate (% of reference price)'} value={d.pct} onChange={(v) => set({ pct: v })} required />
        )}
        {d.basisType === 'FIXED_USD_PER_MT' && <Text name="USD per MT" value={d.usdPerMt} onChange={(v) => set({ usdPerMt: v })} required />}
        {banded && <Choice name="Band table" value={d.bandTableId} options={refs.bandTables} onChange={chooseTable} required />}
        {(banded || d.basisType === 'PCT_OF_REF_PRICE') && (
          <Choice name="Reference price series" value={d.refSeriesId} options={refs.refSeries.filter((s) => s.kind === 'REFERENCE_PRICE')}
            onChange={(v) => set({ refSeriesId: v })} required />
        )}
      </div>
      {d.basisType === 'ZERO_LISTED' && <p style={{ fontSize: 13 }}>Listed in the annex at 0 — shown to users as "Listed at 0", not "Not listed".</p>}
      {banded && table && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '0 8px' }}>
          {table.bands.map((b, i) => (
            <Text key={i} name={`${b.label} (${unit})`} value={d.bandValues[i] ?? ''}
              onChange={(v) => set({ bandValues: table.bands.map((_, j) => (j === i ? (v ?? '') : (d.bandValues[j] ?? ''))) })} />
          ))}
        </div>
      )}

      <h4>Products ({d.productIds.length})</h4>
      <input placeholder="Filter products" aria-label="Filter products" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 280 }} />
      <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--line)', padding: 8, marginTop: 4 }}>
        {refs.products.filter((p) => d.productIds.includes(p.id) || p.label.toLowerCase().includes(filter.toLowerCase())).map((p) => (
          <label key={p.id} style={{ display: 'block', fontSize: 14 }}>
            <input type="checkbox" checked={d.productIds.includes(p.id)}
              onChange={(e) => set({ productIds: e.target.checked ? [...d.productIds, p.id] : d.productIds.filter((x) => x !== p.id) })} /> {p.label}
          </label>
        ))}
      </div>
    </>
  );
}
