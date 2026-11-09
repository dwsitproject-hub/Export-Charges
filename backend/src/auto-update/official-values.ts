/**
 * Readers for the two official decrees ECR updates by itself: the monthly CPO reference price (Keputusan Menteri
 * Perdagangan on Harga Patokan Ekspor and Harga Referensi for agricultural and forestry products) and the weekly KMK
 * exchange rate (Keputusan Menteri Keuangan on Nilai Kurs, published by BKF on fiskal.kemenkeu.go.id).
 * Each returns null when the wording it relies on is not found, so a changed layout is never guessed at.
 */

const MONTHS: Record<string, number> = {
  januari: 1, februari: 2, maret: 3, april: 4, mei: 5, juni: 6, juli: 7, agustus: 8, september: 9, oktober: 10, november: 11, desember: 12,
};

/** Whitespace-normalised text, so wording split over lines still matches. */
export const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Indonesian number "18.141,00" or "978,90" → "18141.00" / "978.90"; null when it is not one. */
export function idNumber(s: string): string | null {
  const m = /^\d{1,3}(?:\.\d{3})*(?:,\d+)?$|^\d+(?:,\d+)?$/.exec(s.trim());
  if (!m) return null;
  return s.trim().replace(/\./g, '').replace(',', '.');
}

/** Indonesian date "1 November 2026" / "04 NOVEMBER 2026" → "2026-11-01"; null when it is not a real date. */
export function idDate(s: string): string | null {
  const m = /^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i.exec(flat(s));
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  const iso = `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

const DATE = String.raw`\d{1,2}\s+[A-Za-z]+\s+\d{4}`;

// ------------------------------------------------------------------ CPO reference price (Kepmendag)

export interface DecreeLink {
  url: string;
  number: string;
  year: number;
}

/** JDIH Kemendag listing → the decrees on reference prices of agricultural and forestry products (which include CPO). */
export function parseKemendagAgriDecrees(html: string): DecreeLink[] {
  const out = new Map<string, DecreeLink>();
  for (const m of html.matchAll(/href="(https:\/\/jdih\.kemendag\.go\.id\/peraturan\/(keputusan-menteri-perdagangan[a-z0-9-]*?-nomor-(\d+)-tahun-(\d{4})-tentang-harga-patokan-ekspor-dan-harga-referensi-atas-produk-pertanian-dan-kehutanan[a-z0-9-]*))"/g)) {
    if (!out.has(m[1])) out.set(m[1], { url: m[1], number: m[3], year: Number(m[4]) });
  }
  return [...out.values()].sort((a, b) => b.year - a.year || Number(b.number) - Number(a.number));
}

/** A JDIH Kemendag decree page → the address of its PDF. */
export function parseKemendagPdfUrl(html: string): string | null {
  const m = /(?:https:\/\/jdih\.kemendag\.go\.id\/)?(uploads\/peraturan\/\d{4}\/[A-Za-z0-9_.-]+\.pdf)/.exec(html);
  return m ? `https://jdih.kemendag.go.id/${m[1]}` : null;
}

export interface CpoDecree {
  number: string;
  year: number;
  value: string;
  periodFrom: string;
  periodTo: string;
  quote: string;
}

/** The decree's text → its number, the CPO reference price in US$/MT and the period it applies to. */
export function parseCpoDecree(raw: string): CpoDecree | null {
  const t = flat(raw);
  const head = /KEPUTUSAN MENTERI PERDAGANGAN REPUBLIK INDONESIA NOMOR (\d+) TAHUN (\d{4})/i.exec(t);
  const price = /Harga Referensi Crude Palm Oil yang dikenakan Bea Keluar[^.]{0,120}?sebesar US\$ ?([\d.,]+) ?\/ ?MT/i.exec(t);
  const period = new RegExp(String.raw`berlaku terhitung sejak tanggal (${DATE}) sampai dengan tanggal (${DATE})`, 'i').exec(t);
  if (!head || !price || !period) return null;
  const value = idNumber(price[1].replace(/[.,]$/, ''));
  const periodFrom = idDate(period[1]);
  const periodTo = idDate(period[2]);
  if (!value || !periodFrom || !periodTo || periodTo < periodFrom) return null;
  return { number: head[1], year: Number(head[2]), value, periodFrom, periodTo, quote: `${price[0]} … ${period[0]}` };
}

// ------------------------------------------------------------------ KMK exchange rate (fiskal.kemenkeu.go.id)

export interface KursPage {
  number: string;
  usd: string;
  periodFrom: string;
  periodTo: string;
  pdfUrl: string;
}

/** BKF's Kurs Pajak page → the KMK in force: its number, the USD rate, the period and the decree's PDF. */
export function parseKursPage(html: string): KursPage | null {
  const t = flat(html.replace(/<[^>]+>/g, ' '));
  const number = /KMK Nomor ([0-9]+\/[A-Z.0-9]+\/[A-Z.0-9]+\/\d{4})/i.exec(t);
  const period = new RegExp(String.raw`Tanggal berlaku: (${DATE}) - (${DATE})`, 'i').exec(t);
  const usd = /Dolar Amerika Serikat \(USD\)(?: USD)? ([\d.]+,\d{2})/i.exec(t);
  const pdf = /(?:https:\/\/fiskal\.kemenkeu\.go\.id)?\/?(files\/kurs\/file\/[A-Za-z0-9_.-]+\.pdf)/.exec(html);
  if (!number || !period || !usd || !pdf) return null;
  const periodFrom = idDate(period[1]);
  const periodTo = idDate(period[2]);
  const value = idNumber(usd[1]);
  if (!periodFrom || !periodTo || !value) return null;
  return { number: number[1].toUpperCase(), usd: value, periodFrom, periodTo, pdfUrl: `https://fiskal.kemenkeu.go.id/${pdf[1]}` };
}

export interface KmkDecree {
  number: string;
  usd: string;
  periodFrom: string;
  periodTo: string;
  quote: string;
}

/** The KMK's text → its number, the rupiah per US dollar and the period. */
export function parseKmkDecree(raw: string): KmkDecree | null {
  const t = flat(raw);
  const head = /KEPUTUSAN MENTERI KEUANGAN REPUBLIK INDONESIA NOMOR ([0-9]+\/[A-Z.0-9]+\/[A-Z.0-9]+\/\d{4})/i.exec(t);
  const period = new RegExp(String.raw`periode (${DATE}) sampai dengan (${DATE})`, 'i').exec(t);
  const usd = /Rp ?([\d.]+,\d{2}) ?1,- ?dolar Amerika Serikat \(USD\)/i.exec(t);
  if (!head || !period || !usd) return null;
  const periodFrom = idDate(period[1]);
  const periodTo = idDate(period[2]);
  const value = idNumber(usd[1]);
  if (!periodFrom || !periodTo || !value || periodTo < periodFrom) return null;
  return { number: head[1].toUpperCase(), usd: value, periodFrom, periodTo, quote: `${period[0]} … ${usd[0]}` };
}
