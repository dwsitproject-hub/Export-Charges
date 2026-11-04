import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiFailure, logout, Me, stepUp, unreadNotifications } from './api';
import { hubReset } from './hubSdk';

/** The signed-in person, set once by App; the shell reads it to show only the pages they may use. */
export const MeContext = createContext<Me | null>(null);

interface NavItem { href: string; label: string; hint?: string; perm?: string; also?: string[] }

/** The everyday tasks, always in view as tabs; `also` lists pages that belong to a tab. */
const TABS: NavItem[] = [
  { href: '/', label: 'Home' },
  { href: '/find', label: 'Find a product', perm: 'catalogue.read', also: ['/products'] },
  { href: '/calculator', label: 'Calculate a shipment', perm: 'calc.run', also: ['/calculations'] },
  { href: '/updates', label: 'What changed', perm: 'catalogue.read', also: ['/bulletins'] },
];

/** "More tools": everything else, grouped; an item shows when the person holds its permission (the API enforces it either way). */
const MORE: { title: string; items: NavItem[] }[] = [
  {
    title: 'Look things up',
    items: [
      { href: '/catalogue', label: 'Full product table', hint: 'Every product, with filters and download', perm: 'catalogue.read' },
      { href: '/calculations', label: 'Saved calculations', perm: 'calc.run' },
      { href: '/regulations', label: 'Regulations', hint: 'The decrees behind the rates', perm: 'catalogue.read' },
      { href: '/products', label: 'Product list', perm: 'catalogue.read' },
      { href: '/schedules', label: 'Rate tables', hint: 'Duty and levy by price band', perm: 'catalogue.read' },
      { href: '/prices', label: 'Reference prices', perm: 'catalogue.read' },
      { href: '/sources', label: 'Official documents', perm: 'catalogue.read' },
      { href: '/exports', label: 'My downloads', perm: 'export.run' },
    ],
  },
  {
    title: 'Update the data',
    items: [
      { href: '/change-sets', label: 'Rate updates', hint: 'Enter, review and approve changes', perm: 'changeset.read' },
      { href: '/imports', label: 'Import a file', perm: 'import.run' },
      { href: '/data-quality', label: 'Data checks', perm: 'dq.read' },
      { href: '/source-watch', label: 'New regulation watch', perm: 'changeset.read' },
    ],
  },
  {
    title: 'Administration',
    items: [
      { href: '/admin/users', label: 'Users', perm: 'user.manage' },
      { href: '/admin/reviews', label: 'Access reviews', perm: 'accessreview.read' },
      { href: '/admin/audit', label: 'Audit log', perm: 'audit.read' },
      { href: '/admin/jobs', label: 'Background jobs', perm: 'audit.read' },
      { href: '/admin/config', label: 'Settings', perm: 'config.manage' },
    ],
  },
];

/** Closes an open <details> menu on a click outside it or on Escape. */
function useCloseOnOutside(ref: { current: HTMLDetailsElement | null }) {
  useEffect(() => {
    const close = (e: Event) => {
      const el = ref.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !el.contains(e.target as Node)) el.open = false;
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', close);
    };
  }, []);
}

const ROLE_NAMES: Record<string, string> = {
  VIEWER: 'Viewer', MAKER: 'Maker', CHECKER: 'Checker', USER_ADMIN: 'User Admin', AUDITOR: 'Auditor', SUPER_ADMIN: 'Super Admin',
};
export const roleName = (code: string) => ROLE_NAMES[code] ?? code.replace(/_/g, ' ');

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

function Brand({ short = false }: { short?: boolean }) {
  return (
    <a className="brand" href="/">
      <img className="brand-mark" src="/icon.svg" alt="" width="40" height="40" />
      {!short && <span className="brand-name">Export Charges<small>Duty &amp; levy, made simple</small></span>}
      {short && <span className="brand-name">ECR</span>}
    </a>
  );
}

/** Signed-out pages (sign-in, signed out, errors, unsubscribe): one card, no menu. */
function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="auth">
      <main className="auth-card">
        <Brand />
        <h1>{title}</h1>
        {children}
      </main>
    </div>
  );
}

/** `bare`: the page draws its own heading (Home's greeting, the calculator's steps). */
/** `intro`: one plain sentence under the title saying what the page is for. */
export function Page({ title, children, nav = true, wide = false, actions, bare = false, intro }: {
  title: string; children: ReactNode; nav?: boolean; wide?: boolean; actions?: ReactNode; bare?: boolean; intro?: ReactNode;
}) {
  const me = useContext(MeContext);
  if (!nav || !me) return <AuthLayout title={title}>{children}</AuthLayout>;
  return <Shell me={me} title={title} wide={wide} actions={actions} bare={bare} intro={intro}>{children}</Shell>;
}

function Shell({ me, title, wide, actions, bare, intro, children }: {
  me: Me; title: string; wide: boolean; actions?: ReactNode; bare: boolean; intro?: ReactNode; children: ReactNode;
}) {
  const [unread, setUnread] = useState(0);
  const more = useRef<HTMLDetailsElement>(null);
  useCloseOnOutside(more);
  useEffect(() => {
    unreadNotifications().then((r) => setUnread(r.unread)).catch(() => undefined);
  }, []);
  useEffect(() => {
    document.title = `${title} · ECR`;
  }, [title]);

  const path = window.location.pathname;
  const perms = me.user.permissions;
  const allowed = (i: NavItem) => !i.perm || perms.includes(i.perm);
  const under = (href: string) => path === href || path.startsWith(`${href}/`);
  const tabs = TABS.filter(allowed);
  const currentTab = tabs.find((t) => (t.href === '/' ? path === '/' : under(t.href) || t.also?.some(under)));
  const groups = MORE.map((g) => ({ ...g, items: g.items.filter(allowed) })).filter((g) => g.items.length);
  const inMore = !currentTab && groups.some((g) => g.items.some((i) => under(i.href)));

  return (
    <div className="shell">
      <a className="skip-link" href="#content">Skip to content</a>
      <header className="topbar">
        <div className="topbar-inner">
          <Brand />
          <nav className="tabs" aria-label="Main">
            {tabs.map((t) => (
              <a key={t.href} href={t.href} aria-current={t === currentTab ? 'page' : undefined}>{t.label}</a>
            ))}
            {groups.length > 0 && (
              <details className={`more${inMore ? ' current' : ''}`} ref={more}>
                <summary>
                  More tools
                  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 9l6 6 6-6" /></svg>
                </summary>
                <div className="menu">
                  {groups.map((g) => (
                    <div key={g.title}>
                      <h3>{g.title}</h3>
                      {g.items.map((i) => (
                        <a key={i.href} href={i.href} aria-current={under(i.href) ? 'page' : undefined}>
                          {i.label}{i.hint && <span className="hint">{i.hint}</span>}
                        </a>
                      ))}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </nav>
          <span className="spacer" />
          <a className="icon-link" href="/notifications" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} title="Notifications">
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
            </svg>
            {unread > 0 && <span className="count">{unread}</span>}
          </a>
          <UserMenu me={me} />
        </div>
      </header>
      <main id="content" className={`content${wide ? ' wide' : ''}`} tabIndex={-1}>
        {me.totp.enrollmentRequired && !path.startsWith('/settings/authenticator') && (
          <p className="callout warn">
            Your role needs an authenticator app. <a href="/settings/authenticator">Set it up now</a> to use privileged functions.
          </p>
        )}
        {!bare && (
          <div className="page-head">
            <h1>{title}</h1>
            {actions && <div className="actions">{actions}</div>}
          </div>
        )}
        {!bare && intro && <p className="intro">{intro}</p>}
        {children}
      </main>
    </div>
  );
}

function UserMenu({ me }: { me: Me }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  useCloseOnOutside(menu);

  async function signOut(allSessions: boolean) {
    setBusy(true);
    try {
      const result = await logout(allSessions);
      hubReset();
      sessionStorage.setItem('ecr.logout', JSON.stringify(result));
      window.location.replace('/signed-out');
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  const roles = me.user.roles.map(roleName);
  return (
    <details className="user-menu" ref={menu}>
      <summary aria-label={`Account: ${me.user.fullName}`}>
        <span className="avatar" aria-hidden="true">{initials(me.user.fullName)}</span>
        <span className="who">{me.user.fullName}<small>{roles.join(' · ') || 'No role'}</small></span>
      </summary>
      <div className="menu">
        <div className="menu-head">
          <strong>{me.user.fullName}</strong>
          <div className="muted">{me.user.email}</div>
        </div>
        <a href="/settings/authenticator">Authenticator {me.totp.enrolled ? '' : '(not set up)'}</a>
        <a href="/notifications">Notifications and following</a>
        <button type="button" disabled={busy} onClick={() => signOut(false)}>Sign out</button>
        <button type="button" disabled={busy} onClick={() => signOut(true)}>Sign out of all browsers</button>
        <ErrorText error={error} />
      </div>
    </details>
  );
}

/** Message plus every field problem the API reported (400 INVALID_INPUT details.fields). */
export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const fields = error instanceof ApiFailure && Array.isArray(error.details?.fields)
    ? (error.details.fields as { field: string; message: string }[])
    : [];
  return (
    <div role="alert" className="error">
      <p style={{ margin: '8px 0' }}>{message}</p>
      {fields.length > 1 && (
        <ul style={{ margin: 0 }}>
          {fields.map((f, i) => <li key={i}><code>{f.field}</code>: {f.message}</li>)}
        </ul>
      )}
    </div>
  );
}

const BADGE_TONES: Record<string, string> = {
  IN_FORCE: 'ok',
  PUBLISHED: 'ok',
  KEEP: 'ok',
  CLOSED: 'ok',
  DONE: 'ok',
  DISMISSED: 'dim',
  PROMULGATED: 'info',
  SUBMITTED: 'info',
  OPEN: 'info',
  IN_REVIEW: 'violet',
  SCHEDULED: 'violet',
  DRAFT_RANCANGAN: 'warn',
  WARNING: 'warn',
  ESCALATED: 'warn',
  NOT_IN_FORCE: 'warn',
  REJECTED: 'danger',
  ERROR: 'danger',
  REVOKED: 'danger',
  REVOKE: 'danger',
  ROLLBACK: 'warn',
  CANCELLED: 'dim',
  ROLLED_BACK: 'warn',
  APPROVED: 'ok',
  ACTIVE: 'ok',
  READY: 'ok',
  OK: 'ok',
  DRAFT: 'dim',
  QUEUED: 'info',
  RUNNING: 'info',
  FAILED: 'danger',
  EXPIRED: 'dim',
  DEACTIVATED: 'dim',
  DORMANT_DISABLED: 'warn',
  VALIDATED: 'ok',
  VALIDATED_WITH_ERRORS: 'warn',
  COMMITTED: 'info',
  SIMULATION: 'danger',
};

/** Plain words for the codes the API returns; anything unlisted shows as the code in sentence case. */
const BADGE_TEXT: Record<string, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Waiting for review',
  IN_REVIEW: 'Being reviewed',
  APPROVED: 'Approved',
  REJECTED: 'Sent back',
  PUBLISHED: 'Live',
  SCHEDULED: 'Goes live later',
  CANCELLED: 'Cancelled',
  ROLLBACK: 'Undo',
  ROLLED_BACK: 'Undone',
  PROMULGATED: 'Signed, not yet in force',
  IN_FORCE: 'In force',
  NOT_IN_FORCE: 'Not in force today',
  AMENDED: 'Amended',
  REVOKED: 'Withdrawn',
  REVOKE: 'Remove access',
  KEEP: 'Keep access',
  DRAFT_RANCANGAN: 'Draft regulation',
  WARNING: 'Check this',
  ERROR: 'Problem',
  INFO: 'Note',
  ESCALATED: 'Escalated',
  OPEN: 'Open',
  CLOSED: 'Closed',
  DISMISSED: 'Dismissed',
  DONE: 'Done',
  OK: 'OK',
  QUEUED: 'Waiting to start',
  RUNNING: 'In progress',
  READY: 'Ready',
  FAILED: 'Failed',
  EXPIRED: 'Expired',
  ACTIVE: 'Active',
  DEACTIVATED: 'Deactivated',
  DORMANT_DISABLED: 'Disabled (inactive)',
  CREATE: 'New',
  UPDATE: 'Change',
  VALIDATED: 'Checked',
  VALIDATED_WITH_ERRORS: 'Has problems',
  COMMITTED: 'Sent for review',
  REFERENCE_PRICE: 'Reference price',
  HARGA_EKSPOR: 'Export price (HE)',
  FX_RATE: 'Exchange rate',
  BK: 'Duty (BK)',
  PE: 'Levy (PE)',
  USER: 'Person',
  SYSTEM: 'System',
  SIMULATION: 'Simulation',
  CURRENT: 'Current',
  SECONDARY: 'Secondary copy',
  'SHARED HS': 'Shared HS code',
  'KEY SPEC': 'Key spec',
  NEW: 'New',
  NORMAL: 'Normal',
};

export const badgeText = (value: string) => {
  if (BADGE_TEXT[value]) return BADGE_TEXT[value];
  const words = value.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export function Badge({ value, title }: { value: string; title?: string }) {
  return <span title={title} className={`badge ${BADGE_TONES[value] ?? ''}`}>{badgeText(value)}</span>;
}

/** Wraps a table so it scrolls inside its own box on narrow screens, header and first column staying put (NFR-RSP-01). */
export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="table-wrap">{children}</div>;
}

export const tableStyle = { width: '100%', borderCollapse: 'collapse' } as const;
export const rowStyle = { verticalAlign: 'top' } as const;
export const headStyle = { textAlign: 'left' } as const;

/**
 * Runs a sensitive action; if the API answers STEP_UP_REQUIRED, asks for an authenticator code
 * (or a recovery code), steps up, and retries the action once.
 */
export function useStepUp() {
  const [pending, setPending] = useState<{ retry: () => Promise<void>; reject: (e: unknown) => void } | null>(null);

  async function run(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (e) {
      if (e instanceof ApiFailure && e.code === 'STEP_UP_REQUIRED') {
        await new Promise<void>((resolve, reject) => setPending({ retry: () => action().then(resolve, reject), reject }));
        return;
      }
      throw e;
    }
  }

  const dialog = pending ? (
    <StepUpDialog
      onCancel={() => {
        pending.reject(new Error('Cancelled.'));
        setPending(null);
      }}
      onDone={async () => {
        const p = pending;
        setPending(null);
        await p.retry();
      }}
    />
  ) : null;

  return { run, dialog };
}

function StepUpDialog({ onCancel, onDone }: { onCancel: () => void; onDone: () => Promise<void> }) {
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const cancel = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [onCancel]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await stepUp(useRecovery ? { recoveryCode: code } : { code });
      await onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="overlay">
      <form role="dialog" aria-modal="true" aria-labelledby="stepup-title" className="dialog" onSubmit={submit}>
        <h2 id="stepup-title">Confirm it's you</h2>
        <p>{useRecovery ? 'Enter one of your recovery codes.' : 'Enter the 6-digit code from your authenticator app.'}</p>
        <input autoFocus value={code} onChange={(e) => setCode(e.target.value)}
          inputMode={useRecovery ? 'text' : 'numeric'} autoComplete="one-time-code" aria-label="Code"
          style={{ width: '100%', fontSize: 20, padding: 10, letterSpacing: useRecovery ? undefined : '0.2em', textAlign: 'center' }} />
        <ErrorText error={error} />
        <div className="actions" style={{ marginTop: 16 }}>
          <button type="submit" disabled={busy || !code}>Confirm</button>
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" className="link" onClick={() => setUseRecovery(!useRecovery)} style={{ marginLeft: 'auto' }}>
            {useRecovery ? 'Use authenticator code' : 'Use a recovery code'}
          </button>
        </div>
      </form>
    </div>
  );
}
