import { useEffect, useState, type FormEvent } from 'react';
import {
  ApiFailure,
  ChangeItem,
  ChangeSet,
  changeSetAction,
  ChangeSetSummary,
  createChangeSet,
  EntityData,
  EntityType,
  BandTableData,
  Charge,
  formatDecimal,
  getChangeSet,
  getImpact,
  getProduct,
  getRefSeries,
  getRegulation,
  getSchedule,
  ImpactRow,
  listBandTables,
  listChangeSets,
  listCommodities,
  listProducts,
  listRefSeries,
  listRegulations,
  listSchedules,
  Me,
  Operation,
  removeChangeItem,
  rollbackVersion,
  RefSeriesData,
  saveChangeItem,
  ScheduleData,
} from '../api';
import { hubTrack } from '../hubSdk';
import { Badge, ErrorText, headStyle, Page, rowStyle, tableStyle, useStepUp, TableWrap } from '../ui';
import { EMPTY, EntityEditor, RefOptions } from './Editors';

const OPEN = 'DRAFT,SUBMITTED,IN_REVIEW,REJECTED,APPROVED,SCHEDULED';
const TYPE_LABEL: Record<EntityType, string> = {
  REGULATION: 'Regulation', COMMODITY: 'Commodity', PRODUCT_GROUP: 'Product group', PRODUCT: 'Product',
  REF_SERIES: 'Reference series', REF_VALUE: 'Reference value', BAND_TABLE: 'Band table', SCHEDULE: 'Schedule', SCHEDULE_LINE: 'Schedule line',
};

type Option = { id: string; label: string };

/** Published records the editors can refer to or start from. */
interface Published extends Omit<RefOptions, 'labels'> {
  values: Option[];
  lines: Option[];
  /** Published records in API shape (plus display fields), for editing without another request. */
  records: Record<string, unknown>;
}

const NO_PUBLISHED: Published = {
  regulations: [], commodities: [], groups: [], products: [], refSeries: [], bandTables: [], schedules: [], values: [], lines: [], records: {},
};

async function loadPublished(): Promise<Published> {
  const [regs, coms, prods, series, tables, schedules] = await Promise.all([
    listRegulations(), listCommodities(), listProducts(), listRefSeries(), listBandTables(), listSchedules(),
  ]);
  const [seriesDetails, scheduleDetails] = await Promise.all([
    Promise.all(series.map((x) => getRefSeries(x.entityId))),
    Promise.all(schedules.map((x) => getSchedule(x.entityId))),
  ]);
  const records: Record<string, unknown> = {};
  for (const c of coms) {
    records[c.entityId] = c;
    for (const g of c.groups) records[g.entityId] = g;
  }
  for (const x of [...series, ...tables, ...schedules]) records[x.entityId] = x;
  for (const x of seriesDetails.flatMap((d) => d.values)) records[x.entityId] = x;
  for (const x of scheduleDetails.flatMap((d) => d.lines)) records[x.entityId] = x;
  return {
    regulations: regs.map((r) => ({ id: r.entityId, label: r.label })),
    commodities: coms.map((c) => ({ id: c.entityId, label: `${c.code} — ${c.nameId}` })),
    groups: coms.flatMap((c) => c.groups.map((g) => ({ id: g.entityId, label: `${c.code} · ${g.label}` }))),
    products: prods.map((p) => ({ id: p.entityId, label: `${p.group?.label ?? ''} ${p.itemNoAsPrinted ?? ''} ${p.nameId}`.trim() })),
    refSeries: series.map((x) => ({ id: x.entityId, label: x.code, kind: x.kind })),
    bandTables: tables.map((t) => ({ id: t.entityId, label: t.code, refSeriesId: t.refSeriesId, bands: t.bands })),
    schedules: schedules.map((x) => ({ id: x.entityId, label: `${x.chargeType} ${x.annexLabel} — ${x.regulation ?? ''}`, chargeType: x.chargeType })),
    values: seriesDetails.flatMap((d) => d.values.map((v) => ({ id: v.entityId, label: `${d.code} ${v.periodFrom} – ${v.periodTo}: ${v.value}` }))),
    lines: scheduleDetails.flatMap((d) => d.lines.map((l) => ({ id: l.entityId, label: `${d.chargeType} ${d.annexLabel} · ${l.label}` }))),
    records,
  };
}

const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10); // WIB

function NeedsAuthenticator() {
  return (
    <Page title="Rate updates">
      <p>Set up your authenticator app before working with rate updates.</p>
      <a href="/settings/authenticator">Set up authenticator</a>
    </Page>
  );
}

// ---------------------------------------------------------------- list

export function ChangeSetsPage({ me }: { me: Me }) {
  const [filter, setFilter] = useState(OPEN);
  const [sets, setSets] = useState<ChangeSetSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [title, setTitle] = useState('');
  const [justification, setJustification] = useState('');

  const allowed = me.user.permissions.includes('changeset.read');
  useEffect(() => {
    if (allowed) listChangeSets(filter).then(setSets).catch(setError);
  }, [filter, allowed]);

  if (!allowed) return <Page title="Rate updates"><p>You don't have access to rate updates.</p></Page>;
  if (error instanceof ApiFailure && error.code === 'TOTP_ENROLLMENT_REQUIRED') return <NeedsAuthenticator />;

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      const set = await createChangeSet(title, justification);
      window.location.assign(`/change-sets/${set.id}`);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Page title="Rate updates" wide intro="Every change to rates, prices or products is entered by one person (Maker) and goes live only after a second person (Checker) approves it.">
      {me.user.permissions.includes('changeset.create') && (
        <section className="panel" aria-labelledby="new-update">
          <h2 id="new-update" style={{ marginTop: 0 }}>Start a new rate update</h2>
          <form onSubmit={create} className="form-row">
            <label className="field-stack" style={{ flex: '1 1 280px' }}>
              What's changing?
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. CPO reference price for December 2026" />
            </label>
            <label className="field-stack" style={{ flex: '1 1 320px' }}>
              <span>Why? <span className="help">(the decree or reason)</span></span>
              <input value={justification} onChange={(e) => setJustification(e.target.value)} placeholder="e.g. Kepmendag published on 28 Nov" />
            </label>
            <button type="submit" className="primary big">Start</button>
          </form>
        </section>
      )}
      <div role="tablist" aria-label="Show" className="segmented">
        {[['Not yet live', OPEN], ['Live', 'PUBLISHED'], ['All', '']].map(([name, value]) => (
          <button key={name} role="tab" aria-selected={filter === value} onClick={() => setFilter(value)}>{name}</button>
        ))}
      </div>
      <ErrorText error={error} />
      {sets && sets.length === 0 && (
        <div className="empty"><strong>Nothing here</strong><p>{filter === OPEN ? 'No updates are waiting. Everything entered so far is live.' : 'No rate updates yet.'}</p></div>
      )}
      {sets && sets.length > 0 && (
        <section className="panel">
          <ul className="feed">
            {sets.map((s) => (
              <li key={s.id}>
                <a href={`/change-sets/${s.id}`}>
                  <Badge value={s.status} />
                  <span className="body">
                    <strong>{s.title}{s.kind !== 'NORMAL' && <> <Badge value={s.kind} /></>}</strong>
                    <span>
                      {s.itemCount} change{s.itemCount === 1 ? '' : 's'} · entered by {s.createdByName}
                      {s.reviewedByName && ` · checked by ${s.reviewedByName}`}{s.versionNo && ` · version ${s.versionNo}`}
                    </span>
                  </span>
                  <span className="when">{new Date(s.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Page>
  );
}

// ---------------------------------------------------------------- detail

interface EditorState {
  type: EntityType;
  operation: Operation;
  initial: EntityData;
  itemId?: string;
  entityId?: string;
}

export function ChangeSetDetail({ me, id }: { me: Me; id: string }) {
  const [set, setSet] = useState<ChangeSet | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [published, setPublished] = useState<Published>(NO_PUBLISHED);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { run, dialog } = useStepUp();

  const load = () => getChangeSet(id).then(setSet).catch(setError);

  useEffect(() => {
    void load();
    loadPublished().then(setPublished).catch(setError);
  }, [id]);

  if (error instanceof ApiFailure && error.code === 'TOTP_ENROLLMENT_REQUIRED') return <NeedsAuthenticator />;
  if (!set) return <Page title="Rate update">{error ? <ErrorText error={error} /> : 'Loading…'}</Page>;

  const perms = me.user.permissions;
  const isOwner = set.createdBy.id === me.user.id;
  const editable = isOwner && perms.includes('changeset.create') && ['DRAFT', 'REJECTED'].includes(set.status);
  const isEditor = set.editors.includes(me.user.id);
  const canReview = perms.includes('changeset.approve') && !isEditor;

  // Records created in this set can be referenced by other items in it.
  const created = (type: EntityType) => set.items.filter((i) => i.entityType === type && i.operation === 'CREATE');
  const inSet = (type: EntityType) => created(type).map((i) => ({ id: i.entityId, label: `${i.label} (in this update)` }));
  const refs: RefOptions = {
    regulations: [...published.regulations, ...inSet('REGULATION')],
    commodities: [...published.commodities, ...inSet('COMMODITY')],
    groups: [...published.groups, ...inSet('PRODUCT_GROUP')],
    products: [...published.products, ...inSet('PRODUCT')],
    refSeries: [...published.refSeries, ...created('REF_SERIES').map((i) => ({ id: i.entityId, label: `${i.label} (in this update)`, kind: (i.after as RefSeriesData).kind }))],
    bandTables: [...published.bandTables, ...created('BAND_TABLE').map((i) => {
      const t = i.after as BandTableData;
      return { id: i.entityId, label: `${i.label} (in this update)`, refSeriesId: t.refSeriesId, bands: t.bands };
    })],
    schedules: [...published.schedules, ...created('SCHEDULE').map((i) => ({ id: i.entityId, label: `${i.label} (in this update)`, chargeType: (i.after as ScheduleData).chargeType }))],
    labels: set.references,
  };

  /** Runs an action; a refused submission still returns findings, so the set is reloaded either way. */
  async function act(action: () => Promise<ChangeSet>, done?: string) {
    setError(null);
    setNotice(null);
    try {
      setSet(await action());
      if (done) setNotice(done);
    } catch (e) {
      setError(e);
      await load();
    }
  }

  const checker = (action: string, body: unknown, done: string) =>
    act(async () => {
      let result: ChangeSet | null = null;
      await run(async () => { result = await changeSetAction(set.id, action, body); });
      if (action === 'approve' || action === 'reject') hubTrack(`change_set_${action === 'approve' ? 'approved' : 'rejected'}`, { kind: set.kind });
      return result!;
    }, done);

  async function saveEditor(after: EntityData) {
    if (!editor) return;
    const updated = await saveChangeItem(set!.id, {
      itemId: editor.itemId, entityType: editor.type, entityId: editor.entityId, operation: editor.operation, after,
    });
    setSet(updated);
    setEditor(null);
    setNotice('Saved to this rate update.');
  }

  const warnings = set.findings.filter((f) => f.severity === 'WARNING');

  return (
    <Page title={set.title} wide>
      <p>
        <Badge value={set.status} /> by {set.createdBy.name}
        {set.reviewedBy && <> · Checker {set.reviewedBy.name}</>}
        {set.versionNo && <> · published as data version v{set.versionNo}</>}
        {set.status === 'SCHEDULED' && set.effectiveAt && <> · publishes {new Date(set.effectiveAt).toLocaleString()}</>}
        {set.kind !== 'NORMAL' && <> · <Badge value={set.kind} /></>}
        {set.rolledBackByVersion && <> · <Badge value="ROLLED_BACK" title="Kept in history" /> by version v{set.rolledBackByVersion}</>}
      </p>
      {set.rollbackOfVersion && (
        <p style={{ fontSize: 14, background: 'var(--info)', padding: 8, borderRadius: 6 }}>
          Restores the data as it was before version v{set.rollbackOfVersion}: changed records get their earlier values back, records that version
          created are withdrawn (they stay in history). Another Checker must approve it.
        </p>
      )}
      {set.importJob && <p style={{ fontSize: 14 }}>Imported from <a href={`/imports/${set.importJob.id}`}>{set.importJob.fileName}</a>.</p>}
      <p style={{ fontSize: 14 }}><strong>Justification:</strong> {set.justification}</p>
      {set.decisionComment && set.status === 'REJECTED' && (
        <p style={{ background: 'var(--danger)', padding: 12, borderRadius: 6 }}><strong>Rejected:</strong> {set.decisionComment}</p>
      )}
      {notice && <p role="status" style={{ color: 'var(--ok-ink)' }}>{notice}</p>}
      <ErrorText error={error} />

      {set.findings.length > 0 && (
        <section aria-label="Validation findings" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 12, margin: '12px 0' }}>
          <h2 style={{ fontSize: 16, marginTop: 0 }}>Validation findings</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {set.findings.map((f) => (
              <li key={f.id} style={{ marginBottom: 4 }}>
                <Badge value={f.severity} /> <code style={{ fontSize: 12 }}>{f.ruleCode}</code> {f.message}
                {f.acknowledged && <span style={{ color: 'var(--muted)' }}> (acknowledged)</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <h2 style={{ fontSize: 18 }}>Changes ({set.items.length})</h2>
      {set.items.length === 0 && <p>No changes yet.</p>}
      {set.items.map((item) => (
        <ItemCard key={item.id} item={item} references={set.references} editable={editable}
          onEdit={() => setEditor({ type: item.entityType, operation: item.operation === 'WITHDRAW' ? 'UPDATE' : item.operation, initial: item.after, itemId: item.id, entityId: item.operation === 'CREATE' ? undefined : item.entityId })}
          onRemove={() => act(() => removeChangeItem(set.id, item.id), 'Change removed.')} />
      ))}

      {set.items.length > 0 && <ImpactTable setId={set.id} version={set.updatedAt} />}

      {editable && !editor && (
        <AddChange published={published} onStart={setEditor}
          onEndDate={(type, entityId, validTo) => act(() => saveChangeItem(set.id, { entityType: type, entityId, operation: 'END_DATE', validTo }), 'End date added.')} />
      )}
      {editor && (
        <EntityEditor key={editor.itemId ?? editor.entityId ?? editor.type} type={editor.type} initial={editor.initial} refs={refs}
          onSave={saveEditor} onCancel={() => setEditor(null)} />
      )}

      <section aria-label="Actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 24 }}>
        {editable && <SubmitButton hasWarnings={warnings.length > 0} onSubmit={(ack) => act(async () => { const r = await changeSetAction(set.id, 'submit', { acknowledgeWarnings: ack }); hubTrack('change_set_submitted', { kind: r.kind, items: r.items.length }); return r; }, 'Submitted for review.')} />}
        {editable && <button onClick={() => act(() => changeSetAction(set.id, 'discard'), 'Rate update discarded.')}>Discard</button>}
        {isOwner && set.kind !== 'ROLLBACK' && set.status === 'SUBMITTED' && <button onClick={() => act(() => changeSetAction(set.id, 'withdraw'), 'Withdrawn to draft.')}>Withdraw</button>}
        {canReview && set.status === 'SUBMITTED' && <button onClick={() => act(() => changeSetAction(set.id, 'start-review'), 'Review started.')}>Start review</button>}
        {canReview && set.status === 'IN_REVIEW' && (
          <Decision label="Approve" field="Effective date (WIB)" type="date" initial={today()}
            onConfirm={(v) => checker('approve', { effectiveDate: v }, v <= today() ? 'Approved and published.' : `Approved; scheduled for ${v}.`)} />
        )}
        {canReview && set.status === 'IN_REVIEW' && (
          <Decision label="Reject" field="Comment for the Maker" initial="" onConfirm={(v) => checker('reject', { comment: v }, 'Rejected and returned to the Maker.')} />
        )}
        {canReview && set.status === 'SCHEDULED' && (
          <Decision label="Cancel schedule" field="Reason" initial="" onConfirm={(v) => checker('cancel-schedule', { reason: v }, 'Schedule cancelled; the set is a draft again.')} />
        )}
        {perms.includes('changeset.approve') && set.status === 'PUBLISHED' && set.versionNo && !set.rolledBackByVersion && (
          <Decision label={`Roll back version v${set.versionNo}`} field="Reason" initial=""
            onConfirm={(reason) => act(async () => {
              let created: ChangeSet | null = null;
              await run(async () => { created = await rollbackVersion(set.versionNo!, reason); });
              window.history.pushState(null, '', `/change-sets/${created!.id}`);
              return created!;
            }, 'Rollback created; another Checker must review and approve it.')} />
        )}
        {isOwner && set.kind === 'ROLLBACK' && ['DRAFT', 'SUBMITTED', 'REJECTED'].includes(set.status) && (
          <button onClick={() => act(() => changeSetAction(set.id, 'cancel-rollback'), 'Rollback cancelled.')}>Cancel rollback</button>
        )}
        {perms.includes('changeset.approve') && isEditor && ['SUBMITTED', 'IN_REVIEW'].includes(set.status) && (
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>You created or edited this update, so a different Checker must review it.</p>
        )}
      </section>
      {dialog}
    </Page>
  );
}

function SubmitButton({ hasWarnings, onSubmit }: { hasWarnings: boolean; onSubmit: (acknowledge: boolean) => void }) {
  const [ack, setAck] = useState(false);
  return (
    <>
      {hasWarnings && (
        <label style={{ fontSize: 13 }}>
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have reviewed the warnings
        </label>
      )}
      <button onClick={() => onSubmit(ack)}>Submit for review</button>
    </>
  );
}

/** A Checker decision with one input (effective date, comment or reason) before it is sent. */
function Decision({ label, field, initial, type = 'text', onConfirm }: {
  label: string; field: string; initial: string; type?: string; onConfirm: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(initial);
  if (!open) return <button onClick={() => setOpen(true)}>{label}</button>;
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'end', border: '1px solid var(--line)', padding: 8, borderRadius: 6 }}>
      <label style={{ fontSize: 13 }}>{field}<input type={type} value={value} onChange={(e) => setValue(e.target.value)} style={{ display: 'block', width: type === 'date' ? undefined : 320 }} /></label>
      <button onClick={() => onConfirm(value)}>{label}</button>
      <button onClick={() => setOpen(false)}>Cancel</button>
    </span>
  );
}

function AddChange({ published, onStart, onEndDate }: {
  published: Published;
  onStart: (e: EditorState) => void;
  onEndDate: (type: EntityType, entityId: string, validTo: string) => void;
}) {
  const [type, setType] = useState<EntityType>('PRODUCT');
  const [entityId, setEntityId] = useState('');
  const [validTo, setValidTo] = useState('');
  const [error, setError] = useState<unknown>(null);
  const records: Option[] = {
    REGULATION: published.regulations, COMMODITY: published.commodities, PRODUCT_GROUP: published.groups, PRODUCT: published.products,
    REF_SERIES: published.refSeries, REF_VALUE: published.values, BAND_TABLE: published.bandTables, SCHEDULE: published.schedules, SCHEDULE_LINE: published.lines,
  }[type];

  async function edit() {
    setError(null);
    try {
      let current: EntityData;
      if (type === 'REGULATION') current = await getRegulation(entityId);
      else if (type === 'PRODUCT') current = await getProduct(entityId);
      else {
        const found = published.records[entityId];
        if (!found) throw new Error('Record not found.');
        current = found as EntityData;
      }
      // Keep only the editable fields of the API shape.
      const after = Object.fromEntries(Object.keys(EMPTY[type]).map((k) => [k, (current as unknown as Record<string, unknown>)[k]])) as unknown as EntityData;
      onStart({ type, operation: 'UPDATE', initial: after, entityId });
    } catch (e) {
      setError(e);
    }
  }

  return (
    <section aria-label="Add a change" style={{ background: 'var(--subtle)', borderRadius: 8, padding: 12, marginTop: 16 }}>
      <strong style={{ fontSize: 14 }}>Add a new record:</strong>{' '}
      {(Object.keys(TYPE_LABEL) as EntityType[]).map((t) => (
        <button key={t} style={{ marginRight: 6 }} onClick={() => onStart({ type: t, operation: 'CREATE', initial: EMPTY[t] })}>{TYPE_LABEL[t]}</button>
      ))}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'end', marginTop: 12 }}>
        <strong style={{ fontSize: 14 }}>…or change a published record:</strong>
        <select aria-label="Record type" value={type} onChange={(e) => { setType(e.target.value as EntityType); setEntityId(''); }}>
          {(Object.keys(TYPE_LABEL) as EntityType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
        <select aria-label="Record" value={entityId} onChange={(e) => setEntityId(e.target.value)} style={{ maxWidth: 360 }}>
          <option value="">—</option>
          {records.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <button disabled={!entityId} onClick={edit}>Edit</button>
        <label style={{ fontSize: 13 }}>Last valid day<input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} style={{ display: 'block' }} /></label>
        <button disabled={!entityId || !validTo} onClick={() => onEndDate(type, entityId, validTo)}>End-date</button>
      </div>
      <ErrorText error={error} />
    </section>
  );
}

// ---------------------------------------------------------------- diff

function ItemCard({ item, references, editable, onEdit, onRemove }: {
  item: ChangeItem; references: Record<string, string>; editable: boolean; onEdit: () => void; onRemove: () => void;
}) {
  return (
    <article style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Badge value={item.operation} /> <span style={{ color: 'var(--muted)', fontSize: 13 }}>{TYPE_LABEL[item.entityType]}</span>
        <strong>{item.label}</strong>
        {editable && (
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {item.operation !== 'END_DATE' && <button onClick={onEdit}>Edit</button>}
            <button onClick={onRemove}>Remove</button>
          </span>
        )}
      </div>
      {item.itemComment && <p style={{ background: 'var(--danger)', padding: 8, borderRadius: 6, fontSize: 14 }}>Checker: {item.itemComment}</p>}
      {item.importRow && <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0' }}>From {item.importRow}</p>}
      {item.operation === 'WITHDRAW' && (
        <p style={{ fontSize: 14, margin: '6px 0' }}>Withdrawn: removed from the current data by the rollback; earlier versions keep it.</p>
      )}
      <TableWrap><table style={{ ...tableStyle, marginTop: 8 }}>
        <thead><tr style={headStyle}><th style={{ width: '20%' }}>Field</th>{item.before && <th style={{ width: '40%' }}>Published</th>}<th>Proposed</th></tr></thead>
        <tbody>
          {item.changes.map((c) => (
            <tr key={c.field} style={rowStyle}>
              <td><code style={{ fontSize: 12 }}>{c.field}</code></td>
              {item.before && <td style={{ background: 'var(--danger)' }}>{show(c.field, c.before, references)}</td>}
              <td style={{ background: 'var(--ok)' }}>{show(c.field, c.after, references)}</td>
            </tr>
          ))}
        </tbody>
      </table></TableWrap>
    </article>
  );
}

/** Human-readable value for the diff, with references shown by name. */
function show(field: string, value: unknown, refs: Record<string, string>): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (field.endsWith('Id')) return refs[value as string] ?? String(value);
  if (!Array.isArray(value)) return String(value);
  if (!value.length) return '—';
  if (field === 'bandValues') return (value as string[]).join(' | ');
  return (value as unknown[]).map((v) => {
    if (field === 'productIds') return refs[v as string] ?? String(v);
    if (typeof v !== 'object' || v === null) return String(v);
    const o = v as Record<string, unknown>;
    if (field === 'relations') return `${o.relation} ${refs[o.regulationId as string] ?? o.regulationId}`;
    if (field === 'documents') return `${o.role}: ${refs[o.sourceDocumentId as string] ?? o.sourceDocumentId}`;
    if (field === 'hsCodes') return `${o.isEx ? 'ex ' : ''}${o.code}${o.exDescription ? ` (${o.exDescription})` : ''}`;
    if (field === 'bands') return String(o.label);
    if (field === 'parameters') return `${o.name} ${o.operator === 'TEXT' ? '' : o.operator + ' '}${o.valueText}${o.unit ? ' ' + o.unit : ''}${o.isPrimary ? ' [key spec]' : ''}`;
    return JSON.stringify(o);
  }).join('; ');
}

// ---------------------------------------------------------------- impact preview

/** Duty and levy per tonne today, published vs. with this change set (PRD US-25-P1 AC2, US-29-P2 AC1). */
function ImpactTable({ setId, version }: { setId: string; version: string }) {
  const [impact, setImpact] = useState<{ date: string; rows: ImpactRow[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    getImpact(setId).then(setImpact).catch(setError);
  }, [setId, version]);
  if (error) return <ErrorText error={error} />;
  if (!impact || !impact.rows.length) return null;
  return (
    <section aria-label="Impact preview" style={{ margin: '16px 0' }}>
      <h2 style={{ fontSize: 18 }}>Impact on charges ({impact.date}, USD per MT)</h2>
      <TableWrap><table style={tableStyle}>
        <thead><tr style={headStyle}><th>Product</th><th>Export duty (BK)</th><th>Export levy (PE)</th></tr></thead>
        <tbody>
          {impact.rows.map((r) => (
            <tr key={r.productId} style={{ ...rowStyle, background: r.changed ? 'var(--warn)' : undefined }}>
              <td>{r.product}</td>
              <td><ChargeChange before={r.bk.before} after={r.bk.after} /></td>
              <td><ChargeChange before={r.pe.before} after={r.pe.after} /></td>
            </tr>
          ))}
        </tbody>
      </table></TableWrap>
    </section>
  );
}

/** One charge in words: amount with band or rate, "Listed at 0", "Not listed", or why it cannot be computed. */
export function chargeText(c: Charge): string {
  if (c.status === 'NOT_LISTED') return 'None';
  if (c.status === 'LISTED_ZERO') return 'Zero (listed)';
  if (c.status === 'MISSING_VALUE' || c.status === 'DATA_ERROR') return c.message ?? c.status;
  const how = c.band ? ` (band ${c.band.label})` : c.rate ? ` (${c.rate} %)` : '';
  return `${formatDecimal(c.usdPerMt)}${how}`;
}

export function ChargeChange({ before, after }: { before: Charge; after: Charge }) {
  const same = before.status === after.status && before.usdPerMt === after.usdPerMt;
  if (same) return <span style={{ color: 'var(--muted)' }}>{chargeText(after)}</span>;
  return <span><s style={{ color: 'var(--danger-ink)' }}>{chargeText(before)}</s> → <strong style={{ color: 'var(--ok-ink)' }}>{chargeText(after)}</strong></span>;
}
