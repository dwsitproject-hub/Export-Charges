import { useEffect, useState, type FormEvent } from 'react';
import { ALL_ROLES, ApiFailure, listUsers, Me, setUserRoles, userAction, UserSummary } from '../api';
import { ErrorText, Page, useStepUp, TableWrap } from '../ui';

type Action = 'deactivate' | 'reactivate' | 'reset-totp' | 'revoke-sessions';

/** User and role administration (PRD F-10). DWS Hub owns invitations; ECR owns roles and account status. */
export function AdminUsers({ me }: { me: Me }) {
  // Opened from an access review with ?q=<email>.
  const [query, setQuery] = useState(() => new URLSearchParams(window.location.search).get('q') ?? '');
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [selected, setSelected] = useState<UserSummary | null>(null);
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

  return (
    <Page title="Users" intro="Give people the right role. Everyone signs in with DWS Hub and starts as a Viewer, who can look things up.">
      <form onSubmit={(e) => { e.preventDefault(); void load(); }} style={{ marginBottom: 16 }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or email" aria-label="Search users" />{' '}
        <button type="submit">Search</button>
      </form>
      <ErrorText error={error} />
      {users && (
        <TableWrap><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
              <th>Name</th><th>Status</th><th>Roles</th><th>Authenticator</th><th>Last sign-in</th><th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ borderBottom: '1px solid var(--line)', verticalAlign: 'top', background: selected?.id === u.id ? 'var(--accent-soft)' : undefined }}>
                <td>{u.fullName}<br /><span style={{ color: 'var(--muted)' }}>{u.email}</span></td>
                <td>{u.status}</td>
                <td>{u.roles.join(', ') || '—'}</td>
                <td>{u.totpEnrolled ? 'Set up' : '—'}</td>
                <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}</td>
                <td>{u.id === me.user.id ? <em>you</em> : <button onClick={() => setSelected(u)}>Manage</button>}</td>
              </tr>
            ))}
          </tbody>
        </table></TableWrap>
      )}
      {selected && <ManagePanel key={selected.id} user={selected} onChanged={() => load()} onClose={() => setSelected(null)} />}
    </Page>
  );
}

function ManagePanel({ user, onChanged, onClose }: { user: UserSummary; onChanged: () => Promise<void>; onClose: () => void }) {
  const [roles, setRoles] = useState<string[]>(user.roles);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { run, dialog } = useStepUp();

  async function perform(label: string, action: () => Promise<unknown>) {
    if (reason.trim().length < 3) {
      setError(new Error('Enter a reason of at least 3 characters.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await run(() => action().then(() => undefined));
      setNotice(`${label}.`);
      setReason('');
      await onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const saveRoles = (e: FormEvent) => {
    e.preventDefault();
    void perform('Roles updated', () => setUserRoles(user.id, roles, reason));
  };
  const act = (label: string, action: Action) => perform(label, () => userAction(user.id, action, reason));

  return (
    <section aria-label={`Manage ${user.fullName}`} style={{ marginTop: 24, padding: 16, border: '1px solid var(--line)', borderRadius: 8 }}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>{user.fullName}</h2>
      <form onSubmit={saveRoles}>
        <fieldset style={{ border: 'none', background: 'none', padding: 0 }}>
          <legend>Roles</legend>
          {ALL_ROLES.map((r) => (
            <label key={r} style={{ marginRight: 16, whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={roles.includes(r)}
                onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))} /> {r}
            </label>
          ))}
        </fieldset>
        <label style={{ display: 'block', marginTop: 12 }}>
          Reason (required, recorded in the audit log)
          <input value={reason} onChange={(e) => setReason(e.target.value)} style={{ display: 'block', width: '100%' }} />
        </label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          <button type="submit" disabled={busy}>Save roles</button>
          {user.status === 'ACTIVE'
            ? <button type="button" disabled={busy} onClick={() => act('Account deactivated', 'deactivate')}>Deactivate</button>
            : <button type="button" disabled={busy} onClick={() => act('Account reactivated', 'reactivate')}>Reactivate</button>}
          {user.totpEnrolled && <button type="button" disabled={busy} onClick={() => act('Authenticator reset', 'reset-totp')}>Reset authenticator</button>}
          {user.liveSessions > 0 && <button type="button" disabled={busy} onClick={() => act('Sessions ended', 'revoke-sessions')}>End sessions</button>}
          <button type="button" onClick={onClose} style={{ marginLeft: 'auto' }}>Close</button>
        </div>
      </form>
      {notice && <p role="status" style={{ color: 'var(--ok-ink)' }}>{notice}</p>}
      <ErrorText error={error} />
      {dialog}
    </section>
  );
}
