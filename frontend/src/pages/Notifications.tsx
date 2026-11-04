import { useEffect, useState } from 'react';
import {
  AppNotification,
  Bulletin,
  CommodityView,
  getBulletin,
  listCommodities,
  listNotifications,
  listProducts,
  listSubscriptions,
  markNotificationsRead,
  ProductSummary,
  subscribe,
  Subscription,
  unsubscribe,
  unsubscribeByToken,
} from '../api';
import { Badge, ErrorText, headStyle, Page, rowStyle, tableStyle, TableWrap } from '../ui';
import { ChargeChange } from './ChangeSets';

const SCOPE_TEXT: Record<Subscription['scopeType'], string> = { COMMODITY: 'Commodity', PRODUCT_GROUP: 'Product group', PRODUCT: 'Product' };

/** In-app notifications and the changes a person follows (PRD F-48). */
export function NotificationsPage() {
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = () => listNotifications().then(setItems).catch(setError);
  useEffect(() => {
    void load();
  }, []);

  async function open(n: AppNotification) {
    if (!n.readAt) await markNotificationsRead(n.id).catch(() => undefined);
    window.location.assign(n.link);
  }

  return (
    <Page title="Notifications" wide intro="Messages about the products and rates you follow, and things that need your action.">
      <ErrorText error={error} />
      {items && items.some((n) => !n.readAt) && (
        <p><button onClick={() => markNotificationsRead().then(load).catch(setError)}>Mark all as read</button></p>
      )}
      {items && items.length === 0 && (
        <div className="empty"><strong>You're all caught up</strong><p>Follow a product to be told when its duty or levy changes.</p></div>
      )}
      {items && items.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {items.map((n) => (
            <li key={n.id} style={{ borderBottom: '1px solid var(--line)', padding: '10px 0', background: n.readAt ? undefined : 'var(--accent-soft)' }}>
              <a href={n.link} onClick={(e) => { e.preventDefault(); void open(n); }} style={{ fontWeight: n.readAt ? 400 : 700 }}>{n.title}</a>
              <div style={{ fontSize: 14, color: 'var(--muted)' }}>{n.body}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>{new Date(n.createdAt).toLocaleString()}{!n.readAt && <> · <Badge value="NEW" /></>}</div>
            </li>
          ))}
        </ul>
      )}
      <Subscriptions />
    </Page>
  );
}

function Subscriptions() {
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [commodities, setCommodities] = useState<CommodityView[]>([]);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [choice, setChoice] = useState('');
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    listSubscriptions().then(setSubs).catch(setError);
    listCommodities().then(setCommodities).catch(setError);
    listProducts().then(setProducts).catch(setError);
  }, []);

  async function add() {
    const [scopeType, id] = choice.split(':');
    setError(null);
    try {
      setSubs(await subscribe(scopeType as Subscription['scopeType'], id));
      setChoice('');
    } catch (e) {
      setError(e);
    }
  }

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 18 }}>Changes I follow</h2>
      <p style={{ fontSize: 14 }}>
        When a published version changes the duty or levy of something you follow, you get one notice per version here and by
        email, with a link to the change bulletin. Only published changes are sent.
      </p>
      <ErrorText error={error} />
      {subs && subs.length === 0 && <p style={{ fontSize: 14 }}>You follow nothing yet.</p>}
      {subs && subs.length > 0 && (
        <TableWrap><table style={{ ...tableStyle, maxWidth: 720 }}>
          <thead><tr style={headStyle}><th>Kind</th><th>Follows</th><th /></tr></thead>
          <tbody>
            {subs.map((s) => (
              <tr key={s.id} style={rowStyle}>
                <td>{SCOPE_TEXT[s.scopeType]}</td>
                <td>{s.label}</td>
                <td><button onClick={() => unsubscribe(s.id).then(setSubs).catch(setError)}>Stop following</button></td>
              </tr>
            ))}
          </tbody>
        </table></TableWrap>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
        <select aria-label="What to follow" value={choice} onChange={(e) => setChoice(e.target.value)} style={{ maxWidth: 480 }}>
          <option value="">Choose a commodity, group or product…</option>
          <optgroup label="Commodities and groups">
            {commodities.flatMap((c) => [
              <option key={c.entityId} value={`COMMODITY:${c.entityId}`}>{c.nameId} ({c.code})</option>,
              ...c.groups.map((g) => <option key={g.entityId} value={`PRODUCT_GROUP:${g.entityId}`}>&nbsp;&nbsp;{c.code} – {g.label}</option>),
            ])}
          </optgroup>
          <optgroup label="Products">
            {products.map((p) => <option key={p.entityId} value={`PRODUCT:${p.entityId}`}>{p.nameId}</option>)}
          </optgroup>
        </select>
        <button disabled={!choice} onClick={add}>Follow</button>
      </div>
    </section>
  );
}

/** "Follow this product" on the product page. */
export function FollowButton({ productId }: { productId: string }) {
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    listSubscriptions().then(setSubs).catch(setError);
  }, []);
  if (!subs) return null;
  const mine = subs.find((s) => s.scopeType === 'PRODUCT' && s.scopeEntityId === productId);
  return (
    <span>
      {mine
        ? <button onClick={() => unsubscribe(mine.id).then(setSubs).catch(setError)}>Following — stop</button>
        : <button onClick={() => subscribe('PRODUCT', productId).then(setSubs).catch(setError)}>Follow changes</button>}
      <ErrorText error={error} />
    </span>
  );
}

/** The change bulletin of a published version (US-29-P2 AC3); linked from every subscription notice. */
export function BulletinPage({ versionNo }: { versionNo: number }) {
  const [b, setB] = useState<Bulletin | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    getBulletin(versionNo).then(setB).catch(setError);
  }, [versionNo]);
  if (!b) return <Page title={`Data version ${versionNo}`}>{error ? <ErrorText error={error} /> : 'Loading…'}</Page>;
  const changed = b.impact.filter((r) => r.changed);
  return (
    <Page title={`Data version ${b.versionNo}: ${b.title}`} wide>
      <p>
        Published {new Date(b.publishedAt).toLocaleString()}
        {b.kind !== 'NORMAL' && <> · <Badge value={b.kind} /></>}
        {b.rollbackOfVersion && <> · rolls back version {b.rollbackOfVersion}</>}
        {b.rolledBackByVersion && <> · <Badge value="ROLLED_BACK" /> by version {b.rolledBackByVersion}</>}
      </p>
      <h2 style={{ fontSize: 18 }}>Duty and levy per tonne on {b.date}</h2>
      {b.impact.length === 0 && <p>No product's duty or levy is affected.</p>}
      {b.impact.length > 0 && (
        <>
          <p style={{ fontSize: 14 }}>{changed.length} of {b.impact.length} affected products changed. USD per MT, before → after this version.</p>
          <TableWrap><table style={tableStyle}>
            <thead><tr style={headStyle}><th>Product</th><th>Export duty (BK)</th><th>Export levy (PE)</th></tr></thead>
            <tbody>
              {b.impact.map((r) => (
                <tr key={r.productId} style={rowStyle}>
                  <td><a href={`/products/${r.productId}`}>{r.product}</a></td>
                  <td><ChargeChange before={r.bk.before} after={r.bk.after} /></td>
                  <td><ChargeChange before={r.pe.before} after={r.pe.after} /></td>
                </tr>
              ))}
            </tbody>
          </table></TableWrap>
        </>
      )}
      <h2 style={{ fontSize: 18 }}>Records changed</h2>
      <ul>
        {b.items.map((i, n) => <li key={n}><Badge value={i.operation} /> {i.entityType.replace(/_/g, ' ').toLowerCase()}: {i.label}</li>)}
      </ul>
    </Page>
  );
}

/** One-click unsubscribe from an email link; works without signing in (US-48-N1 AC1). */
export function UnsubscribePage() {
  const [result, setResult] = useState<{ label: string | null } | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token') ?? '';
    unsubscribeByToken(token).then(setResult).catch(setError);
  }, []);
  return (
    <Page title="Stop following" nav={false}>
      {error ? <ErrorText error={error} /> : !result ? 'One moment…'
        : <p>{result.label ? `You no longer follow ${result.label}.` : 'You no longer follow this.'} You can follow it again under <a href="/notifications">Notifications</a>.</p>}
    </Page>
  );
}
