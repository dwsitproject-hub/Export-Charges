import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { api, Me } from './api';

/**
 * The guided tour: shown once at a person's first sign-in (on the Full product table), and again whenever they press "Tour".
 * Each step highlights one part of the page (an element marked data-tour="…") with a short explanation; steps whose
 * part is not on the page for this person (e.g. no calculator for their role) are left out.
 */

interface Step {
  /** data-tour value of the part to highlight; none = a centred message. */
  target?: string;
  title: string;
  body: string;
}

function stepsFor(me: Me): Step[] {
  const can = (p: string) => me.user.permissions.includes(p);
  const first = me.user.fullName.split(/\s+/)[0];
  const steps: Step[] = [
    {
      title: `Welcome to Export Charges, ${first}`,
      body: 'ECR tells you the Indonesian export duty (Bea Keluar) and export levy (Pungutan Ekspor) on palm oil products, with the official regulation behind every number. This tour takes about a minute.',
    },
    { target: 'search', title: 'Find a product', body: 'Type a product name, synonym or HS code to narrow the table. Every row shows the export duty (BK), the export levy (PE) and the total per tonne.' },
    { target: 'refprice', title: 'The CPO reference price', body: 'The monthly CPO reference price decides the duty band. Type another price and press Show charges to see which band it falls in and every duty and levy at that price. Nothing is saved.' },
    { target: 'filters', title: 'Filter the list', body: 'Narrow the table by charge, commodity, product group or regulation. The address keeps your filters, so Copy link shares exactly this view.' },
    { target: 'table', title: 'Duty, levy and total', body: 'Under each duty you see its price band; under each levy, its % of the CPO reference price. Click a column title to sort.' },
    { target: 'product-row', title: 'Open a product', body: 'Click a product name for its details: the duty and levy cards, how they were worked out, the regulation lines and the official PDF.' },
    {
      target: 'nav', title: 'The main menu',
      body: `Full product table, Find a product${can('calc.run') ? ', Calculate a shipment (tonnes in, total in USD and Rupiah out)' : ''}, Policy History (regulations, reference prices and data updates over time), and More tools.`,
    },
    { target: 'bell', title: 'Notifications', body: 'When a price, a rate or a regulation changes, you are told here and by email. Follow a product to hear about it in particular.' },
  ];
  if (can('changeset.approve')) {
    steps.push({ target: 'more', title: 'Your reviews as a Checker', body: 'ECR drafts the changes it should not publish by itself (unusual prices, new regulations). They arrive as "Change set waiting for review": open More tools → Rate updates, compare with the PDF, then approve or reject.' });
  } else if (can('changeset.create')) {
    steps.push({ target: 'more', title: 'Entering updates', body: 'More tools → Rate updates is where you enter changes for a Checker to approve; New regulation watch lists what ECR found on the official sites.' });
  }
  steps.push({ target: 'tour-button', title: 'See this again any time', body: 'Press Tour whenever you want to replay this guide.' });
  return steps;
}

/** Starts the tour from anywhere: on the product table at once, elsewhere by going there first. */
export function startTour() {
  if (window.location.pathname === '/') window.dispatchEvent(new Event('ecr:tour'));
  else window.location.assign('/?tour=1');
}

const findTarget = (name: string) => document.querySelector<HTMLElement>(`[data-tour="${name}"]`);

/** Waits (briefly) for a part of the page that is still loading, e.g. the product list. */
async function waitFor(name: string, ms = 4000): Promise<HTMLElement | null> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const el = findTarget(name);
    if (el && el.getClientRects().length) return el;
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

type Box = { top: number; left: number; width: number; height: number };

export function TourHost({ me }: { me: Me }) {
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [ready, setReady] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  // The window size, so the card is laid out again when a phone is rotated or the window resized.
  const [, setViewport] = useState(() => `${window.innerWidth}x${window.innerHeight}`);
  const element = useRef<HTMLElement | null>(null);

  const open = useCallback(async () => {
    // Only the steps whose part this person has on the page (the product list may still be loading).
    const all = stepsFor(me);
    const present: Step[] = [];
    const slow = ['search', 'refprice', 'filters', 'table', 'product-row'];
    for (const s of all) if (!s.target || (await waitFor(s.target, slow.includes(s.target) ? 4000 : 600))) present.push(s);
    setSteps(present);
    setIndex(0);
  }, [me]);

  // Started by the Tour button, by ?tour=1, or by a first sign-in on Home.
  useEffect(() => {
    const onStart = () => void open();
    window.addEventListener('ecr:tour', onStart);
    const params = new URLSearchParams(window.location.search);
    const asked = params.get('tour') === '1';
    if (asked) {
      params.delete('tour');
      window.history.replaceState(null, '', `${window.location.pathname}${params.toString() ? `?${params}` : ''}`);
    }
    if (window.location.pathname === '/' && me.user.permissions.includes('page.catalogue') && (asked || !me.user.tourSeenAt)) void open();
    return () => window.removeEventListener('ecr:tour', onStart);
  }, [open]);

  const close = useCallback(() => {
    setSteps(null);
    setBox(null);
    if (!me.user.tourSeenAt) {
      me.user.tourSeenAt = new Date().toISOString();
      void api('/auth/tour-seen', { method: 'POST' }).catch(() => undefined);
    }
    document.querySelector<HTMLElement>('[data-tour="tour-button"]')?.focus();
  }, [me]);

  const step = steps?.[index];

  // Bring the part into view, then measure it; re-measure when the window changes.
  useLayoutEffect(() => {
    if (!step) return;
    setReady(false);
    const el = step.target ? findTarget(step.target) : null;
    element.current = el;
    if (el) {
      const header = document.querySelector<HTMLElement>('.topbar')?.offsetHeight ?? 0;
      const r = el.getBoundingClientRect();
      const fixed = getComputedStyle(el).position === 'fixed' || Boolean(el.closest('.topbar'));
      if (!fixed) {
        const tall = r.height > window.innerHeight * 0.55;
        const top = tall ? r.top + window.scrollY - header - 16 : r.top + window.scrollY - (window.innerHeight - r.height) / 2;
        window.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
      }
    }
    const measure = () => {
      setViewport(`${window.innerWidth}x${window.innerHeight}`);
      const target = element.current;
      if (!target) return setBox(null);
      const r = target.getBoundingClientRect();
      const pad = 8;
      setBox({ top: r.top - pad, left: r.left - pad, width: r.width + pad * 2, height: r.height + pad * 2 });
    };
    measure();
    const frame = requestAnimationFrame(() => { measure(); setReady(true); card.current?.focus(); });
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure);
    };
  }, [step]);

  const next = useCallback(() => {
    if (!steps) return;
    if (index < steps.length - 1) setIndex(index + 1);
    else close();
  }, [steps, index, close]);
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    if (!steps) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [steps, next, back, close]);

  if (!steps || !step) return null;

  // The card goes below or above the highlighted part, whichever has more room; on small screens or next to a
  // tall part it sits at the bottom of the screen.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cardWidth = Math.min(380, vw - 32);
  let placement: CSSProperties;
  if (!box) {
    placement = { top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: cardWidth };
  } else {
    const below = vh - (box.top + box.height);
    const above = box.top;
    const left = Math.min(Math.max(16, box.left), vw - cardWidth - 16);
    if (vw < 600 || Math.max(below, above) < 230) placement = { left: 16, right: 16, bottom: 16 };
    else if (below >= above) placement = { top: box.top + box.height + 12, left, width: cardWidth };
    else placement = { bottom: vh - box.top + 12, left, width: cardWidth };
  }
  const last = index === steps.length - 1;

  return (
    <div className="tour" role="presentation">
      <div className={`tour-shade${box ? ' hole' : ''}`} style={box ? { top: box.top, left: box.left, width: box.width, height: box.height } : undefined} />
      <div
        ref={card}
        className={`tour-card${ready ? ' ready' : ''}`}
        style={placement}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        tabIndex={-1}
      >
        <p className="tour-count">Step {index + 1} of {steps.length}</p>
        <h2 id="tour-title">{step.title}</h2>
        <p id="tour-body">{step.body}</p>
        <div className="tour-dots" aria-hidden="true">
          {steps.map((_, i) => <span key={i} className={i === index ? 'on' : ''} />)}
        </div>
        <div className="tour-actions">
          <button type="button" className="link" onClick={close}>{last ? 'Close' : 'Skip tour'}</button>
          <span className="spacer" />
          {index > 0 && <button type="button" onClick={back}>Back</button>}
          <button type="button" className="primary" onClick={next} autoFocus>{last ? 'Finish' : index === 0 ? 'Start the tour' : 'Next'}</button>
        </div>
      </div>
    </div>
  );
}
