import { useEffect, useState, type ReactNode } from 'react';
import {
  Band,
  BandTableData,
  CommodityData,
  DOC_KINDS,
  DOC_ROLES,
  EntityData,
  EntityType,
  GroupData,
  listSourceDocuments,
  PARAM_OPERATORS,
  ProductData,
  REG_RELATIONS,
  REG_STATUSES,
  REG_TYPES,
  RefSeriesData,
  RefValueData,
  RegulationData,
  ScheduleData,
  ScheduleLineData,
  SourceDocument,
  uploadSourceDocument,
} from '../api';
import { ErrorText } from '../ui';
import { BandTableForm, RefSeriesForm, RefValueForm, ScheduleForm, ScheduleLineForm } from './TariffEditors';

/** Choices for reference fields: published records plus records created in the same change set. */
export interface RefOptions {
  regulations: { id: string; label: string }[];
  commodities: { id: string; label: string }[];
  groups: { id: string; label: string }[];
  products: { id: string; label: string }[];
  refSeries: { id: string; label: string; kind: string }[];
  bandTables: { id: string; label: string; refSeriesId: string | null; bands: Band[] }[];
  schedules: { id: string; label: string; chargeType: string }[];
  /** Titles of documents already attached somewhere in the set, by id. */
  labels: Record<string, string>;
}

export const EMPTY: Record<EntityType, EntityData> = {
  REGULATION: {
    regType: 'PMK', number: '', year: new Date().getFullYear(), titleId: '', titleEn: null, issuer: 'Kementerian Keuangan', status: 'IN_FORCE',
    promulgatedOn: null, effectiveOn: null, endsOn: null, officialUrl: null, bpkStatusUrl: null, relations: [], documents: [],
  },
  COMMODITY: { code: '', nameId: '', nameEn: null, isInScope: true, validFrom: null, validTo: null },
  PRODUCT_GROUP: { commodityId: null, code: '', label: '', ordinal: 1, validFrom: null, validTo: null },
  PRODUCT: {
    groupId: null, itemNoAsPrinted: null, nameId: '', nameEn: null, synonyms: [], definition: null, notes: [], annexPage: null,
    classificationRegulationId: null, validFrom: null, validTo: null, fxOnPebDate: false, otherObligationsNote: null, parameters: [], hsCodes: [],
  },
  REF_SERIES: { code: '', name: '', kind: 'REFERENCE_PRICE', unit: 'USD/MT', cadence: 'MONTHLY', productId: null },
  REF_VALUE: { seriesId: null, periodFrom: '', periodTo: '', value: '', sourceDocumentId: null, sourceReference: null },
  BAND_TABLE: { code: '', name: '', refSeriesId: null, bands: [], validFrom: null, validTo: null },
  SCHEDULE: { regulationId: null, chargeType: 'BK', annexLabel: '', commodityId: null, validFrom: null, validTo: null },
  SCHEDULE_LINE: {
    scheduleId: null, kelompok: null, itemNo: null, uraian: '', basisType: 'BAND_USD_PER_MT', pct: null, usdPerMt: null, bandTableId: null,
    refSeriesId: null, bandValues: [], productIds: [], validFrom: null, validTo: null,
  },
};

export const label = { display: 'block', fontSize: 13, marginTop: 8 } as const;
export const input = { display: 'block', width: '100%', boxSizing: 'border-box' } as const;
export const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0 12px' } as const;

export function Text({ name, value, onChange, required, type = 'text' }: {
  name: string; value: string | number | null; onChange: (v: string | null) => void; required?: boolean; type?: string;
}) {
  return (
    <label style={label}>
      {name}{required && ' *'}
      <input type={type} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} style={input} />
    </label>
  );
}

export function Choice({ name, value, options, onChange, required }: {
  name: string; value: string | null; options: { id: string; label: string }[]; onChange: (v: string | null) => void; required?: boolean;
}) {
  return (
    <label style={label}>
      {name}{required && ' *'}
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} style={input}>
        <option value="">—</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </label>
  );
}

export const plain = (list: string[]) => list.map((v) => ({ id: v, label: v.replace(/_/g, ' ') }));
const num = (v: string | null) => (v === null ? null : Number(v));
const lines = (v: string | null) => (v ?? '').split('\n').map((s) => s.trim()).filter(Boolean);

/** Form for one record's proposed state; `onSave` receives the API shape. */
export function EntityEditor({ type, initial, refs, onSave, onCancel }: {
  type: EntityType; initial: EntityData; refs: RefOptions; onSave: (after: EntityData) => Promise<void>; onCancel: () => void;
}) {
  const [data, setData] = useState<EntityData>(initial);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await onSave(data);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const set = <T extends EntityData>(patch: Partial<T>) => setData({ ...(data as T), ...patch });
  let form: ReactNode;
  if (type === 'REGULATION') form = <RegulationForm d={data as RegulationData} set={set} refs={refs} />;
  else if (type === 'COMMODITY') form = <CommodityForm d={data as CommodityData} set={set} />;
  else if (type === 'PRODUCT_GROUP') form = <GroupForm d={data as GroupData} set={set} refs={refs} />;
  else if (type === 'PRODUCT') form = <ProductForm d={data as ProductData} set={set} refs={refs} />;
  else if (type === 'REF_SERIES') form = <RefSeriesForm d={data as RefSeriesData} set={set} refs={refs} />;
  else if (type === 'REF_VALUE') form = <RefValueForm d={data as RefValueData} set={set} refs={refs} />;
  else if (type === 'BAND_TABLE') form = <BandTableForm d={data as BandTableData} set={set} refs={refs} />;
  else if (type === 'SCHEDULE') form = <ScheduleForm d={data as ScheduleData} set={set} refs={refs} />;
  else form = <ScheduleLineForm d={data as ScheduleLineData} set={set} refs={refs} />;

  return (
    <section style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 16, marginTop: 16 }} aria-label="Edit record">
      {form}
      <ErrorText error={error} />
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button onClick={save} disabled={busy}>Save to this update</button>
        <button onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- regulation

function RegulationForm({ d, set, refs }: { d: RegulationData; set: (p: Partial<RegulationData>) => void; refs: RefOptions }) {
  const [docLabels, setDocLabels] = useState<Record<string, string>>(refs.labels);
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Regulation</h3>
      <div style={grid}>
        <Choice name="Type" value={d.regType} options={plain(REG_TYPES)} onChange={(v) => set({ regType: v ?? 'PMK' })} required />
        <Text name="Number" value={d.number} onChange={(v) => set({ number: v ?? '' })} required />
        <Text name="Year" type="number" value={d.year} onChange={(v) => set({ year: num(v) ?? 0 })} required />
        <Choice name="Status" value={d.status} options={plain(REG_STATUSES)} onChange={(v) => set({ status: v ?? 'IN_FORCE' })} required />
      </div>
      <Text name="Title (Bahasa Indonesia, as printed)" value={d.titleId} onChange={(v) => set({ titleId: v ?? '' })} required />
      <Text name="Title (English)" value={d.titleEn} onChange={(v) => set({ titleEn: v })} />
      <Text name="Issuer" value={d.issuer} onChange={(v) => set({ issuer: v ?? '' })} required />
      <div style={grid}>
        <Text name="Promulgated on" type="date" value={d.promulgatedOn} onChange={(v) => set({ promulgatedOn: v })} />
        <Text name="Effective on" type="date" value={d.effectiveOn} onChange={(v) => set({ effectiveOn: v })} />
        <Text name="Ends on" type="date" value={d.endsOn} onChange={(v) => set({ endsOn: v })} />
      </div>
      <Text name="Official page (allow-listed publisher)" value={d.officialUrl} onChange={(v) => set({ officialUrl: v })} />
      <Text name="BPK status page (peraturan.bpk.go.id)" value={d.bpkStatusUrl} onChange={(v) => set({ bpkStatusUrl: v })} />

      <h4>Amendment links</h4>
      {d.relations.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
          <Choice name="Relation" value={r.relation} options={plain(REG_RELATIONS)}
            onChange={(v) => set({ relations: d.relations.map((x, j) => (j === i ? { ...x, relation: v ?? 'AMENDS' } : x)) })} />
          <Choice name="Regulation" value={r.regulationId} options={refs.regulations}
            onChange={(v) => set({ relations: d.relations.map((x, j) => (j === i ? { ...x, regulationId: v ?? '' } : x)) })} />
          <button type="button" onClick={() => set({ relations: d.relations.filter((_, j) => j !== i) })}>Remove</button>
        </div>
      ))}
      <button type="button" style={{ marginTop: 8 }} onClick={() => set({ relations: [...d.relations, { relation: 'AMENDS', regulationId: '' }] })}>
        Add link
      </button>

      <h4>Source documents</h4>
      {d.documents.length === 0 && <p style={{ fontSize: 13, color: 'var(--warn-ink)' }}>An official PDF is required before the update can be sent for review.</p>}
      {d.documents.map((doc, i) => (
        <div key={doc.sourceDocumentId} style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
          <span style={{ flex: 1, fontSize: 14 }}>{docLabels[doc.sourceDocumentId] ?? doc.sourceDocumentId}</span>
          <Choice name="Role" value={doc.role} options={plain(DOC_ROLES)}
            onChange={(v) => set({ documents: d.documents.map((x, j) => (j === i ? { ...x, role: v ?? 'MAIN' } : x)) })} />
          <button type="button" onClick={() => set({ documents: d.documents.filter((_, j) => j !== i) })}>Remove</button>
        </div>
      ))}
      <DocumentPicker
        exclude={d.documents.map((x) => x.sourceDocumentId)}
        onPick={(doc) => {
          setDocLabels({ ...docLabels, [doc.id]: doc.title });
          set({ documents: [...d.documents, { sourceDocumentId: doc.id, role: d.documents.length ? 'ANNEX' : 'MAIN' }] });
        }}
      />
    </>
  );
}

/** Attach an uploaded document, or upload a new PDF (checked as PDF, scanned and hashed by the API). */
export function DocumentPicker({ exclude, onPick, defaultKind = 'REGULATION' }: {
  exclude: string[]; onPick: (doc: SourceDocument) => void; defaultKind?: string;
}) {
  const [docs, setDocs] = useState<SourceDocument[]>([]);
  const [file, setFile] = useState<File | null>(null);
  // Remounting the file input is the only way to clear a browser file picker.
  const [inputKey, setInputKey] = useState(0);
  const [meta, setMeta] = useState({ title: '', officialUrl: '', docNumber: '', docDate: '', docKind: defaultKind, isSecondary: false });
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    listSourceDocuments().then(setDocs).catch(setError);
  }, []);

  async function upload() {
    if (!file) return;
    setError(null);
    try {
      const doc = await uploadSourceDocument(file, { ...meta, isSecondary: String(meta.isSecondary) });
      setNotice(doc.reused ? `This file was already uploaded as “${doc.title}”; attached that record.` : `Uploaded (SHA-256 ${doc.sha256.slice(0, 12)}…).`);
      setDocs([doc, ...docs.filter((x) => x.id !== doc.id)]);
      onPick(doc);
      setFile(null);
      setInputKey((k) => k + 1);
    } catch (e) {
      setError(e);
    }
  }

  const available = docs.filter((x) => !exclude.includes(x.id));
  return (
    <div style={{ background: 'var(--subtle)', padding: 12, borderRadius: 6, marginTop: 8 }}>
      {available.length > 0 && (
        <Choice name="Attach an uploaded document" value={null}
          options={available.map((x) => ({ id: x.id, label: `${x.title}${x.isSecondary ? ' (secondary)' : ''}` }))}
          onChange={(id) => { const doc = docs.find((x) => x.id === id); if (doc) onPick(doc); }} />
      )}
      <p style={{ fontSize: 13, margin: '12px 0 0' }}>…or upload the official PDF (max 25 MB)</p>
      <input key={inputKey} type="file" accept="application/pdf" aria-label="PDF file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <div style={grid}>
        <Text name="Title" value={meta.title} onChange={(v) => setMeta({ ...meta, title: v ?? '' })} required />
        <Text name="Official URL" value={meta.officialUrl} onChange={(v) => setMeta({ ...meta, officialUrl: v ?? '' })} required />
        <Text name="Document number" value={meta.docNumber} onChange={(v) => setMeta({ ...meta, docNumber: v ?? '' })} />
        <Text name="Document date" type="date" value={meta.docDate} onChange={(v) => setMeta({ ...meta, docDate: v ?? '' })} />
        <Choice name="Kind" value={meta.docKind} options={plain(DOC_KINDS)} onChange={(v) => setMeta({ ...meta, docKind: v ?? 'REGULATION' })} />
      </div>
      <label style={{ fontSize: 13, display: 'block', marginTop: 8 }}>
        <input type="checkbox" checked={meta.isSecondary} onChange={(e) => setMeta({ ...meta, isSecondary: e.target.checked })} />
        {' '}Secondary reference (news or consultancy; never a source of record)
      </label>
      <button type="button" style={{ marginTop: 8 }} disabled={!file} onClick={upload}>Upload and attach</button>
      {notice && <p role="status" style={{ color: 'var(--ok-ink)', fontSize: 13 }}>{notice}</p>}
      <ErrorText error={error} />
    </div>
  );
}

// ---------------------------------------------------------------- commodity and group

function CommodityForm({ d, set }: { d: CommodityData; set: (p: Partial<CommodityData>) => void }) {
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Commodity</h3>
      <div style={grid}>
        <Text name="Code" value={d.code} onChange={(v) => set({ code: (v ?? '').toUpperCase() })} required />
        <Text name="Name (ID)" value={d.nameId} onChange={(v) => set({ nameId: v ?? '' })} required />
        <Text name="Name (EN)" value={d.nameEn} onChange={(v) => set({ nameEn: v })} />
      </div>
      <label style={label}><input type="checkbox" checked={d.isInScope} onChange={(e) => set({ isInScope: e.target.checked })} /> In scope</label>
    </>
  );
}

function GroupForm({ d, set, refs }: { d: GroupData; set: (p: Partial<GroupData>) => void; refs: RefOptions }) {
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Product group</h3>
      <div style={grid}>
        <Choice name="Commodity" value={d.commodityId} options={refs.commodities} onChange={(v) => set({ commodityId: v })} required />
        <Text name="Code" value={d.code} onChange={(v) => set({ code: v ?? '' })} required />
        <Text name="Label" value={d.label} onChange={(v) => set({ label: v ?? '' })} required />
        <Text name="Display order" type="number" value={d.ordinal} onChange={(v) => set({ ordinal: num(v) ?? 0 })} required />
      </div>
    </>
  );
}

// ---------------------------------------------------------------- product

function ProductForm({ d, set, refs }: { d: ProductData; set: (p: Partial<ProductData>) => void; refs: RefOptions }) {
  const param = (i: number, patch: Partial<ProductData['parameters'][number]>) =>
    set({ parameters: d.parameters.map((x, j) => (j === i ? { ...x, ...patch } : patch.isPrimary ? { ...x, isPrimary: false } : x)) });
  const hs = (i: number, patch: Partial<ProductData['hsCodes'][number]>) =>
    set({ hsCodes: d.hsCodes.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Product</h3>
      <div style={grid}>
        <Choice name="Group" value={d.groupId} options={refs.groups} onChange={(v) => set({ groupId: v })} required />
        <Text name="Item no. (as printed)" value={d.itemNoAsPrinted} onChange={(v) => set({ itemNoAsPrinted: v })} />
        <Choice name="Classification regulation" value={d.classificationRegulationId} options={refs.regulations}
          onChange={(v) => set({ classificationRegulationId: v })} required />
        <Text name="Annex page" type="number" value={d.annexPage} onChange={(v) => set({ annexPage: num(v) })} />
        <Text name="Valid from" type="date" value={d.validFrom} onChange={(v) => set({ validFrom: v })} required />
        <Text name="Valid to" type="date" value={d.validTo} onChange={(v) => set({ validTo: v })} />
      </div>
      <Text name="Name (ID, as printed)" value={d.nameId} onChange={(v) => set({ nameId: v ?? '' })} required />
      <Text name="Name (EN)" value={d.nameEn} onChange={(v) => set({ nameEn: v })} />
      <label style={label}>Definition<textarea rows={3} value={d.definition ?? ''} onChange={(e) => set({ definition: e.target.value || null })} style={input} /></label>
      <label style={label}>Synonyms (one per line)<textarea rows={2} value={d.synonyms.join('\n')} onChange={(e) => set({ synonyms: lines(e.target.value) })} style={input} /></label>
      <label style={label}>Notes (one per line)<textarea rows={2} value={d.notes.join('\n')} onChange={(e) => set({ notes: lines(e.target.value) })} style={input} /></label>
      <Text name="Other obligations (informational)" value={d.otherObligationsNote} onChange={(v) => set({ otherObligationsNote: v })} />
      <label style={label}>
        <input type="checkbox" checked={d.fxOnPebDate} onChange={(e) => set({ fxOnPebDate: e.target.checked })} /> Special-characteristic goods: IDR at the PEB date
      </label>

      <h4>HS codes (BTKI 2022, 8 digits)</h4>
      {d.hsCodes.map((h, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
          <Text name="Code" value={h.code} onChange={(v) => hs(i, { code: v ?? '' })} />
          <label style={{ ...label, whiteSpace: 'nowrap' }}><input type="checkbox" checked={h.isEx} onChange={(e) => hs(i, { isEx: e.target.checked })} /> ex-code</label>
          {h.isEx && <Text name="Qualifying description" value={h.exDescription} onChange={(v) => hs(i, { exDescription: v })} />}
          <button type="button" onClick={() => set({ hsCodes: d.hsCodes.filter((_, j) => j !== i) })}>Remove</button>
        </div>
      ))}
      <button type="button" style={{ marginTop: 8 }} onClick={() => set({ hsCodes: [...d.hsCodes, { code: '', isEx: false, exDescription: null }] })}>Add HS code</button>

      <h4>Technical parameters</h4>
      {d.parameters.map((p, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
          <Text name="Name" value={p.name} onChange={(v) => param(i, { name: v ?? '' })} />
          <Choice name="Operator" value={p.operator} options={plain(PARAM_OPERATORS)} onChange={(v) => param(i, { operator: v ?? '=' })} />
          <Text name="Value (as printed)" value={p.valueText} onChange={(v) => param(i, { valueText: v ?? '' })} />
          <Text name="Min" type="number" value={p.valueMin} onChange={(v) => param(i, { valueMin: num(v) })} />
          <Text name="Max" type="number" value={p.valueMax} onChange={(v) => param(i, { valueMax: num(v) })} />
          <Text name="Unit" value={p.unit} onChange={(v) => param(i, { unit: v })} />
          <label style={{ ...label, whiteSpace: 'nowrap' }}>
            <input type="radio" name="primary" checked={p.isPrimary} onChange={() => param(i, { isPrimary: true })} /> Key spec
          </label>
          <button type="button" onClick={() => set({ parameters: d.parameters.filter((_, j) => j !== i) })}>Remove</button>
        </div>
      ))}
      <button type="button" style={{ marginTop: 8 }}
        onClick={() => set({ parameters: [...d.parameters, { name: '', operator: '≤', valueText: '', valueMin: null, valueMax: null, unit: null, isPrimary: !d.parameters.length }] })}>
        Add parameter
      </button>
    </>
  );
}
