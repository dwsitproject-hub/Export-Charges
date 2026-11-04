import type { Queryable } from '../db/db.service';
import { CandidateItem, CandidateState } from '../registry/candidate';
import type { EntityData, ProductData } from '../registry/entities';
import { Charge, chargeFor } from './charge-engine';
import type { RefSeriesData, RefValueData, ScheduleLineData } from './tariff-entities';

export interface ImpactRow {
  productId: string;
  product: string;
  bk: { before: Charge; after: Charge };
  pe: { before: Charge; after: Charge };
  changed: boolean;
}

type ChangedItem = Pick<CandidateItem, 'entityType' | 'entityId'> & { before: EntityData | null; after: EntityData | null };

/**
 * Products whose duty or levy a set of changes can affect: products changed directly, products on changed schedule
 * lines, and products charged through a changed schedule, band table, reference series or value, in any of `states`.
 */
export function affectedProducts(states: CandidateState[], items: ChangedItem[]): Set<string> {
  const touched = new Set(items.map((i) => i.entityId));
  // Reference-value changes act through their series.
  for (const i of items.filter((x) => x.entityType === 'REF_VALUE')) {
    for (const d of [i.before, i.after] as (RefValueData | null)[]) if (d?.seriesId) touched.add(d.seriesId);
  }

  const products = new Set<string>();
  for (const i of items) {
    if (i.entityType === 'PRODUCT') products.add(i.entityId);
    if (i.entityType === 'SCHEDULE_LINE') for (const d of [i.before, i.after] as (ScheduleLineData | null)[]) d?.productIds.forEach((p) => products.add(p));
  }
  for (const state of states) {
    for (const l of state.ofType<ScheduleLineData>('SCHEDULE_LINE')) {
      if ([l.data.scheduleId, l.data.bandTableId, l.data.refSeriesId].some((id) => id && touched.has(id))) l.data.productIds.forEach((p) => products.add(p));
    }
    // A product's own Harga Ekspor series.
    for (const s of state.ofType<RefSeriesData>('REF_SERIES')) if (s.data.productId && touched.has(s.id)) products.add(s.data.productId);
  }
  return products;
}

/** Duty and levy per tonne for each product on one date, in two states of the data. */
export function compareCharges(before: CandidateState, after: CandidateState, products: Iterable<string>, date: string): ImpactRow[] {
  const rows: ImpactRow[] = [];
  for (const productId of products) {
    const name = after.get<ProductData>(productId, 'PRODUCT')?.nameId ?? before.get<ProductData>(productId, 'PRODUCT')?.nameId;
    if (!name) continue;
    const bk = { before: chargeFor(before, productId, 'BK', date), after: chargeFor(after, productId, 'BK', date) };
    const pe = { before: chargeFor(before, productId, 'PE', date), after: chargeFor(after, productId, 'PE', date) };
    const key = (c: Charge) => `${c.status}|${c.usdPerMt}`;
    rows.push({ productId, product: name, bk, pe, changed: key(bk.before) !== key(bk.after) || key(pe.before) !== key(pe.after) });
  }
  return rows.sort((a, b) => Number(b.changed) - Number(a.changed) || a.product.localeCompare(b.product));
}

/**
 * Impact preview (PRD US-25-P1 AC2, US-29-P2 AC1): duty and levy per tonne for every product the change set
 * touches, on one date, with the published data and with the set applied.
 */
export async function impactPreview(q: Queryable, items: (CandidateItem & { before: EntityData | null })[], date: string): Promise<ImpactRow[]> {
  const published = await CandidateState.load(q);
  const candidate = await CandidateState.load(q, items);
  return compareCharges(published, candidate, affectedProducts([published, candidate], items), date);
}
