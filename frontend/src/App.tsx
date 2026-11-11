import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, AppNotification, ChangeSetSummary, fetchMe, formatDecimal, listChangeSets, listNotifications, listRefSeries, listRegulations, LogoutResult, Me, RegulationView, SeriesView, signInUrl } from './api';
import { hubIdentify } from './hubSdk';
import { AccessReviewDetail, AccessReviewsPage } from './pages/AccessReviews';
import { AdminUsers } from './pages/AdminUsers';
import { AuditLogPage } from './pages/AuditLog';
import { Authenticator } from './pages/Authenticator';
import { ConfigurationPage } from './pages/Configuration';
import { ChangeSetDetail, ChangeSetsPage } from './pages/ChangeSets';
import { ProductDetail, ProductsPage, RegulationDetail, RegulationsPage } from './pages/Registry';
import { PricesPage, ScheduleDetail, SchedulesPage, SeriesDetail } from './pages/Tariffs';
import { CalculationDetail, CalculationsPage, CalculatorPage, VerifyEvidencePage } from './pages/Calculator';
import { CataloguePage } from './pages/Catalogue';
import { FindPage } from './pages/Find';
import { ExportDetail, ExportsPage } from './pages/Exports';
import { ImportDetail, ImportsPage } from './pages/Imports';
import { DataQualityPage, JobsPage } from './pages/Jobs';
import { BulletinPage, NotificationsPage, UnsubscribePage } from './pages/Notifications';
import { SourcesPage } from './pages/Sources';
import { SourceWatchPage } from './pages/SourceWatch';
import { Badge, ErrorText, MeContext, Page } from './ui';

const SIGN_IN_ERRORS: Record<string, string> = {
  LOGIN_STATE_INVALID: 'Your sign-in expired. Please try again.',
  LOGIN_HUB_ERROR: 'DWS Hub did not complete the sign-in.',
  LOGIN_TOKEN_REJECTED: 'DWS Hub did not complete the sign-in.',
  LOGIN_TOKEN_INVALID: 'The DWS Hub sign-in could not be verified.',
  LOGIN_BLOCKED: 'Your ECR account is not active. Contact your administrator.',
  LOGIN_IDENTITY_CONFLICT: 'This email already belongs to another ECR account. Contact your administrator.',
  LOGIN_NO_EMAIL: 'DWS Hub did not share an email for your account. Contact your administrator.',
  HUB_UNAVAILABLE: 'DWS Hub is unavailable. Try again shortly.',
};

export function App() {
  const path = window.location.pathname;
  if (path === '/signed-out') return <SignedOut />;
  if (path === '/signin-error') return <SignInError />;
  // Opened from an email; the signed link is enough, no sign-in needed.
  if (path === '/unsubscribe') return <UnsubscribePage />;
  return <SignedInArea path={path} />;
}

/** Loads the session once; every page below needs a signed-in user. */
function SignedInArea({ path }: { path: string }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    fetchMe()
      .then((m) => {
        if (m) hubIdentify({ hubSubject: m.user.hubSubject, email: m.user.email });
        setMe(m);
      })
      .catch(setError);
  }, []);

  // No ECR session: go straight to DWS Hub, which signs the person in without a prompt while their Hub session is
  // open. Once per 30 seconds at most, so a browser that refuses the session cookie gets the button, not a loop.
  const autoSignIn = me === null && startAutoSignIn();
  useEffect(() => {
    if (autoSignIn) window.location.replace(signInUrl(window.location.pathname + window.location.search));
  }, [autoSignIn]);

  if (error) return <Page title="Something went wrong" nav={false}><ErrorText error={error} /></Page>;
  if (me === undefined || autoSignIn) return <Page title={autoSignIn ? 'Signing you in…' : 'Loading…'} nav={false}>{null}</Page>;
  if (me === null) {
    return (
      <Page title="Sign in" nav={false}>
        <p className="muted">The single source of Indonesian export duty (Bea Keluar) and export levy (Pungutan Ekspor) rates, with the regulations behind them.</p>
        <a className="button primary" href={signInUrl()}>Sign in with DWS Hub</a>
      </Page>
    );
  }
  return <MeContext.Provider value={me}>{route(path, me)}</MeContext.Provider>;
}

/**
 * True when this tab has not just tried an automatic sign-in; remembers the attempt (sessionStorage, per tab).
 * Decided once per page load, so re-renders keep the same answer.
 */
let autoSignInDecision: boolean | undefined;
function startAutoSignIn(): boolean {
  if (autoSignInDecision !== undefined) return autoSignInDecision;
  const key = 'ecr.autoSignInAt';
  try {
    const last = Number(sessionStorage.getItem(key) ?? 0);
    autoSignInDecision = !(Date.now() - last < 30_000);
    if (autoSignInDecision) sessionStorage.setItem(key, String(Date.now()));
  } catch {
    autoSignInDecision = false;
  }
  return autoSignInDecision;
}

function route(path: string, me: Me): ReactNode {
  if (path === '/settings/authenticator') return <Authenticator me={me} />;
  if (path === '/admin/users') return <AdminUsers me={me} />;
  if (path === '/regulations') return <RegulationsPage />;
  if (path === '/products') return <ProductsPage />;
  if (path === '/change-sets') return <ChangeSetsPage me={me} />;
  if (path === '/prices') return <PricesPage />;
  if (path === '/find') return <FindPage />;
  if (path === '/policy-history' || path === '/updates') return <UpdatesPage me={me} />;
  if (path === '/calculator') return <CalculatorPage />;
  if (path === '/calculations') return <CalculationsPage />;
  if (path === '/schedules') return <SchedulesPage />;
  if (path === '/imports') return <ImportsPage />;
  if (path === '/notifications') return <NotificationsPage />;
  if (path === '/exports') return <ExportsPage />;
  if (path === '/admin/jobs') return <JobsPage me={me} />;
  if (path === '/admin/audit') return <AuditLogPage me={me} />;
  if (path === '/admin/reviews') return <AccessReviewsPage />;
  if (path === '/admin/config') return <ConfigurationPage me={me} />;
  if (path === '/data-quality') return <DataQualityPage />;
  if (path === '/sources') return <SourcesPage />;
  if (path === '/source-watch') return <SourceWatchPage me={me} />;
  const bulletin = /^\/bulletins\/(\d+)$/.exec(path);
  if (bulletin) return <BulletinPage versionNo={Number(bulletin[1])} />;
  const review = /^\/admin\/reviews\/([0-9a-f-]{36})$/i.exec(path);
  if (review) return <AccessReviewDetail me={me} id={review[1]} />;
  const detail = /^\/(regulations|products|change-sets|prices|schedules|calculations|imports|exports)\/([0-9a-f-]{36})$/i.exec(path);
  if (detail?.[1] === 'regulations') return <RegulationDetail id={detail[2]} />;
  if (detail?.[1] === 'products') return <ProductDetail id={detail[2]} />;
  if (detail?.[1] === 'change-sets') return <ChangeSetDetail me={me} id={detail[2]} />;
  if (detail?.[1] === 'prices') return <SeriesDetail id={detail[2]} />;
  if (detail?.[1] === 'schedules') return <ScheduleDetail id={detail[2]} />;
  if (detail?.[1] === 'imports') return <ImportDetail id={detail[2]} />;
  if (detail?.[1] === 'exports') return <ExportDetail id={detail[2]} />;
  if (detail?.[1] === 'calculations') return <CalculationDetail me={me} id={detail[2]} />;
  const evidence = /^\/verify\/(EV-[0-9a-f-]{36})$/i.exec(path);
  if (evidence) return <VerifyEvidencePage id={evidence[1]} />;
  // The landing page: the full product table (also at /catalogue for old links).
  if (path === '/' || path === '/catalogue') {
    if (!me.user.permissions.includes('catalogue.read')) {
      return (
        <Page title="Welcome to Export Charges">
          <p>Your account has no role yet, so there is nothing to look up. Ask your administrator for access.</p>
        </Page>
      );
    }
    return <CataloguePage me={me} />;
  }
  return <Page title="Page not found"><p>There is no page at this address. <a href="/">Go to the product table</a>.</p></Page>;
}

interface DataVersion { versionNo: number; publishedAt: string; title: string; kind: string; publishedByName: string | null; automatic?: boolean }

/** Loads one dashboard source if the person may read it; a failure leaves that card out instead of failing the page. */
function useOptional<T>(allowed: boolean, load: () => Promise<T>): T | null | undefined {
  const [data, setData] = useState<T | null | undefined>(allowed ? undefined : null);
  useEffect(() => {
    if (allowed) load().then(setData).catch(() => setData(null));
  }, []);
  return data;
}

const dateTime = (d: string) => new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const period = (from: string, to: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).formatRange(new Date(`${from}T00:00:00`), new Date(`${to}T00:00:00`));

export function PriceStat({ s }: { s: SeriesView }) {
  const v = s.current ?? s.latest;
  return (
    <a className="stat" href={`/prices/${s.entityId}`}>
      <span className="k">{s.name}</span>
      <span className="v">{v ? formatDecimal(v.value) : '—'} <small>{s.current?.unit ?? s.unit}</small></span>
      <span className="p">
        {s.current ? <>Valid {period(s.current.periodFrom, s.current.periodTo)}</>
          : s.latest ? <>Not in force today · last {period(s.latest.periodFrom, s.latest.periodTo)}</>
          : 'None published yet'}
        {s.current?.fallback && <> · <Badge value="WARNING" title="Last known value carried forward" /></>}
      </span>
    </a>
  );
}

export function VersionFeed({ versions }: { versions: DataVersion[] }) {
  return (
    <ul className="feed">
      {versions.map((v) => (
        <li key={v.versionNo}>
          <a href={`/bulletins/${v.versionNo}`}>
            <span className={`tag${v.kind === 'ROLLBACK' ? ' warn' : v.automatic ? '' : ' violet'}`}>{v.kind === 'ROLLBACK' ? 'Undone' : v.automatic ? 'Automatic' : 'Update'}</span>
            <span className="body"><strong>{v.title}</strong><span>Version {v.versionNo}{v.publishedByName ? ` · published by ${v.publishedByName}` : ''}</span></span>
            <span className="when">{dateTime(v.publishedAt)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Policy History: prices in force, published data updates and the newest regulations, one line each. */
function UpdatesPage({ me }: { me: Me }) {
  const can = (p: string) => me.user.permissions.includes(p);
  const prices = useOptional<SeriesView[]>(can('catalogue.read'), () => listRefSeries());
  const versions = useOptional<DataVersion[]>(can('changeset.read'), () => api<DataVersion[]>('/data-versions?limit=20'));
  const regs = useOptional<RegulationView[]>(can('catalogue.read'), () => listRegulations());
  const newest = regs?.filter((r) => r.effectiveOn).sort((a, b) => b.effectiveOn!.localeCompare(a.effectiveOn!)).slice(0, 8);

  return (
    <Page title="Policy History" wide>
      <p className="muted" style={{ marginTop: 0, fontSize: 17 }}>The history of the export duty and levy policy: the regulations behind the rates, the reference prices in force, and every published data update. Follow a product to be told when its rates change.</p>
      {prices !== null && (
        <section className="panel" aria-labelledby="up-prices">
          <div className="panel-head"><h2 id="up-prices">Prices in force today</h2><a href="/prices">All reference prices</a></div>
          {prices === undefined ? <p className="muted">Loading…</p> : !prices.length ? <p className="muted">No reference prices published yet.</p> : (
            <div className="stat-grid">{prices.map((s) => <PriceStat key={s.entityId} s={s} />)}</div>
          )}
        </section>
      )}
      {regs !== null && (
        <section className="panel" aria-labelledby="up-regs">
          <div className="panel-head"><h2 id="up-regs">Newest regulations</h2><a href="/regulations">All regulations</a></div>
          {newest === undefined ? <p className="muted">Loading…</p> : !newest.length ? <p className="muted">No regulations published yet.</p> : (
            <ul className="feed">
              {newest.map((r) => (
                <li key={r.entityId}>
                  <a href={`/regulations/${r.entityId}`}>
                    <span className="tag">Rule</span>
                    <span className="body"><strong>{r.label}</strong><span>{r.titleEn ?? r.titleId}</span></span>
                    <span className="when">From {longDay(r.effectiveOn!)}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {versions !== null && (
        <section className="panel" aria-labelledby="up-versions">
          <div className="panel-head"><h2 id="up-versions">Data updates</h2></div>
          {versions === undefined ? <p className="muted">Loading…</p> : !versions.length ? <p className="muted">Nothing published yet.</p> : <VersionFeed versions={versions} />}
        </section>
      )}
    </Page>
  );
}

const longDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' });

function SignedOut() {
  const stored = sessionStorage.getItem('ecr.logout');
  const result: LogoutResult | null = stored ? JSON.parse(stored) : null;
  return (
    <Page title="You are signed out of ECR" nav={false}>
      <p>Your DWS Hub session is still active. If this is a shared computer, sign out of DWS Hub as well.</p>
      <div className="actions">
        <a className="button primary" href={signInUrl('/')}>Sign in again</a>
        {result && <a className="button" href={result.hubDashboardUrl}>Open DWS Hub</a>}
      </div>
    </Page>
  );
}

function SignInError() {
  const reason = new URLSearchParams(window.location.search).get('reason') ?? '';
  return (
    <Page title="Sign-in did not complete" nav={false}>
      <p>{SIGN_IN_ERRORS[reason] ?? 'Something went wrong while signing in.'}</p>
      <a className="button primary" href={signInUrl('/')}>Try again</a>
    </Page>
  );
}
