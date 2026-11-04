import { crc32, deflateRawSync } from 'node:zlib';

/** A number written as an exact decimal string; a numeric cell in XLSX. */
export interface Num {
  num: string;
}
export type Cell = string | Num | null;

/** A table with a block of labelled facts above it (as-of date, version, user, disclaimer — US-47-P1 AC1). */
export interface Sheet {
  name: string;
  title: string;
  meta: [string, string][];
  header: string[];
  rows: Cell[][];
  /** Totals and similar rows after the table. */
  footer?: Cell[][];
  /** Column widths in characters. */
  widths?: number[];
}

export const num = (v: string | null | undefined): Cell => (v === null || v === undefined ? null : { num: v });

/**
 * US-47-N1 AC2: text starting with = + - @ (or a tab or carriage return, which some spreadsheets also treat as a
 * formula start) gets a leading apostrophe, so it is never evaluated.
 */
export function safeText(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function rowsOf(sheet: Sheet): Cell[][] {
  return [
    [sheet.title],
    ...sheet.meta.map(([k, v]): Cell[] => [k, v]),
    [],
    sheet.header,
    ...sheet.rows,
    ...(sheet.footer ?? []),
  ];
}

// ---------------------------------------------------------------- CSV

/** RFC 4180 with CRLF and a UTF-8 BOM so spreadsheet programs read accents correctly. */
export function toCsv(sheet: Sheet): Buffer {
  const field = (c: Cell) => {
    const s = c === null ? '' : typeof c === 'string' ? safeText(c) : c.num;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = rowsOf(sheet).map((r) => r.map(field).join(',')).join('\r\n') + '\r\n';
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
}

// ---------------------------------------------------------------- XLSX (Office Open XML, one sheet)

const xml = (s: string) =>
  s.replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function column(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function toXlsx(sheet: Sheet): Buffer {
  const headerRow = sheet.meta.length + 3; // 1-based: title, meta, blank, header
  return toWorkbook([{
    name: sheet.name,
    rows: rowsOf(sheet),
    headerRow,
    boldRows: [1, headerRow],
    wrapRows: sheet.meta.map((_, i) => i + 2),
    filterRows: sheet.rows.length ? [headerRow, headerRow + sheet.rows.length] : undefined,
    columns: sheet.header.length,
    widths: sheet.widths,
  }]);
}

/** One sheet of a workbook: plain rows plus layout hints (1-based row numbers). */
export interface WorkbookSheet {
  name: string;
  rows: Cell[][];
  /** Rows above and including this one stay visible when scrolling. */
  headerRow?: number;
  boldRows?: number[];
  /** Rows whose second cell wraps (long labelled values). */
  wrapRows?: number[];
  /** First and last row of the range that gets a filter. */
  filterRows?: [number, number];
  columns?: number;
  widths?: number[];
}

/** An Office Open XML workbook with inline strings (no shared-string table) and three cell styles. */
export function toWorkbook(sheets: WorkbookSheet[]): Buffer {
  const parts = sheets.map((sheet, index) => {
    const bold = new Set(sheet.boldRows ?? []);
    const wrap = new Set(sheet.wrapRows ?? []);
    const columns = sheet.columns ?? Math.max(1, ...sheet.rows.map((r) => r.length));
    // Styles: 0 normal, 1 bold, 2 wrapped text.
    const body = sheet.rows.map((r, ri) => {
      const rowNo = ri + 1;
      const style = bold.has(rowNo) ? ' s="1"' : '';
      const cells = r.map((c, ci) => {
        const ref = `${column(ci)}${rowNo}`;
        if (c === null) return '';
        if (typeof c !== 'string') return `<c r="${ref}"${style}><v>${xml(c.num)}</v></c>`;
        const cellStyle = style || (wrap.has(rowNo) && ci === 1 ? ' s="2"' : '');
        return `<c r="${ref}" t="inlineStr"${cellStyle}><is><t xml:space="preserve">${xml(safeText(c))}</t></is></c>`;
      }).join('');
      return `<row r="${rowNo}">${cells}</row>`;
    }).join('');
    const widths = (sheet.widths ?? Array.from({ length: columns }, () => 16))
      .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const lastCol = column(columns - 1);
    const filter = sheet.filterRows ? { from: sheet.filterRows[0], to: sheet.filterRows[1] } : null;
    const pane = sheet.headerRow
      ? `<sheetViews><sheetView workbookViewId="0"${index === 0 ? ' tabSelected="1"' : ''}><pane ySplit="${sheet.headerRow}" ` +
        `topLeftCell="A${sheet.headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
      : '';
    const worksheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `${pane}<cols>${widths}</cols><sheetData>${body}</sheetData>` +
      (filter ? `<autoFilter ref="A${filter.from}:${lastCol}${filter.to}"/>` : '') +
      '</worksheet>';
    const name = xml(sheet.name.slice(0, 31));
    const definedName = filter
      ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${index}" hidden="1">'${name}'!$A$${filter.from}:$${lastCol}$${filter.to}</definedName>`
      : '';
    return { worksheet, name, definedName };
  });

  const files: [string, string][] = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      parts.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets>${parts.map((p, i) => `<sheet name="${p.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
      (parts.some((p) => p.definedName) ? `<definedNames>${parts.map((p) => p.definedName).join('')}</definedNames>` : '') +
      '</workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      parts.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${parts.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      '</Relationships>'],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>'],
    ...parts.map((p, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, p.worksheet]),
  ];
  return zip(files.map(([name, text]) => [name, Buffer.from(text, 'utf8')]));
}

// ---------------------------------------------------------------- ZIP (deflate, no data descriptors)

export function zip(entries: [string, Buffer][], when = new Date()): Buffer {
  const dosTime = (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2);
  const dosDate = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, packed);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(dosTime, 12);
    dir.writeUInt16LE(dosDate, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}
