/**
 * Readers for new regulations ECR drafts by itself for a Checker: the BPK page of a regulation (its details and PDF),
 * the regulation's own text (number, what it amends or revokes, when it takes effect) and the two palm tables a PMK
 * can carry — the export duty (bea keluar) table with its CPO price bands, and the plantation fund levy (pungutan
 * ekspor) table. Every reader returns null rather than guess when the wording it relies on is missing.
 */
import { flat, idDate } from './official-values';

const decode = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const plain = (html: string) => flat(decode(html.replace(/<[^>]+>/g, ' ')));
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// ------------------------------------------------------------------ BPK regulation page

export interface BpkRegulation {
  /** Short form as BPK writes it: PMK, PERMENDAG, PERMENPERIN, … */
  regType: string;
  number: string;
  year: number;
  title: string;
  issuer: string | null;
  enactedOn: string | null;
  promulgatedOn: string | null;
  effectiveOn: string | null;
  status: string | null;
  pdfUrl: string | null;
}

/** A peraturan.bpk.go.id/Details page: its fields (Judul, Nomor, Tahun, dates, Status) and the PDF to download. */
export function parseBpkRegulation(html: string): BpkRegulation | null {
  const field = (name: string) => {
    const m = new RegExp(String.raw`fw-bold">\s*${name}\s*<\/div>\s*<div[^>]*>([\s\S]*?)<\/div>`).exec(html);
    return m ? plain(m[1]) : null;
  };
  const regType = field('Bentuk Singkat');
  const number = field('Nomor');
  const year = Number(field('Tahun'));
  const title = field('Judul');
  if (!regType || !number || !year || !title) return null;
  const date = (name: string) => { const v = field(name); return v ? idDate(v) : null; };
  const pdf = /href="(\/Download\/\d+\/[^"]+\.pdf)"/i.exec(html);
  return {
    regType: regType.toUpperCase(), number, year, title, issuer: field('T\.E\.U\.')?.replace(/^Indonesia,\s*/i, '') ?? null,
    enactedOn: date('Tanggal Penetapan'), promulgatedOn: date('Tanggal Pengundangan'), effectiveOn: date('Tanggal Berlaku'),
    status: field('Status'), pdfUrl: pdf ? `https://peraturan.bpk.go.id${pdf[1]}` : null,
  };
}

// ------------------------------------------------------------------ the regulation's own text

export interface RegulationRef {
  regType: string;
  number: string;
  year: number;
}

export interface RegulationText {
  regType: string;
  number: string;
  year: number;
  /** "Perubahan atas Peraturan Menteri Keuangan Nomor 69 Tahun 2025 …" → that regulation. */
  amends: RegulationRef[];
  /** Regulations it declares no longer in force ("dicabut dan dinyatakan tidak berlaku"). */
  revokes: RegulationRef[];
  /** How the start is stated: a date, or a number of days after promulgation (counted from BPK's Tanggal Pengundangan). */
  effective: { on: string } | { daysAfterPromulgation: number } | { onPromulgation: true } | null;
}

const FORMS: [RegExp, string][] = [
  [/Peraturan Menteri Keuangan/i, 'PMK'],
  [/Peraturan Menteri Perdagangan/i, 'PERMENDAG'],
  [/Peraturan Menteri Perindustrian/i, 'PERMENPERIN'],
  [/Peraturan Pemerintah/i, 'PP'],
];
const formOf = (s: string) => FORMS.find(([re]) => re.test(s))?.[1] ?? null;
const REF = /(Peraturan Menteri Keuangan|Peraturan Menteri Perdagangan|Peraturan Menteri Perindustrian|Peraturan Pemerintah)\s+Nomor\s+([0-9]+)(?:\/[A-Z.0-9]+)?\s+Tahun\s+(\d{4})/gi;
const WORDS: Record<string, number> = { satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5, enam: 6, tujuh: 7, delapan: 8, sembilan: 9, sepuluh: 10, empat_belas: 14, tiga_puluh: 30 };

export function parseRegulationText(raw: string): RegulationText | null {
  // Page numbers ("- 1 -") can come before the heading.
  const t = flat(raw).replace(/^(?:- \d+ - )+/, '');
  const head = /^(?:SALINAN )?(PERATURAN MENTERI KEUANGAN|PERATURAN MENTERI PERDAGANGAN|PERATURAN MENTERI PERINDUSTRIAN|PERATURAN PEMERINTAH) REPUBLIK INDONESIA NOMOR ([0-9]+)(?:\/[A-Z.0-9]+)? TAHUN (\d{4}) TENTANG (.{0,600}?) DENGAN RAHMAT TUHAN/i.exec(t);
  if (!head) return null;
  const regType = formOf(head[1])!;
  const refs = (s: string) => [...s.matchAll(REF)].map((m) => ({ regType: formOf(m[1])!, number: m[2], year: Number(m[3]) }));
  const subject = head[4];
  const amends = /^PERUBAHAN (?:KEDUA |KETIGA |KEEMPAT )?ATAS /i.test(subject) ? refs(subject).slice(0, 1) : [];

  const revokes: RegulationRef[] = [];
  for (const m of t.matchAll(/((?:Peraturan [^.;]{5,200}?Tahun \d{4}[^.;]{0,300}?)(?:,| dan)?\s*)dicabut dan dinyatakan tidak berlaku/gi)) {
    for (const r of refs(m[1])) if (!revokes.some((x) => x.number === r.number && x.year === r.year && x.regType === r.regType)) revokes.push(r);
  }

  let effective: RegulationText['effective'] = null;
  const start = /Peraturan (?:Menteri|Pemerintah) ini mulai berlaku (?:pada tanggal (\d{1,2} [A-Za-z]+ \d{4})|setelah (\d+) \(([a-z ]+)\) hari terhitung sejak tanggal diundangkan|pada tanggal diundangkan)/i.exec(t);
  if (start?.[1] && idDate(start[1])) effective = { on: idDate(start[1])! };
  else if (start?.[2]) {
    const days = Number(start[2]);
    const spelled = WORDS[start[3].trim().toLowerCase().replace(/\s+/g, '_')];
    if (!spelled || spelled === days) effective = { daysAfterPromulgation: days };
  } else if (start) effective = { onPromulgation: true };

  return { regType, number: head[2], year: Number(head[3]), amends, revokes, effective };
}

/** The start date from the text's rule and BPK's Tanggal Pengundangan. */
export function effectiveDate(text: RegulationText, promulgatedOn: string | null): string | null {
  const e = text.effective;
  if (!e) return null;
  if ('on' in e) return e.on;
  if (!promulgatedOn) return null;
  return 'daysAfterPromulgation' in e ? addDays(promulgatedOn, e.daysAfterPromulgation) : promulgatedOn;
}

// ------------------------------------------------------------------ palm tables

export interface TableBand {
  lowerExclusive: string | null;
  upperInclusive: string | null;
  label: string;
}

export interface DutyLine {
  kelompok: string;
  no: number;
  uraian: string;
  hs: string[];
  amounts: number[];
}

export interface DutyTable {
  annexLabel: string;
  bands: TableBand[];
  lines: DutyLine[];
}

export type LevyBasis = 'ZERO_LISTED' | 'FIXED_USD_PER_MT' | 'PCT_OF_REF_PRICE';

export interface LevyLine {
  kelompok: string;
  no: number;
  uraian: string;
  hs: string[];
  basis: LevyBasis;
  value: string | null;
}

export interface LevyTable {
  annexLabel: string;
  lines: LevyLine[];
}

const KELOMPOK = /^(?:I|II|III|IV|V|VI|VII|VIII)[a-z]?$/;
const HS = /(?:ex\s+)?\d{4}\.\d{2}\.\d{2}/g;
const PAGE = /^- \d+ -$/;

/** The lines of one annex section: from its heading to the next lettered section or the signature. */
function section(raw: string, heading: RegExp): { letter: string; lines: string[] } | null {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return null;
  const letter = /^([A-Z])\./.exec(lines[start])?.[1] ?? '';
  let end = lines.findIndex((l, i) => i > start && (/^[A-Z]\. [A-Z]{3}/.test(l) || /^MENTERI KEUANGAN REPUBLIK INDONESIA,?$/.test(l)));
  if (end < 0) end = lines.length;
  return { letter, lines: lines.slice(start + 1, end) };
}

/** Rows of a numbered table: { kelompok, no, text } with the row's lines joined. */
function rows(lines: string[], isHeader: (l: string) => boolean) {
  const out: { kelompok: string; no: number; text: string }[] = [];
  let kelompok = '';
  for (const raw of lines) {
    if (PAGE.test(raw) || isHeader(raw)) continue;
    // A rate cell can run into the next row's number on one line ("…bidang Perdagangan34. Biodiesel …").
    for (const l of raw.split(/(?<=[a-z)])(?=\d{1,3}\. [A-Z])/)) {
      if (KELOMPOK.test(l)) { kelompok = l; continue; }
      const start = /^(\d{1,3})\.(?:\s+(.*))?$/.exec(l);
      if (start && kelompok) { out.push({ kelompok, no: Number(start[1]), text: start[2] ?? '' }); continue; }
      if (out.length) out[out.length - 1].text += ` ${l}`;
    }
  }
  return out;
}

const hsList = (text: string) => [...text.matchAll(HS)].map((m) => m[0].replace(/\s+/g, ' '));
/** The words between the HS codes: the main description, then any sub-items, joined with "; ". */
const uraianOf = (text: string) => text.split(HS)
  .flatMap((s) => s.split(/\s*•\s*/))
  // Words broken over a line: "96,5%-" + "volume", "Sawit/" + "Palm".
  .map((s) => flat(s).replace(/(\S)- (?=[a-z])/g, '$1-').replace(/\/ (?=\S)/g, '/'))
  .filter(Boolean).join('; ');

/** PMK export duty annex for palm products: the 17 CPO price bands and each line's US$/MT per band. */
export function parsePalmDutyTable(raw: string): DutyTable | null {
  const s = section(raw, /^[A-Z]\. BESARAN TARIF BEA KELUAR ATAS BARANG EKSPOR BERUPA KELAPA SAWIT/i);
  if (!s) return null;
  // The bands, from the first header: ≤USD680, then ">USDa sampai dengan USDb" …, then >USDz.
  const uppers: string[] = [];
  let last: string | null = null;
  for (const l of s.lines) {
    const le = /^≤\s*USD\s*([\d,]+)$/.exec(l);
    const to = /^USD\s*([\d,]+)$/.exec(l);
    const gt = /^>\s*USD\s*([\d,]+)$/.exec(l);
    if (le && !uppers.length) uppers.push(le[1].replace(/,/g, ''));
    else if (to && uppers.length) uppers.push(to[1].replace(/,/g, ''));
    else if (gt) last = gt[1].replace(/,/g, '');
    if (KELOMPOK.test(l)) break;
  }
  if (uppers.length < 2 || !last || last !== uppers[uppers.length - 1]) return null;
  const bands: TableBand[] = uppers.map((u, i) => ({
    lowerExclusive: i ? uppers[i - 1] : null, upperInclusive: u, label: i ? `${uppers[i - 1]}–${u}` : `≤ ${u}`,
  }));
  bands.push({ lowerExclusive: last, upperInclusive: null, label: `> ${last}` });

  const header = (l: string) => /^(KELOMPOK|NO\.(?: URAIAN)?|URAIAN|TERMASUK|DALAM|POS TARIF|TARIF BEA KELUAR.*|TURUNANNYA|sampai|dengan)$/i.test(l)
    || /^(≤|>)?\s*USD\s*[\d,]+$/.test(l) || l === Array.from({ length: bands.length }, (_, i) => i + 1).join(' ');
  const amountsRun = new RegExp(String.raw`(?:^|\s)((?:\d{1,5}\s+){${bands.length - 1}}\d{1,5})(?=\s|$)`);
  const lines: DutyLine[] = [];
  for (const r of rows(s.lines, header)) {
    const run = amountsRun.exec(r.text);
    if (!run) return null;
    const rest = r.text.slice(0, run.index) + ' ' + r.text.slice(run.index + run[0].length);
    lines.push({ kelompok: r.kelompok, no: r.no, uraian: uraianOf(rest), hs: hsList(rest), amounts: run[1].trim().split(/\s+/).map(Number) });
  }
  if (!lines.length || lines.some((l, i) => l.no !== i + 1 || !l.hs.length)) return null;
  return { annexLabel: s.letter ? `Lampiran ${s.letter}` : 'Lampiran', bands, lines };
}

/** PMK plantation fund levy annex for palm products: each line's fixed US$/MT or % of the CPO reference price. */
export function parsePalmLevyTable(raw: string): LevyTable | null {
  const s = section(raw, /^[A-Z]\. TARIF PUNGUTAN DANA PERKEBUNAN ATAS EKSPOR KELAPA SAWIT/i);
  if (!s) return null;
  const header = (l: string) => /^(Kelompok No\. Jenis Layanan Termasuk|Dalam Pos Tarif Satuan Tarif \(dalam US \$\)|PRODUK TURUNANNYA|DAN\/ATAU PRODUK TURUNANNYA)$/i.test(l);
  const lines: LevyLine[] = [];
  let carried: { basis: LevyBasis; value: string | null } | null = null;
  let kelompok = '';
  for (const r of rows(s.lines, header)) {
    if (r.kelompok !== kelompok) { kelompok = r.kelompok; carried = null; }
    // Unit "Per Metrik Ton", then the rate: a number (US$/MT) or "x% dari Harga Referensi Crude Palm Oil …".
    const unit = /Per Metrik\s+Ton/i.exec(r.text);
    if (!unit) return null;
    const before = r.text.slice(0, unit.index);
    const after = flat(r.text.slice(unit.index + unit[0].length));
    const pct = /^([\d.,]+)\s*%\s*dari Harga Referensi/i.exec(after);
    const fixed = /^([\d.,]+)(?:\s|$)/.exec(after);
    let rate: { basis: LevyBasis; value: string | null } | null;
    if (pct) rate = { basis: 'PCT_OF_REF_PRICE', value: pct[1].replace(',', '.') };
    else if (fixed) rate = Number(fixed[1].replace(',', '.')) === 0 ? { basis: 'ZERO_LISTED', value: null } : { basis: 'FIXED_USD_PER_MT', value: fixed[1].replace(',', '.') };
    else rate = carried; // merged cell: the rate above applies
    if (!rate) return null;
    carried = rate;
    // Sub-items written after the unit (e.g. "Buah Sawit ex 1207.99.90") belong to the row too.
    const tail = after.replace(/^[\d.,]+\s*%\s*dari Harga Referensi Crude Palm Oil Kementerian yang menyelenggarakan urusan pemerintahan di bidang Perdagangan/i, '').replace(/^[\d.,]+(?=\s|$)/, '');
    const text = `${before} ${tail}`;
    lines.push({ kelompok: r.kelompok, no: r.no, uraian: uraianOf(text), hs: hsList(text), ...rate });
  }
  if (!lines.length || lines.some((l, i) => l.no !== i + 1 || !l.hs.length)) return null;
  return { annexLabel: s.letter ? `Lampiran ${s.letter}` : 'Lampiran', lines };
}
