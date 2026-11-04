import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiFailure, Me } from '../api';
import { ErrorText, Page, useStepUp } from '../ui';

type Value = number | string | string[];

interface Setting {
  key: string;
  group: string;
  label: string;
  help: string;
  kind: 'integer' | 'roles' | 'networks' | 'text';
  unit?: string;
  min: number;
  max: number;
  value: Value;
  default: Value;
  overridden: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  options?: { code: string; name: string; privileged: boolean }[];
}

interface Config {
  settings: Setting[];
  fixed: { label: string; value: string; note: string }[];
}

/** What the form edits: the text of each field, or "reset" to restore the default. */
type Draft = Record<string, string | string[] | 'RESET'>;

const toDraft = (s: Setting): string | string[] =>
  s.kind === 'roles' ? [...(s.value as string[])] : s.kind === 'networks' ? (s.value as string[]).join('\n') : String(s.value);
const shown = (s: Setting, v: Value) =>
  s.kind === 'roles' ? ((v as string[]).join(', ') || 'none') : s.kind === 'networks' ? (v as string[]).join(', ') : s.unit ? `${v} ${s.unit}` : String(v);

/** PRD F-52: bounded settings a Super Admin changes with an authenticator code; each save is audited. */
export function ConfigurationPage({ me }: { me: Me }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { run, dialog } = useStepUp();

  const load = (c: Config) => {
    setConfig(c);
    setDraft(Object.fromEntries(c.settings.map((s) => [s.key, toDraft(s)])));
  };
  useEffect(() => {
    if (me.user.permissions.includes('config.manage')) api<Config>('/admin/config').then(load).catch(setError);
  }, []);

  if (!me.user.permissions.includes('config.manage')) {
    return <Page title="Configuration"><p>Only Super Admins can change the configuration.</p></Page>;
  }
  if (!config) return <Page title="Configuration">{error ? <ErrorText error={error} /> : 'Loading…'}</Page>;

  const fieldErrors = error instanceof ApiFailure && Array.isArray(error.details?.fields)
    ? Object.fromEntries((error.details.fields as { field: string; message: string }[]).map((f) => [f.field, f.message]))
    : {};
  const changed = config.settings.filter((s) => {
    const d = draft[s.key];
    return d === 'RESET' ? s.overridden : JSON.stringify(d) !== JSON.stringify(toDraft(s));
  });

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const values = Object.fromEntries(changed.map((s) => {
      const d = draft[s.key];
      return [s.key, d === 'RESET' ? null : s.kind === 'integer' ? Number(d) : d];
    }));
    try {
      await run(async () => {
        const res = await api<Config & { changed: string[] }>('/admin/config', { method: 'PUT', body: { values, reason } });
        load(res);
        setReason('');
        setNotice(res.changed.length ? `Saved: ${res.changed.length} setting${res.changed.length === 1 ? '' : 's'} changed. Open sessions use the new limits from their next request.` : 'Nothing changed.');
      });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const groups = [...new Set(config.settings.map((s) => s.group))];
  return (
    <Page title="Settings" wide intro="System settings. Changes apply immediately, for everyone, and need your authenticator code and a reason.">
      <form onSubmit={save}>
        {groups.map((g) => (
          <fieldset key={g} style={{ border: '1px solid var(--line)', borderRadius: 6, margin: '0 0 16px', padding: '8px 16px 12px' }}>
            <legend style={{ fontWeight: 600, padding: '0 4px' }}>{g}</legend>
            {config.settings.filter((s) => s.group === g).map((s) => {
              const d = draft[s.key];
              const reset = d === 'RESET';
              const id = `cfg-${s.key}`;
              return (
                <div key={s.key} style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: '10px 0', borderTop: '1px solid var(--line)' }}>
                  <div style={{ flex: '0 0 260px', maxWidth: '100%' }}>
                    <label htmlFor={id} style={{ fontWeight: 500 }}>{s.label}</label>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {s.overridden ? <>Changed by {s.updatedBy}, {new Date(s.updatedAt!).toLocaleString()}</> : 'Default from the deployment'}
                    </div>
                  </div>
                  <div style={{ flex: '1 1 280px', minWidth: 0 }}>
                    {reset ? (
                      <div style={{ fontSize: 14 }}>Will return to the default: <strong>{shown(s, s.default)}</strong></div>
                    ) : s.kind === 'integer' ? (
                      <span><input id={id} type="number" min={s.min} max={s.max} step={1} value={d as string} style={{ width: 90 }}
                        onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })} /> {s.unit} <span style={{ fontSize: 12, color: 'var(--muted)' }}>({s.min}–{s.max})</span></span>
                    ) : s.kind === 'roles' ? (
                      <span id={id} role="group" aria-label={s.label} style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                        {s.options!.map((o) => (
                          <label key={o.code} title={o.privileged ? 'Privileged roles cannot be given at first sign-in' : undefined} style={{ color: o.privileged ? 'var(--muted)' : undefined }}>
                            <input type="checkbox" disabled={o.privileged} checked={(d as string[]).includes(o.code)}
                              onChange={(e) => setDraft({ ...draft, [s.key]: e.target.checked ? [...(d as string[]), o.code] : (d as string[]).filter((x) => x !== o.code) })} /> {o.name}
                          </label>
                        ))}
                      </span>
                    ) : (
                      <textarea id={id} rows={s.kind === 'networks' ? 4 : 3} value={d as string} style={{ width: '100%', fontFamily: s.kind === 'networks' ? 'ui-monospace, monospace' : undefined }}
                        onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })} />
                    )}
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>{s.help}</div>
                    {fieldErrors[s.key] && <div role="alert" style={{ fontSize: 13, color: 'var(--danger-ink)' }}>{fieldErrors[s.key]}</div>}
                    {s.overridden && !reset && (
                      <button type="button" style={{ fontSize: 12, marginTop: 4 }} onClick={() => setDraft({ ...draft, [s.key]: 'RESET' })}>
                        Restore default ({shown(s, s.default)})
                      </button>
                    )}
                    {reset && <button type="button" style={{ fontSize: 12, marginTop: 4 }} onClick={() => setDraft({ ...draft, [s.key]: toDraft(s) })}>Keep the current value</button>}
                  </div>
                </div>
              );
            })}
          </fieldset>
        ))}
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ flex: '1 1 320px' }}>
            Reason for the change
            <input value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: '100%' }} placeholder="e.g. IT security policy 2026-11" />
          </label>
          <button type="submit" disabled={busy || changed.length === 0 || reason.trim().length < 3}>
            {busy ? 'Saving…' : changed.length ? `Save ${changed.length} change${changed.length === 1 ? '' : 's'}` : 'Save'}
          </button>
        </div>
        {fieldErrors.reason && <div role="alert" style={{ fontSize: 13, color: 'var(--danger-ink)' }}>{fieldErrors.reason}</div>}
        {error && !Object.keys(fieldErrors).length ? <ErrorText error={error} /> : null}
        {notice && <p role="status" style={{ color: 'var(--ok-ink)' }}>{notice}</p>}
      </form>

      <h2 style={{ fontSize: 18, marginTop: 32 }}>Set by the deployment</h2>
      <p style={{ fontSize: 14 }}>These need a change to the server's environment (secrets or addresses registered at DWS Hub), or are fixed by policy.</p>
      <dl style={{ display: 'grid', gridTemplateColumns: '160px minmax(0, 1fr)', gap: '6px 12px', fontSize: 14 }}>
        {config.fixed.map((f) => (
          <div key={f.label} style={{ display: 'contents' }}>
            <dt>{f.label}</dt>
            <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{f.value} <span style={{ fontSize: 12, color: 'var(--muted)' }}>· {f.note}</span></dd>
          </div>
        ))}
      </dl>
      {dialog}
    </Page>
  );
}
