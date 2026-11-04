import Decimal from 'decimal.js';
import { ApiError } from './api-error';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface FieldError {
  field: string;
  message: string;
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Collects every problem in one request so the form can show them together (400 INVALID_INPUT). */
export class Fields {
  constructor(
    private readonly src: Record<string, unknown>,
    private readonly prefix = '',
    readonly errors: FieldError[] = [],
  ) {}

  fail(field: string, message: string): void {
    this.errors.push({ field: this.prefix + field, message });
  }

  /** Trimmed text; null when absent or blank. */
  optText(field: string, max = 1000): string | null {
    const v = this.src[field];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') {
      this.fail(field, 'Must be text.');
      return null;
    }
    const t = v.trim();
    if (t.length > max) this.fail(field, `At most ${max} characters.`);
    return t || null;
  }

  text(field: string, max = 1000): string {
    const t = this.optText(field, max);
    if (t === null) this.fail(field, 'Required.');
    return t ?? '';
  }

  oneOf<T extends string>(field: string, allowed: readonly T[]): T {
    const v = this.src[field];
    if (typeof v !== 'string' || !allowed.includes(v as T)) {
      this.fail(field, `One of ${allowed.join(', ')}.`);
      return allowed[0];
    }
    return v as T;
  }

  optInt(field: string, min: number, max: number): number | null {
    const v = this.src[field];
    if (v === undefined || v === null || v === '') return null;
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
      this.fail(field, `A whole number from ${min} to ${max}.`);
      return null;
    }
    return n;
  }

  int(field: string, min: number, max: number): number {
    const n = this.optInt(field, min, max);
    if (n === null && !this.errors.some((e) => e.field === this.prefix + field)) this.fail(field, 'Required.');
    return n ?? min;
  }

  optNumber(field: string): number | null {
    const v = this.src[field];
    if (v === undefined || v === null || v === '') return null;
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      this.fail(field, 'Must be a number.');
      return null;
    }
    return n;
  }

  /**
   * Exact decimal (money, rates, prices) as a canonical string such as "1234.5"; numbers or strings accepted.
   * Never parsed into a float (Technical Design §4.3.2).
   */
  optDecimal(field: string, opts: DecimalRule = {}): string | null {
    const result = decimalOf(this.src[field], opts);
    if (result !== null && typeof result === 'object') {
      this.fail(field, result.error);
      return null;
    }
    return result;
  }

  bool(field: string, fallback: boolean): boolean {
    const v = this.src[field];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'boolean') {
      this.fail(field, 'Must be true or false.');
      return fallback;
    }
    return v;
  }

  /** Calendar date YYYY-MM-DD (a WIB business date); null when absent. */
  optDate(field: string): string | null {
    const v = this.src[field];
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !isDate(v)) {
      this.fail(field, 'A date as YYYY-MM-DD.');
      return null;
    }
    return v;
  }

  optUuid(field: string): string | null {
    const v = this.src[field];
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !UUID_RE.test(v)) {
      this.fail(field, 'Not a valid reference.');
      return null;
    }
    return v.toLowerCase();
  }

  textList(field: string, maxItems = 50, maxLength = 500): string[] {
    const v = this.src[field];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
      this.fail(field, 'Must be a list of text.');
      return [];
    }
    const list = [...new Set((v as string[]).map((s) => s.trim()).filter(Boolean))];
    if (list.length > maxItems) this.fail(field, `At most ${maxItems} entries.`);
    if (list.some((s) => s.length > maxLength)) this.fail(field, `Each entry at most ${maxLength} characters.`);
    return list;
  }

  list(field: string, maxItems: number): Record<string, unknown>[] {
    const v = this.src[field];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      this.fail(field, 'Must be a list.');
      return [];
    }
    if (v.length > maxItems) this.fail(field, `At most ${maxItems} entries.`);
    return v.slice(0, maxItems).map(asObject);
  }

  /** Fields of one list entry; its errors go to this collector so one throw reports them all. */
  nested(field: string, index: number, src: Record<string, unknown>): Fields {
    return new Fields(src, `${this.prefix}${field}[${index}].`, this.errors);
  }

  throwIfAny(): void {
    if (this.errors.length) {
      throw new ApiError(400, 'INVALID_INPUT', this.errors[0].message, { fields: this.errors });
    }
  }
}

export interface DecimalRule {
  min?: string;
  minExclusive?: boolean;
  max?: string;
  scale?: number;
}

/** Canonical decimal string, null when absent, or the reason it is not acceptable. */
export function decimalOf(v: unknown, opts: DecimalRule = {}): string | null | { error: string } {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'number' && typeof v !== 'string') return { error: 'Must be a number.' };
  let d: Decimal;
  try {
    d = new Decimal(typeof v === 'number' ? String(v) : v.trim().replace(/,/g, ''));
  } catch {
    return { error: 'Must be a number.' };
  }
  if (!d.isFinite()) return { error: 'Must be a number.' };
  const scale = opts.scale ?? 6;
  if (d.decimalPlaces() > scale) return { error: `At most ${scale} decimal places.` };
  if (opts.min !== undefined && (opts.minExclusive ? d.lte(opts.min) : d.lt(opts.min))) {
    return { error: opts.minExclusive ? `Must be more than ${opts.min}.` : `Must be at least ${opts.min}.` };
  }
  if (opts.max !== undefined && d.gt(opts.max)) return { error: `Must be at most ${opts.max}.` };
  return d.toFixed();
}

export function isDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Today's business date in WIB (UTC+7), the date Indonesian regulations use. */
export function wibToday(now = new Date()): string {
  return new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

/** 00:00 WIB at the start of a business date. */
export function wibMidnight(date: string): Date {
  return new Date(`${date}T00:00:00+07:00`);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
