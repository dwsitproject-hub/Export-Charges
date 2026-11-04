import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';

/**
 * A small PDF/A-2b writer for the evidence pack (Technical Design §4.3.3): A4 pages of text, rules and tables in
 * DejaVu Sans, embedded as simple TrueType fonts with WinAnsi encoding, an sRGB output intent and XMP metadata.
 * Only what the evidence pack needs; no images, links, transparency or forms.
 */

// ---------------------------------------------------------------- fonts

const WIN_ANSI_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};
const WIN_ANSI_TO_UNICODE = new Map(Object.entries(WIN_ANSI_HIGH).map(([u, c]) => [c, Number(u)]));
const SUBSTITUTES: Record<string, string> = { '≤': '<=', '≥': '>=', '→': '->', '←': '<-', '\u00a0': ' ', '\u2212': '-' };

function unicodeOf(code: number): number | undefined {
  if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return code;
  return WIN_ANSI_TO_UNICODE.get(code);
}

class TrueTypeFont {
  readonly unitsPerEm: number;
  readonly bbox: [number, number, number, number];
  readonly ascent: number;
  readonly descent: number;
  readonly capHeight: number;
  readonly italicAngle: number;
  private readonly tables = new Map<string, { offset: number; length: number }>();
  private readonly advances: number[] = [];
  private readonly cmap = new Map<number, number>();

  constructor(readonly name: string, readonly data: Buffer) {
    const n = data.readUInt16BE(4);
    for (let i = 0; i < n; i++) {
      const at = 12 + i * 16;
      this.tables.set(data.toString('latin1', at, at + 4), { offset: data.readUInt32BE(at + 8), length: data.readUInt32BE(at + 12) });
    }
    const head = this.table('head');
    this.unitsPerEm = data.readUInt16BE(head + 18);
    const s = (v: number) => Math.round((v * 1000) / this.unitsPerEm);
    this.bbox = [s(data.readInt16BE(head + 36)), s(data.readInt16BE(head + 38)), s(data.readInt16BE(head + 40)), s(data.readInt16BE(head + 42))];
    const hhea = this.table('hhea');
    this.ascent = s(data.readInt16BE(hhea + 4));
    this.descent = s(data.readInt16BE(hhea + 6));
    const os2 = this.table('OS/2');
    this.capHeight = data.readUInt16BE(os2) >= 2 ? s(data.readInt16BE(os2 + 88)) : this.ascent;
    this.italicAngle = data.readInt32BE(this.table('post') + 4) / 65536;

    const numGlyphs = data.readUInt16BE(this.table('maxp') + 4);
    const hMetrics = data.readUInt16BE(hhea + 34);
    const hmtx = this.table('hmtx');
    for (let g = 0; g < numGlyphs; g++) this.advances.push(data.readUInt16BE(hmtx + Math.min(g, hMetrics - 1) * 4));
    this.readCmap();
  }

  private table(tag: string): number {
    const t = this.tables.get(tag);
    if (!t) throw new Error(`${this.name}: no ${tag} table`);
    return t.offset;
  }

  /** The Windows Unicode BMP subtable (3,1), format 4 — the one PDF viewers use for WinAnsi TrueType fonts. */
  private readCmap() {
    const d = this.data;
    const cmap = this.table('cmap');
    const count = d.readUInt16BE(cmap + 2);
    let sub = -1;
    for (let i = 0; i < count; i++) {
      const at = cmap + 4 + i * 8;
      if (d.readUInt16BE(at) === 3 && d.readUInt16BE(at + 2) === 1) sub = cmap + d.readUInt32BE(at + 4);
    }
    if (sub < 0 || d.readUInt16BE(sub) !== 4) throw new Error(`${this.name}: no (3,1) format 4 cmap`);
    const segs = d.readUInt16BE(sub + 6) / 2;
    const ends = sub + 14;
    const starts = ends + segs * 2 + 2;
    const deltas = starts + segs * 2;
    const ranges = deltas + segs * 2;
    for (let i = 0; i < segs; i++) {
      const end = d.readUInt16BE(ends + i * 2);
      const start = d.readUInt16BE(starts + i * 2);
      const delta = d.readInt16BE(deltas + i * 2);
      const rangeAt = ranges + i * 2;
      const range = d.readUInt16BE(rangeAt);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let g: number;
        if (range === 0) g = (c + delta) & 0xffff;
        else {
          g = d.readUInt16BE(rangeAt + range + (c - start) * 2);
          if (g !== 0) g = (g + delta) & 0xffff;
        }
        if (g !== 0) this.cmap.set(c, g);
      }
    }
  }

  glyph(unicode: number): number | undefined {
    return this.cmap.get(unicode);
  }

  /** Width of a WinAnsi code in 1/1000 em (the PDF /Widths unit). */
  width(code: number): number {
    const u = unicodeOf(code);
    const g = u === undefined ? undefined : this.glyph(u);
    return g === undefined ? 0 : Math.round((this.advances[g] * 1000) / this.unitsPerEm);
  }

  /**
   * The font program with the outlines of unused glyphs removed (glyph ids, metrics and cmap unchanged), and only
   * the tables a PDF TrueType font needs. Composite glyphs keep their components.
   */
  subset(codes: Set<number>): Buffer {
    const d = this.data;
    const head = this.table('head');
    const longLoca = d.readInt16BE(head + 50) === 1;
    const loca = this.table('loca');
    const glyf = this.table('glyf');
    const numGlyphs = this.advances.length;
    const offset = (g: number) => (longLoca ? d.readUInt32BE(loca + g * 4) : d.readUInt16BE(loca + g * 2) * 2);

    const keep = new Set<number>([0]);
    const queue = [...codes].map((c) => unicodeOf(c)).map((u) => (u === undefined ? undefined : this.glyph(u)))
      .filter((g): g is number => g !== undefined);
    while (queue.length) {
      const g = queue.pop()!;
      if (keep.has(g) && g !== 0) continue;
      keep.add(g);
      const start = glyf + offset(g);
      if (offset(g + 1) === offset(g) || d.readInt16BE(start) >= 0) continue;
      let at = start + 10;
      for (;;) {
        const flags = d.readUInt16BE(at);
        queue.push(d.readUInt16BE(at + 2));
        at += 4 + (flags & 0x0001 ? 4 : 2) + (flags & 0x0008 ? 2 : flags & 0x0040 ? 4 : flags & 0x0080 ? 8 : 0);
        if (!(flags & 0x0020)) break;
      }
    }

    const glyphs: Buffer[] = [];
    const newLoca = Buffer.alloc((numGlyphs + 1) * 4);
    let pos = 0;
    for (let g = 0; g < numGlyphs; g++) {
      newLoca.writeUInt32BE(pos, g * 4);
      if (!keep.has(g)) continue;
      const body = d.subarray(glyf + offset(g), glyf + offset(g + 1));
      const padded = Buffer.alloc(Math.ceil(body.length / 4) * 4);
      body.copy(padded);
      glyphs.push(padded);
      pos += padded.length;
    }
    newLoca.writeUInt32BE(pos, numGlyphs * 4);

    const out = new Map<string, Buffer>();
    for (const tag of ['cmap', 'cvt ', 'fpgm', 'hhea', 'hmtx', 'maxp', 'OS/2', 'prep']) {
      const t = this.tables.get(tag);
      if (t) out.set(tag, Buffer.from(d.subarray(t.offset, t.offset + t.length)));
    }
    const newHead = Buffer.from(d.subarray(head, head + this.tables.get('head')!.length));
    newHead.writeUInt32BE(0, 8); // checkSumAdjustment, set below
    newHead.writeInt16BE(1, 50); // long loca
    out.set('head', newHead);
    out.set('loca', newLoca);
    out.set('glyf', Buffer.concat(glyphs));
    return assembleFont(out);
  }
}

function checksum(b: Buffer): number {
  const padded = b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b;
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

function assembleFont(tables: Map<string, Buffer>): Buffer {
  const tags = [...tables.keys()].sort();
  const n = tags.length;
  const pow = 2 ** Math.floor(Math.log2(n));
  const header = Buffer.alloc(12 + n * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(n, 4);
  header.writeUInt16BE(pow * 16, 6);
  header.writeUInt16BE(Math.log2(pow), 8);
  header.writeUInt16BE(n * 16 - pow * 16, 10);
  const bodies: Buffer[] = [];
  let offset = header.length;
  let headAt = 0;
  tags.forEach((tag, i) => {
    const data = tables.get(tag)!;
    const at = 12 + i * 16;
    header.write(tag, at, 'latin1');
    header.writeUInt32BE(checksum(data), at + 4);
    header.writeUInt32BE(offset, at + 8);
    header.writeUInt32BE(data.length, at + 12);
    if (tag === 'head') headAt = offset;
    const padded = Buffer.alloc(Math.ceil(data.length / 4) * 4);
    data.copy(padded);
    bodies.push(padded);
    offset += padded.length;
  });
  const font = Buffer.concat([header, ...bodies]);
  font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headAt + 8);
  return font;
}

let fonts: { regular: TrueTypeFont; bold: TrueTypeFont } | null = null;
function loadFonts() {
  if (!fonts) {
    const dir = join(dirname(createRequire(__filename).resolve('dejavu-fonts-ttf/package.json')), 'ttf');
    fonts = {
      regular: new TrueTypeFont('DejaVuSans', readFileSync(join(dir, 'DejaVuSans.ttf'))),
      bold: new TrueTypeFont('DejaVuSans-Bold', readFileSync(join(dir, 'DejaVuSans-Bold.ttf'))),
    };
  }
  return fonts;
}

// ---------------------------------------------------------------- sRGB output intent

/** A version 2 sRGB display profile (D50-adapted primaries, sRGB tone curve), built rather than shipped. */
function srgbProfile(): Buffer {
  const s15 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(Math.round(v * 65536));
    return b;
  };
  const xyz = (x: number, y: number, z: number) => Buffer.concat([Buffer.from('XYZ \0\0\0\0', 'latin1'), s15(x), s15(y), s15(z)]);
  const text = (s: string) => Buffer.concat([Buffer.from('text\0\0\0\0', 'latin1'), Buffer.from(`${s}\0`, 'latin1')]);
  const desc = (s: string) => {
    const b = Buffer.alloc(12 + s.length + 1 + 4 + 4 + 2 + 1 + 67);
    b.write('desc', 0, 'latin1');
    b.writeUInt32BE(s.length + 1, 8);
    b.write(s, 12, 'latin1');
    return b;
  };
  const points = 1024;
  const curve = Buffer.alloc(12 + points * 2);
  curve.write('curv', 0, 'latin1');
  curve.writeUInt32BE(points, 8);
  for (let i = 0; i < points; i++) {
    const v = i / (points - 1);
    const linear = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    curve.writeUInt16BE(Math.round(linear * 65535), 12 + i * 2);
  }
  const tags: [string, Buffer][] = [
    ['desc', desc('sRGB IEC61966-2.1')],
    ['cprt', text('No copyright, use freely')],
    ['wtpt', xyz(0.9642, 1.0, 0.8249)],
    ['rXYZ', xyz(0.4360747, 0.2225045, 0.0139322)],
    ['gXYZ', xyz(0.3850649, 0.7168786, 0.0971045)],
    ['bXYZ', xyz(0.1430804, 0.0606169, 0.7141733)],
    ['rTRC', curve],
  ];
  const table = Buffer.alloc(4 + (tags.length + 2) * 12);
  table.writeUInt32BE(tags.length + 2);
  const bodies: Buffer[] = [];
  let offset = 128 + table.length;
  let trcAt = 0;
  tags.forEach(([sig, body], i) => {
    table.write(sig, 4 + i * 12, 'latin1');
    table.writeUInt32BE(offset, 8 + i * 12);
    table.writeUInt32BE(body.length, 12 + i * 12);
    if (sig === 'rTRC') trcAt = offset;
    const padded = Buffer.alloc(Math.ceil(body.length / 4) * 4);
    body.copy(padded);
    bodies.push(padded);
    offset += padded.length;
  });
  // gTRC and bTRC share the red curve's data.
  ['gTRC', 'bTRC'].forEach((sig, j) => {
    const at = 4 + (tags.length + j) * 12;
    table.write(sig, at, 'latin1');
    table.writeUInt32BE(trcAt, at + 4);
    table.writeUInt32BE(curve.length, at + 8);
  });
  const header = Buffer.alloc(128);
  header.writeUInt32BE(offset, 0);
  header.writeUInt32BE(0x02100000, 8);
  header.write('mntrRGB XYZ ', 12, 'latin1');
  [2026, 1, 1, 0, 0, 0].forEach((v, i) => header.writeUInt16BE(v, 24 + i * 2));
  header.write('acsp', 36, 'latin1');
  s15(0.9642).copy(header, 68);
  s15(1.0).copy(header, 72);
  s15(0.8249).copy(header, 76);
  return Buffer.concat([header, table, ...bodies]);
}

// ---------------------------------------------------------------- document

export const A4 = { width: 595.28, height: 841.89 };
export type Rgb = [number, number, number];

interface Page {
  ops: string[];
}

export interface PdfMeta {
  title: string;
  identifier: string;
  description: string;
  createdAt: Date;
}

const pdfString = (s: string) => `(${Buffer.from(s, 'latin1').toString('latin1').replace(/[\\()]/g, '\\$&').replace(/[^\x20-\x7e]/g, '?')})`;
const fmt = (n: number) => (Math.round(n * 100) / 100).toString();
const xmlText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class PdfDocument {
  readonly pages: Page[] = [];
  private readonly used = { regular: new Set<number>(), bold: new Set<number>() };
  private readonly f = loadFonts();

  addPage(): Page {
    const page = { ops: [] };
    this.pages.push(page);
    return page;
  }

  /** Text as WinAnsi codes; characters outside it fall back to a substitute, the unaccented letter, or "?". */
  encode(text: string, bold = false): number[] {
    const font = bold ? this.f.bold : this.f.regular;
    const codes: number[] = [];
    for (const ch of text.normalize('NFC')) {
      const sub = SUBSTITUTES[ch];
      if (sub) {
        codes.push(...this.encode(sub, bold));
        continue;
      }
      const u = ch.codePointAt(0)!;
      let code = (u >= 0x20 && u <= 0x7e) || (u >= 0xa1 && u <= 0xff) ? u : WIN_ANSI_HIGH[u];
      if (code === undefined) {
        const base = ch.normalize('NFD')[0];
        const b = base.codePointAt(0)!;
        code = base !== ch && b >= 0x20 && b <= 0x7e ? b : 0x3f;
      }
      if (font.width(code) === 0 && code !== 0x20) code = 0x3f;
      codes.push(code);
    }
    return codes;
  }

  width(text: string, size: number, bold = false): number {
    const font = bold ? this.f.bold : this.f.regular;
    return (this.encode(text, bold).reduce((w, c) => w + font.width(c), 0) * size) / 1000;
  }

  /** Greedy word wrap; words longer than the line (hashes, URLs) are broken by character. */
  wrap(text: string, maxWidth: number, size: number, bold = false): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split('\n')) {
      let line = '';
      for (const word of paragraph.split(/(?<=\s)/)) {
        if (this.width(line + word, size, bold) <= maxWidth) {
          line += word;
          continue;
        }
        if (line.trim()) lines.push(line.trimEnd());
        line = '';
        for (const ch of word) {
          if (this.width(line + ch, size, bold) > maxWidth && line) {
            lines.push(line);
            line = '';
          }
          line += ch;
        }
      }
      lines.push(line.trimEnd());
    }
    return lines;
  }

  text(page: Page, text: string, x: number, y: number, size: number, opts: { bold?: boolean; color?: Rgb } = {}) {
    const codes = this.encode(text, opts.bold);
    codes.forEach((c) => (opts.bold ? this.used.bold : this.used.regular).add(c));
    const hex = codes.map((c) => c.toString(16).padStart(2, '0')).join('');
    const [r, g, b] = opts.color ?? [0, 0, 0];
    page.ops.push(`BT /${opts.bold ? 'F2' : 'F1'} ${fmt(size)} Tf ${fmt(r)} ${fmt(g)} ${fmt(b)} rg ${fmt(x)} ${fmt(y)} Td <${hex}> Tj ET`);
  }

  rect(page: Page, x: number, y: number, w: number, h: number, fill: Rgb) {
    page.ops.push(`${fill.map(fmt).join(' ')} rg ${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re f`);
  }

  line(page: Page, x1: number, y1: number, x2: number, y2: number, color: Rgb = [0.75, 0.75, 0.75], width = 0.5) {
    page.ops.push(`${color.map(fmt).join(' ')} RG ${fmt(width)} w ${fmt(x1)} ${fmt(y1)} m ${fmt(x2)} ${fmt(y2)} l S`);
  }

  /** Serialises the document as PDF/A-2b. */
  render(meta: PdfMeta): Buffer {
    const objects: Buffer[] = [];
    const add = (body: Buffer | string) => {
      objects.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body);
      return objects.length;
    };
    const stream = (dict: string, data: Buffer, compress = true) => {
      const body = compress ? deflateSync(data) : data;
      return Buffer.concat([
        Buffer.from(`<< ${dict}${compress ? ' /Filter /FlateDecode' : ''} /Length ${body.length} >>\nstream\n`, 'latin1'),
        body,
        Buffer.from('\nendstream', 'latin1'),
      ]);
    };

    // Reserve 1 = catalog, 2 = page tree.
    add('');
    add('');
    const iso = meta.createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const xmp = Buffer.from(
      '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
      '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description>\n' +
      `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:format>application/pdf</dc:format>` +
      `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlText(meta.title)}</rdf:li></rdf:Alt></dc:title>` +
      `<dc:identifier>${xmlText(meta.identifier)}</dc:identifier>` +
      `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlText(meta.description)}</rdf:li></rdf:Alt></dc:description></rdf:Description>\n` +
      `<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><xmp:CreateDate>${iso}</xmp:CreateDate><xmp:ModifyDate>${iso}</xmp:ModifyDate>` +
      `<xmp:MetadataDate>${iso}</xmp:MetadataDate><xmp:CreatorTool>ECR</xmp:CreatorTool></rdf:Description>\n` +
      '<rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/"><pdf:Producer>ECR evidence writer</pdf:Producer></rdf:Description>\n' +
      '</rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>',
      'utf8',
    );
    const metadata = add(stream('/Type /Metadata /Subtype /XML', xmp, false));
    const icc = add(stream('/N 3', srgbProfile()));

    const fontObject = (font: TrueTypeFont, used: Set<number>) => {
      const program = font.subset(used);
      const tag = [...createHash('sha256').update(font.name).update(Buffer.from([...used].sort((a, b) => a - b))).digest()]
        .slice(0, 6).map((b) => String.fromCharCode(65 + (b % 26))).join('');
      const name = `${tag}+${font.name}`;
      const file = add(stream(`/Length1 ${program.length}`, program));
      const descriptor = add(
        `<< /Type /FontDescriptor /FontName /${name} /Flags 32 /FontBBox [${font.bbox.join(' ')}] /ItalicAngle ${font.italicAngle} ` +
        `/Ascent ${font.ascent} /Descent ${font.descent} /CapHeight ${font.capHeight} /StemV 80 /FontFile2 ${file} 0 R >>`,
      );
      const widths = Array.from({ length: 224 }, (_, i) => (used.has(i + 32) ? font.width(i + 32) : 0)).join(' ');
      return add(`<< /Type /Font /Subtype /TrueType /BaseFont /${name} /FirstChar 32 /LastChar 255 /Widths [${widths}] ` +
        `/Encoding /WinAnsiEncoding /FontDescriptor ${descriptor} 0 R >>`);
    };
    const f1 = fontObject(this.f.regular, this.used.regular);
    const f2 = fontObject(this.f.bold, this.used.bold);

    const kids = this.pages.map((p) => {
      const content = add(stream('', Buffer.from(p.ops.join('\n'), 'latin1')));
      return add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] ` +
        `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`);
    });
    objects[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`, 'latin1');
    objects[0] = Buffer.from(
      `<< /Type /Catalog /Pages 2 0 R /Metadata ${metadata} 0 R /Lang (en) /OutputIntents [<< /Type /OutputIntent /S /GTS_PDFA1 ` +
      `/OutputConditionIdentifier ${pdfString('sRGB IEC61966-2.1')} /Info ${pdfString('sRGB IEC61966-2.1')} /DestOutputProfile ${icc} 0 R >>] >>`,
      'latin1',
    );

    const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let length = parts[0].length;
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(length);
      const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
      parts.push(obj);
      length += obj.length;
    });
    const id = createHash('md5').update(meta.identifier).update(Buffer.concat(parts)).digest('hex');
    const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
      offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${length}\n%%EOF\n`;
    parts.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(parts);
  }
}
