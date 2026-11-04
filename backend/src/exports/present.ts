import type { Charge, ValueUsed } from '../tariffs/charge-engine';

/** Plain-language labels shared by the CSV/XLSX exports and the evidence pack. */

export const BASIS_TEXT: Record<string, string> = {
  BAND_USD_PER_MT: 'USD/MT by price band',
  PCT_OF_REF_PRICE: '% of reference price',
  AD_VALOREM_PCT: '% of Harga Ekspor',
  BAND_PCT: 'Band % of Harga Ekspor',
  FIXED_USD_PER_MT: 'Fixed USD/MT',
  ZERO_LISTED: 'Listed at 0',
};

export const STATUS_TEXT: Record<string, string> = {
  CHARGED: 'Charged',
  LISTED_ZERO: 'Listed at 0',
  NOT_LISTED: 'Not listed',
  MISSING_VALUE: 'Value missing',
  DATA_ERROR: 'Data error',
};

export const CATEGORY_TEXT: Record<string, string> = {
  BOTH: 'Duty and levy', BK_ONLY: 'Duty only', PE_ONLY: 'Levy only', LISTED_ZERO: 'Listed at 0', NOT_LISTED: 'Not listed',
};

/** "PMK 38/2024, Lampiran I, Kelompok II no. 3" — where the charge is printed. */
export function legalReference(c: Charge): string | null {
  if (!c.line) return null;
  const where = [c.line.kelompok && `Kelompok ${c.line.kelompok}`, c.line.itemNo && `no. ${c.line.itemNo}`].filter(Boolean).join(' ');
  return [c.line.regulation, c.line.annexLabel, where].filter(Boolean).join(', ');
}

/** Rate or band applied: "Band 6 (> 930 – 980)", "7.5 %". */
export function rateText(c: Charge): string | null {
  if (c.band) return `Band ${c.band.ordinal}${c.band.label ? ` (${c.band.label})` : ''}${c.basisType === 'BAND_PCT' && c.rate ? `: ${c.rate} %` : ''}`;
  if (c.rate) return `${c.rate} %`;
  return null;
}

/** The reference price or Harga Ekspor a charge used. */
export function priceUsed(c: Charge): ValueUsed | null {
  return c.referencePrice ?? c.hargaEkspor ?? null;
}

export function valueText(v: ValueUsed): string {
  return `${v.seriesCode} ${grouped(v.value)} ${v.unit} (${v.periodFrom} – ${v.periodTo})${v.fallback ? ', previous period' : ''}`;
}

/** Exact decimal with thousands separators; the digits are never rounded (BR-CAL-05). */
export function grouped(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const [int, frac] = value.split('.');
  const sign = int.startsWith('-') ? '-' : '';
  const digits = int.replace('-', '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${digits}${frac ? `.${frac}` : ''}`;
}

/** "2026-10-30 10:15 WIB". */
export function wibDateTime(d: Date | string): string {
  return `${new Date(new Date(d).getTime() + 7 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')} WIB`;
}
