import { addDays, Fields } from '../common/fields';

/** Columns every versioned SELECT returns before its `data` object (alias t). */
export const VERSION_COLUMNS = 't.id AS row_id, t.entity_id, t.version_from, t.version_to, t.change_set_id';

/** valid_from / valid_to columns from inclusive API dates (valid_to is exclusive in the database). */
export function validityParams(v: { validFrom: string | null; validTo: string | null }): [string, string | null] {
  return [v.validFrom ?? '-infinity', v.validTo ? addDays(v.validTo, 1) : null];
}

/** The inclusive API dates back from the columns (for SELECTs building the API shape). */
export const VALIDITY_JSON = `'validFrom', CASE WHEN isfinite(t.valid_from) THEN t.valid_from END, 'validTo', t.valid_to - 1`;

export function checkRange(f: Fields, d: { validFrom: string | null; validTo: string | null }): void {
  if (d.validFrom && d.validTo && d.validTo < d.validFrom) f.fail('validTo', 'The end date is before the start date.');
}

/** True when a record with these inclusive dates applies on `date` (open ends allowed). */
export function validOn(v: { validFrom: string | null; validTo: string | null }, date: string): boolean {
  return (!v.validFrom || v.validFrom <= date) && (!v.validTo || date <= v.validTo);
}
