import { inflateRawSync } from 'node:zlib';

/**
 * A strict, small reader for .xlsx uploads (PRD L2-3.6, US-28-N1). It reads cell values only and refuses what an
 * import never needs: macros, DTDs (entity expansion, external entities), oversized or over-compressed archives.
 * Formula cells are reported, never evaluated.
 */

export class XlsxError extends Error {}

export interface XlsxCell {
  /** Text as stored; numbers as written in the file, booleans as "TRUE"/"FALSE". */
  value: string;
  kind: 'text' | 'number' | 'bool';
  /** The cell holds a formula (US-28-N1 AC3 rejects these). */
  formula: boolean;
}

/** Sheet name → row number (1-based) → column letter → cell. */
export type Workbook = Map<string, Map<number, Map<string, XlsxCell>>>;

const MAX_ENTRIES = 300;
const MAX_ENTRY_BYTES = 40 * 1024 * 1024;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;

function unzip(buf: Buffer): Map<string, Buffer> {
  // End of central directory: the last 22+ bytes; search backwards past an optional comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError('The file is not a valid .xlsx workbook.');
  const count = buf.readUInt16LE(eocd + 10);
  if (count > MAX_ENTRIES) throw new XlsxError('The workbook has too many parts.');
  let at = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new XlsxError('The workbook is damaged.');
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30);
    const comment = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extra + comment;

    if (flags & 0x0001) throw new XlsxError('Encrypted workbooks are not accepted.');
    if (/vbaProject\.bin$/i.test(name)) throw new XlsxError('Workbooks with macros are not accepted.');
    if (name.includes('..') || name.startsWith('/')) throw new XlsxError('The workbook is damaged.');
    if (size > MAX_ENTRY_BYTES || (total += size) > MAX_TOTAL_BYTES) throw new XlsxError('The workbook is too large when unpacked.');
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;

    if (buf.readUInt32LE(local) !== 0x04034b50) throw new XlsxError('The workbook is damaged.');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compressed);
    let body: Buffer;
    if (method === 0) body = Buffer.from(data);
    else if (method === 8) {
      try {
        body = inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
      } catch {
        throw new XlsxError('The workbook is damaged or too large when unpacked.');
      }
    } else throw new XlsxError('The workbook uses an unsupported compression method.');
    if (body.length !== size) throw new XlsxError('The workbook is damaged.');
    out.set(name, body);
  }
  return out;
}

function decode(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    // OOXML escapes control characters as _xHHHH_.
    .replace(/_x([0-9a-f]{4})_/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** The text of a string item: every <t> run, without phonetic hints. */
function stringItem(xml: string): string {
  return [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join('');
}

export function readWorkbook(file: Buffer): Workbook {
  const parts = unzip(file);
  for (const [name, body] of parts) {
    if (/<!DOCTYPE/i.test(body.toString('utf8', 0, Math.min(body.length, 4096)))) throw new XlsxError(`The workbook part ${name} is not accepted.`);
  }
  const text = (name: string) => parts.get(name)?.toString('utf8');
  const workbook = text('xl/workbook.xml');
  const rels = text('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) throw new XlsxError('The file is not a valid .xlsx workbook.');

  const targets = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id') ?? '', attr(m[0], 'Target') ?? '']));
  const shared = [...(text('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => stringItem(m[1]));

  const book: Workbook = new Map();
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decode(attr(m[0], 'name') ?? '');
    const target = targets.get(attr(m[0], 'r:id') ?? '') ?? '';
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const xml = text(path);
    if (!xml) continue;
    const rows = new Map<number, Map<string, XlsxCell>>();
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[0], 'r') ?? '';
      const at = /^([A-Z]+)(\d+)$/.exec(ref);
      if (!at) continue;
      const body = c[2] ?? '';
      const type = attr(`<c${c[1]}>`, 't');
      const formula = /<f\b/.test(body);
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let cell: XlsxCell | null = null;
      if (type === 's' && v !== undefined) cell = { value: shared[Number(v)] ?? '', kind: 'text', formula };
      else if (type === 'inlineStr') cell = { value: stringItem(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? ''), kind: 'text', formula };
      else if (type === 'str') cell = { value: decode(v ?? ''), kind: 'text', formula };
      else if (type === 'b') cell = { value: v === '1' ? 'TRUE' : 'FALSE', kind: 'bool', formula };
      else if (type === 'e') cell = { value: decode(v ?? ''), kind: 'text', formula };
      else if (v !== undefined) cell = { value: v, kind: 'number', formula };
      else if (formula) cell = { value: '', kind: 'text', formula };
      if (!cell) continue;
      const rowNo = Number(at[2]);
      if (!rows.has(rowNo)) rows.set(rowNo, new Map());
      rows.get(rowNo)!.set(at[1], cell);
    }
    book.set(name, rows);
  }
  return book;
}

/** Column letter for a 0-based index (A, B, …, Z, AA). */
export function columnLetter(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
