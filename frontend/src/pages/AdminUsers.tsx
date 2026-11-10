import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ALL_ROLES, ApiFailure, createUser, deleteUser, listUsers, Me, setUserRoles, updateUser, userAction, UserSummary } from '../api';
import { ErrorText, Page, roleName, TableWrap, useStepUp } from '../ui';

type Action = 'deactivate' | 'reactivate' | 'reset-totp' | 'revoke-sessions';

const ROLE_HINTS: Record<string, string> = {
  VIEWER: 'Looks things up and calculates',
  MAKER: 'Enters rate and regulation updates',
  CHECKER: 'Reviews and approves updates',
  USER_ADMIN: 'Manages users (not administrators)',
  AUDITOR: 'Reads the audit log',
  SUPER_ADMIN: 'Everything, including administrators',
};

const STATUS: Record<string, { label: string; tone: string }> = {
  ACTIVE: { label: 'Active', tone: 'ok' },
  INVITED: { label: 'Invited · not signed in yet', tone: 'violet' },
  DEACTIVATED: { label: 'Deactivated', tone: 'warn' },
  DORMANT_DISABLED: { label: 'Disabled (inactive 90 days)', tone: 'warn' },
  EXPIRED: { label: 'Access expired', tone: 'warn' },
  LOCKED: { label: 'Locked', tone: 'warn' },
};

/**
 * Users (PRD F-10). Administrators add people before their first sign-in (the account waits as Invited until the
 * person signs in with DWS Hub using that email), edit their details and roles, deactivate, reset an authenticator,
 * end sessions, and delete accounts. Every change needs a reason and a fresh authenticator code, and is audited.
 */
export function AdminUsers({ me }: { me: Me }) {
  // Opened from an access review with ?q=<email>.
  const [query, setQuery] = useState(() => new URLSearchParams(window.location.search).get('q') ?? '');
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [selected, setSelected] = useState<UserSummary | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function load(q = query) {
    try {
      const list = await listUsers(q);
      setUsers(list);
      setSelected((s) => (s ? list.find((u) => u.id === s.id) ?? null : null));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (!me.user.permissions.includes('user.manage')) {
    return <Page title="Users"><p>You don't have access to user administration.</p></Page>;
  }
  if (error instanceof ApiFailure && error.code === 'TOTP_ENROLLMENT_REQUIRED') {
    return (
      <Page title="Users">
        <p>Set up your authenticator app before using user administration.</p>
        <a href="/settings/authenticator">Set up authenticator</a>
      </Page>
    );
  }
  const superAdmin = me.user.permissions.includes('user.invite_admin');

  return (
    <Page
      title="Users"
      actions={<button type="button" className="primary" onClick={() => { setAdding(true); setSelected(null); setNotice(null); }}>Add user</button>}
      intro={`Add people before they first sign in, give them the right role, and keep the list up to date. Everyone signs in with DWS Hub; someone who signs in without being added starts as a Viewer. Every change needs a reason${me.totp.enabled ? ' and an authenticator code' : ''}.`}
    >
      {notice && <p className="callout ok" role="status">{notice}</p>}
      {adding && (
        <AddPanel
          superAdmin={superAdmin}
          onAdded={async (u) => { setAdding(false); setNotice(`${u.fullName} was added as ${u.roles.map(roleName).join(', ')}. They can now sign in with DWS Hub using ${u.email}.`); await load(); }}
          onClose={() => setAdding(false)}
        />
      )}
      <form className="form-row" role="search" onSubmit={(e) => { e.preventDefault(); void load(); }} style={{ marginBottom: 16 }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or email" aria-label="Search users" style={{ flex: '1 1 260px' }} />
        <button type="submit">Search</button>
      </form>
      <ErrorText error={error} />
      {users && (
        <TableWrap><table className="users-table">
          <thead>
            <tr><th>Name</th><th>Status</th><th>Roles</th>{me.totp.enabled && <th>Authenticator</th>}<th>Last sign-in</th><th /></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={selected?.id === u.id ? 'selected' : undefined}>
                <td><strong>{u.fullName}</strong><br /><span className="muted">{u.email}</span>{u.department && <><br /><span className="muted small">{u.department}</span></>}</td>
                <td><StatusTag status={u.status} /></td>
                <td>{u.roles.map(roleName).join(', ') || '—'}</td>
                {me.totp.enabled && <td>{u.totpEnrolled ? 'Set up' : '—'}</td>}
                <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}</td>
                <td>{u.id === me.user.id ? <em>you</em> : <button type="button" onClick={() => { setSelected(u); setAdding(false); setNotice(null); }}>Manage</button>}</td>
              </tr>
            ))}
            {!users.length && <tr><td colSpan={me.totp.enabled ? 6 : 5} className="muted">No user matches.</td></tr>}
          </tbody>
        </table></TableWrap>
      )}
      {selected && (
        <ManagePanel
          key={selected.id}
          user={selected}
          superAdmin={superAdmin}
          totpEnabled={me.totp.enabled}
          onChanged={() => load()}
          onDeleted={async (name, result) => {
            setSelected(null);
            setNotice(result === 'REMOVED'
              ? `${name} was deleted.`
              : `${name} was deleted. Their past actions stay in the audit trail under "Deleted user"; they can be added again.`);
            await load();
          }}
          onClose={() => setSelected(null)}
        />
      )}
    </Page>
  );
}

function StatusTag({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: '' };
  return <span className={`tag ${s.tone}`}>{s.label}</span>;
}

function RolePicker({ roles, onChange, superAdmin }: { roles: string[]; onChange: (r: string[]) => void; superAdmin: boolean }) {
  return (
    <fieldset className="role-picker">
      <legend>Roles</legend>
      {ALL_ROLES.map((r) => {
        const adminOnly = (r === 'SUPER_ADMIN' || r === 'USER_ADMIN') && !superAdmin;
        return (
          <label key={r} className={adminOnly ? 'disabled' : undefined} title={adminOnly ? 'Only a Super Admin gives administrator roles' : undefined}>
            <input type="checkbox" checked={roles.includes(r)} disabled={adminOnly}
              onChange={(e) => onChange(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))} />
            <span><strong>{roleName(r)}</strong><small>{ROLE_HINTS[r]}</small></span>
          </label>
        );
      })}
    </fieldset>
  );
}

function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <section className="panel user-panel" aria-label={title}>
      <div className="panel-head">
        <h2>{title}</h2>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      {children}
    </section>
  );
}

function AddPanel({ superAdmin, onAdded, onClose }: { superAdmin: boolean; onAdded: (u: UserSummary) => Promise<void>; onClose: () => void }) {
  const [form, setForm] = useState({ email: '', fullName: '', department: '', reason: '' });
  const [roles, setRoles] = useState<string[]>(['VIEWER']);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const { run, dialog } = useStepUp();
  const field = (k: keyof typeof form) => ({ value: form[k], onChange: (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value }) });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let added: UserSummary | null = null;
      await run(async () => { added = await createUser({ ...form, roles }); });
      if (added) await onAdded(added);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Add a user" onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>Use the email they sign in to DWS Hub with. Until their first sign-in they show as Invited.</p>
      <form onSubmit={submit}>
        <div className="user-fields">
          <label className="field-stack">Email<input type="email" required autoComplete="off" {...field('email')} /></label>
          <label className="field-stack">Full name<input required {...field('fullName')} /></label>
          <label className="field-stack">Department <span className="help">(optional)</span><input {...field('department')} /></label>
        </div>
        <RolePicker roles={roles} onChange={setRoles} superAdmin={superAdmin} />
        <label className="field-stack">Reason <span className="help">(recorded in the audit log)</span><input required minLength={3} {...field('reason')} placeholder="e.g. New Checker for the palm team" /></label>
        <ErrorText error={error} />
        <div className="actions"><button type="submit" className="primary" disabled={busy}>Add user</button></div>
      </form>
      {dialog}
    </Panel>
  );
}

function ManagePanel({ user, superAdmin, totpEnabled, onChanged, onDeleted, onClose }: {
  user: UserSummary; superAdmin: boolean; totpEnabled: boolean; onChanged: () => Promise<void>; onDeleted: (name: string, result: 'REMOVED' | 'ANONYMISED') => Promise<void>; onClose: () => void;
}) {
  const [details, setDetails] = useState({ fullName: user.fullName, department: user.department ?? '', email: user.email });
  const [roles, setRoles] = useState<string[]>(user.roles);
  const [reason, setReason] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { run, dialog } = useStepUp();
  const invited = user.status === 'INVITED';

  async function perform(label: string, action: () => Promise<unknown>, after: () => Promise<void> = onChanged) {
    if (reason.trim().length < 3) {
      setError(new Error('Enter a reason of at least 3 characters first.'));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await run(() => action().then(() => undefined));
      setNotice(`${label}.`);
      setReason('');
      await after();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const saveDetails = (e: FormEvent) => {
    e.preventDefault();
    void perform('Details saved', () => updateUser(user.id, { fullName: details.fullName, department: details.department, ...(invited ? { email: details.email } : {}), reason }));
  };
  const saveRoles = (e: FormEvent) => {
    e.preventDefault();
    void perform('Roles updated', () => setUserRoles(user.id, roles, reason));
  };
  const act = (label: string, action: Action) => perform(label, () => userAction(user.id, action, reason));
  const remove = () => {
    let result: 'REMOVED' | 'ANONYMISED' = 'REMOVED';
    void perform('User deleted', async () => { result = (await deleteUser(user.id, reason)).result; }, () => onDeleted(user.fullName, result));
  };

  return (
    <Panel title={`Manage ${user.fullName}`} onClose={onClose}>
      <p style={{ marginTop: 0 }}><StatusTag status={user.status} /></p>
      <label className="field-stack reason">
        <span>Reason for the change <span className="help">(required, recorded in the audit log)</span></span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Moved to the trade team" />
      </label>
      {notice && <p role="status" className="callout ok">{notice}</p>}
      <ErrorText error={error} />

      <form onSubmit={saveDetails} className="user-section">
        <h3>Details</h3>
        <div className="user-fields">
          <label className="field-stack">Full name<input required value={details.fullName} onChange={(e) => setDetails({ ...details, fullName: e.target.value })} /></label>
          <label className="field-stack">Department<input value={details.department} onChange={(e) => setDetails({ ...details, department: e.target.value })} /></label>
          <label className="field-stack">
            <span>Email {!invited && <span className="help">(from DWS Hub)</span>}</span>
            <input type="email" required value={details.email} readOnly={!invited} onChange={(e) => setDetails({ ...details, email: e.target.value })} />
          </label>
        </div>
        {!invited && <p className="small muted">The name and email come from DWS Hub at each sign-in; the department stays as set here.</p>}
        <div className="actions"><button type="submit" disabled={busy}>Save details</button></div>
      </form>

      <form onSubmit={saveRoles} className="user-section">
        <h3>Roles</h3>
        <RolePicker roles={roles} onChange={setRoles} superAdmin={superAdmin} />
        <div className="actions"><button type="submit" disabled={busy}>Save roles</button></div>
      </form>

      <div className="user-section">
        <h3>Account</h3>
        <div className="actions">
          {user.status === 'INVITED' ? null : user.status === 'ACTIVE'
            ? <button type="button" disabled={busy} onClick={() => act('Account deactivated', 'deactivate')}>Deactivate</button>
            : <button type="button" disabled={busy} onClick={() => act('Account reactivated', 'reactivate')}>Reactivate</button>}
          {totpEnabled && user.totpEnrolled && <button type="button" disabled={busy} onClick={() => act('Authenticator reset', 'reset-totp')}>Reset authenticator</button>}
          {user.liveSessions > 0 && <button type="button" disabled={busy} onClick={() => act('Sessions ended', 'revoke-sessions')}>End sessions ({user.liveSessions})</button>}
          {!confirmDelete && <button type="button" className="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>Delete user…</button>}
        </div>
        {confirmDelete && (
          <div className="callout danger" role="alert">
            <p style={{ marginTop: 0 }}>
              <strong>Delete {user.fullName}?</strong>{' '}
              {invited
                ? 'They have never signed in, so the account is removed completely.'
                : 'Their roles, sessions, authenticator and follows are removed and they can no longer sign in. Their name and email are erased; what they did stays in the audit trail as "Deleted user". This cannot be undone, but they can be added again.'}
            </p>
            <div className="actions">
              <button type="button" className="danger" disabled={busy} onClick={remove}>Yes, delete</button>
              <button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
      {dialog}
    </Panel>
  );
}
