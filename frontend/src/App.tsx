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
import { HeroPrices, PalmSpotlight, useTodayCatalogue } from './pages/PalmSpotlight';
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

  if (error) return <Page title="Something went wrong" nav={false}><ErrorText error={error} /></Page>;
  if (me === undefined) return <Page title="Loading…" nav={false}>{null}</Page>;
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

function route(path: string, me: Me): ReactNode {
  if (path === '/settings/authenticator') return <Authenticator me={me} />;
  if (path === '/admin/users') return <AdminUsers me={me} />;
  if (path === '/regulations') return <RegulationsPage />;
  if (path === '/products') return <ProductsPage />;
  if (path === '/change-sets') return <ChangeSetsPage me={me} />;
  if (path === '/prices') return <PricesPage />;
  if (path === '/catalogue') return <CataloguePage me={me} />;
  if (path === '/find') return <FindPage />;
  if (path === '/updates') return <UpdatesPage me={me} />;
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
  return <Home me={me} />;
}

interface DataVersion { versionNo: number; publishedAt: string; title: string; kind: string; publishedByName: string | null }
interface ReviewCampaign { id: string; periodLabel: string; status: string; waitingForYou: number }
interface DqSummary { run: { at: string; errors: number; warnings: number } | null }

/** Loads one dashboard source if the person may read it; a failure leaves that card out instead of failing the page. */
function useOptional<T>(allowed: boolean, load: () => Promise<T>): T | null | undefined {
  const [data, setData] = useState<T | null | undefined>(allowed ? undefined : null);
  useEffect(() => {
    if (allowed) load().then(setData).catch(() => setData(null));
  }, []);
  return data;
}

const greeting = () => {
  const h = new Date().getHours();
  return h < 11 ? 'Good morning' : h < 15 ? 'Good afternoon' : 'Good evening';
};
const dateTime = (d: string) => new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const period = (from: string, to: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).formatRange(new Date(`${from}T00:00:00`), new Date(`${to}T00:00:00`));

/** Home: checking a product comes first (search, then every palm oil product with today's charges); other tasks support it. */
function Home({ me }: { me: Me }) {
  const perms = me.user.permissions;
  const can = (p: string) => perms.includes(p);
  const firstName = me.user.fullName.split(/\s+/)[0];

  const notifications = useOptional<AppNotification[]>(true, () => listNotifications(true));
  const toReview = useOptional<ChangeSetSummary[]>(can('changeset.approve'), () => listChangeSets('SUBMITTED'));
  const inReview = useOptional<ChangeSetSummary[]>(can('changeset.approve'), () => listChangeSets('IN_REVIEW'));
  const myDrafts = useOptional<ChangeSetSummary[]>(can('changeset.create'), () => api<ChangeSetSummary[]>('/change-sets?status=DRAFT&mine=true'));
  const reviews = useOptional<ReviewCampaign[]>(can('accessreview.read'), () => api<ReviewCampaign[]>('/admin/reviews'));
  const dq = useOptional<DqSummary>(can('dq.read'), () => api<DqSummary>('/dq/findings'));
  const versions = useOptional<DataVersion[]>(can('changeset.read'), () => api<DataVersion[]>('/data-versions?limit=5'));
  const catalogue = useTodayCatalogue(can('catalogue.read'));

  const accessWaiting = reviews?.filter((r) => r.status === 'OPEN').reduce((n, r) => n + r.waitingForYou, 0);
  const todos: { href: string; n: number | undefined; label: string; hint: string }[] = [];
  if (toReview !== null) todos.push({ href: '/change-sets', n: toReview && inReview ? toReview.length + inReview.length : undefined, label: 'Rate updates to approve', hint: 'Someone entered new rates; check them' });
  if (myDrafts !== null) todos.push({ href: '/change-sets', n: myDrafts?.length, label: 'Your unfinished drafts', hint: 'Pick up where you left off' });
  if (reviews !== null) todos.push({ href: '/admin/reviews', n: accessWaiting, label: 'Access decisions for you', hint: 'Confirm who keeps access' });
  if (dq !== null) todos.push({ href: '/data-quality', n: dq?.run ? dq.run.errors + dq.run.warnings : undefined, label: 'Data checks to look at', hint: 'Possible gaps or mistakes in the data' });
  todos.push({ href: '/notifications', n: notifications?.length, label: 'Unread notifications', hint: 'Messages about rates you follow' });

  const search = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
    window.location.assign(q ? `/find?q=${encodeURIComponent(q)}` : '/find');
  };

  return (
    <Page title="Home" wide bare>
      {can('catalogue.read') ? (
        <section className="hero check-hero" aria-labelledby="hero-title">
          <p className="eyebrow">{greeting()}, {firstName}</p>
          <h1 id="hero-title">Check a product</h1>
          <p className="lead">Type a product name or HS code. You'll see the export duty and levy for shipping it today, in plain words, with the regulation behind it.</p>
          <form className="big-search" role="search" onSubmit={search}>
            <label className="field">
              <span className="sr-only">Product name or HS code</span>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
              <input name="q" type="search" placeholder="e.g. crude palm oil, or 1511.10.00" autoComplete="off" autoFocus />
            </label>
            <button type="submit">Check</button>
          </form>
          <div className="chips">
            <span className="label">Often checked:</span>
            {POPULAR.map((p) => <a key={p.q} className="chip" href={`/find?q=${encodeURIComponent(p.q)}`}>{p.label}</a>)}
          </div>
          <HeroPrices data={catalogue.data} />
        </section>
      ) : (
        <section className="hero">
          <p className="eyebrow">{greeting()}, {firstName}</p>
          <h1>Welcome to Export Charges</h1>
          <p className="lead">Your account has no role yet, so there is nothing to look up. Ask your administrator for access.</p>
        </section>
      )}

      {can('catalogue.read') && <PalmSpotlight data={catalogue.data} error={catalogue.error} />}

      <div className="split support">
        <section className="main" aria-labelledby="more-title">
          <h2 id="more-title" className="section-title">More you can do</h2>
          <div className="tool-grid">
            {can('calc.run') && (
              <Tool href="/calculator" tone="levy" title="Calculate a shipment" d="Products and tonnes in, total in USD and Rupiah out."
                icon="M6 2h12a2 2 0 012 2v16a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2zM8 6h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 19h8" />
            )}
            {can('catalogue.read') && (
              <>
                <Tool href="/catalogue" title="All products" d="Every product and its charges in one table, ready to export."
                  icon="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18" />
                <Tool href="/updates" tone="violet" title="What changed" d="New regulations and this period's prices."
                  icon="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M9 13h6M9 17h4" />
                <Tool href="/prices" title="Reference prices" d="CPO price and exchange rate, past and present."
                  icon="M3 3v18h18M7 14l4-4 3 3 5-6" />
                <Tool href="/regulations" title="Regulations" d="The PMK, Kepmendag and Permenperin behind each rate."
                  icon="M4 19.5A2.5 2.5 0 016.5 17H20V3H6.5A2.5 2.5 0 004 5.5zM4 19.5A2.5 2.5 0 006.5 22H20v-5" />
                <Tool href="/sources" tone="violet" title="Official PDFs" d="The documents the figures come from."
                  icon="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M12 18v-6M9 15l3 3 3-3" />
              </>
            )}
          </div>
        </section>
        <section className="panel side" aria-labelledby="todo-title">
          <h2 id="todo-title" style={{ marginTop: 0, fontSize: 20, fontWeight: 800 }}>Waiting for you</h2>
          {todos.map((t) => (
            <a key={t.label} className={`todo${t.n ? ' attention' : ''}`} href={t.href}>
              <span className="n">{t.n ?? '…'}</span>
              <span><strong>{t.label}</strong><span className="d">{t.hint}</span></span>
            </a>
          ))}
        </section>
      </div>

      {versions !== null && (
        <section className="panel" aria-labelledby="changed-title" style={{ marginBottom: 32 }}>
          <div className="panel-head">
            <h2 id="changed-title">What changed recently</h2>
            <a href="/updates">See all updates</a>
          </div>
          {versions === undefined ? <p className="muted">Loading…</p> : !versions.length ? <p className="muted">Nothing published yet.</p> : <VersionFeed versions={versions} />}
        </section>
      )}

      <h2 className="section-title">New here? Two words to know</h2>
      <Glossary />
    </Page>
  );
}

/** A supporting task on Home: smaller than the product check above it. */
function Tool({ href, title, d, icon, tone }: { href: string; title: string; d: string; icon: string; tone?: 'levy' | 'violet' }) {
  return (
    <a className={tone ? `tool ${tone}` : 'tool'} href={href}>
      <span className="ico"><Icon d={icon} size={20} /></span>
      <span><strong>{title}</strong><span className="d">{d}</span></span>
    </a>
  );
}

/** Search shortcuts on Home; each is a plain catalogue search. */
const POPULAR = [
  { label: 'Crude palm oil (CPO)', q: 'CPO' },
  { label: 'Palm olein', q: 'olein' },
  { label: 'Palm kernel', q: 'kernel' },
  { label: 'Biodiesel', q: 'biodiesel' },
];

export function Icon({ d, size = 26 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

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
            <span className={`tag${v.kind === 'ROLLBACK' ? ' warn' : ' violet'}`}>{v.kind === 'ROLLBACK' ? 'Undone' : 'Update'}</span>
            <span className="body"><strong>{v.title}</strong><span>Version {v.versionNo}{v.publishedByName ? ` · published by ${v.publishedByName}` : ''}</span></span>
            <span className="when">{dateTime(v.publishedAt)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function Glossary() {
  return (
    <section className="glossary" aria-label="Glossary">
      <div>
        <strong>Export duty · Bea Keluar (BK)</strong>
        <span>A tax paid to Customs (DJBC) on some exports. The amount often depends on the current reference price.</span>
      </div>
      <div className="levy">
        <strong>Export levy · Pungutan Ekspor (PE)</strong>
        <span>A separate charge collected for the plantation fund agency (BPDP). It is paid on top of any duty.</span>
      </div>
    </section>
  );
}

/** What changed: prices in force, published data updates and the newest regulations, one line each. */
function UpdatesPage({ me }: { me: Me }) {
  const can = (p: string) => me.user.permissions.includes(p);
  const prices = useOptional<SeriesView[]>(can('catalogue.read'), () => listRefSeries());
  const versions = useOptional<DataVersion[]>(can('changeset.read'), () => api<DataVersion[]>('/data-versions?limit=20'));
  const regs = useOptional<RegulationView[]>(can('catalogue.read'), () => listRegulations());
  const newest = regs?.filter((r) => r.effectiveOn).sort((a, b) => b.effectiveOn!.localeCompare(a.effectiveOn!)).slice(0, 8);

  return (
    <Page title="What changed" wide>
      <p className="muted" style={{ marginTop: 0, fontSize: 17 }}>The latest reference prices, rule changes and data updates. Follow a product to be told when its rates change.</p>
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
