import { A4, PdfDocument, PdfMeta, Rgb } from './pdfa';

export const MARGIN = 42;
export const WIDTH = A4.width - 2 * MARGIN;
const FOOTER = 52;
export const INK: Rgb = [0.1, 0.12, 0.16];
export const MUTED: Rgb = [0.38, 0.42, 0.48];
export const ACCENT: Rgb = [0.05, 0.33, 0.27];
const SHADE: Rgb = [0.94, 0.96, 0.95];

export interface Column {
  title: string;
  width: number;
  align?: 'right';
}

/** Flowing A4 layout for ECR's printed records (evidence packs, access review reports): text, headings, tables. */
export class PdfLayout {
  readonly doc = new PdfDocument();
  page = this.doc.addPage();
  y = A4.height - MARGIN;

  newPage(): void {
    this.page = this.doc.addPage();
    this.y = A4.height - MARGIN;
  }

  ensure(height: number): void {
    if (this.y - height < MARGIN + FOOTER) this.newPage();
  }

  /** Large title on the left, an identifier on the right, a subtitle and a rule. */
  title(text: string, id: string, subtitle: string): void {
    const { doc } = this;
    doc.text(this.page, text, MARGIN, this.y - 17, 17, { bold: true, color: INK });
    doc.text(this.page, id, MARGIN + WIDTH - doc.width(id, 8.5, true), this.y - 15, 8.5, { bold: true, color: ACCENT });
    this.y -= 26;
    this.paragraph(subtitle, 8.5, { color: MUTED });
    this.y -= 4;
    doc.line(this.page, MARGIN, this.y, MARGIN + WIDTH, this.y, INK, 1);
    this.y -= 8;
  }

  paragraph(text: string, size = 8.5, opts: { bold?: boolean; color?: Rgb; indent?: number } = {}): void {
    const indent = opts.indent ?? 0;
    for (const line of this.doc.wrap(text, WIDTH - indent, size, opts.bold)) {
      this.ensure(size * 1.35);
      this.doc.text(this.page, line, MARGIN + indent, this.y - size, size, { bold: opts.bold, color: opts.color ?? INK });
      this.y -= size * 1.35;
    }
  }

  /** Room for the heading and the first lines of what follows, so a heading never ends a page. */
  heading(text: string): void {
    this.ensure(90);
    this.y -= 10;
    this.doc.text(this.page, text, MARGIN, this.y - 10.5, 10.5, { bold: true, color: ACCENT });
    this.y -= 15;
    this.doc.line(this.page, MARGIN, this.y, MARGIN + WIDTH, this.y, ACCENT, 0.8);
    this.y -= 5;
  }

  /** A table whose header repeats on each new page; `boldLast` makes the last row a totals row. */
  table(columns: Column[], rows: string[][], size = 7.5, boldLast = false): void {
    const { doc } = this;
    const pad = 3;
    const lead = size * 1.3;
    const drawHeader = () => {
      const lines = columns.map((c) => doc.wrap(c.title, c.width - 2 * pad, size, true));
      const h = Math.max(...lines.map((l) => l.length)) * lead + 2 * pad;
      doc.rect(this.page, MARGIN, this.y - h, WIDTH, h, SHADE);
      let x = MARGIN;
      columns.forEach((c, i) => {
        lines[i].forEach((t, j) => {
          const tx = c.align === 'right' ? x + c.width - pad - doc.width(t, size, true) : x + pad;
          doc.text(this.page, t, tx, this.y - pad - size - j * lead, size, { bold: true, color: INK });
        });
        x += c.width;
      });
      this.y -= h;
    };
    this.ensure(40);
    drawHeader();
    rows.forEach((row, ri) => {
      const bold = boldLast && ri === rows.length - 1;
      const lines = columns.map((c, i) => doc.wrap(row[i] ?? '', c.width - 2 * pad, size, bold));
      const h = Math.max(...lines.map((l) => l.length)) * lead + 2 * pad;
      if (this.y - h < MARGIN + FOOTER) {
        this.newPage();
        drawHeader();
      }
      let x = MARGIN;
      columns.forEach((c, i) => {
        lines[i].forEach((t, j) => {
          const tx = c.align === 'right' ? x + c.width - pad - doc.width(t, size, bold) : x + pad;
          doc.text(this.page, t, tx, this.y - pad - size - j * lead, size, { bold, color: INK });
        });
        x += c.width;
      });
      this.y -= h;
      doc.line(this.page, MARGIN, this.y, MARGIN + WIDTH, this.y);
    });
    this.y -= 4;
  }

  /** Label and value pairs. */
  facts(pairs: [string, string][]): void {
    for (const [label, value] of pairs) {
      const lines = this.doc.wrap(value, WIDTH - 150, 8.5);
      this.ensure(lines.length * 11.5 + 2);
      this.doc.text(this.page, label, MARGIN, this.y - 8.5, 8.5, { color: MUTED });
      lines.forEach((t, j) => this.doc.text(this.page, t, MARGIN + 150, this.y - 8.5 - j * 11.5, 8.5, { color: INK }));
      this.y -= lines.length * 11.5 + 2;
    }
  }

  /** Two footer lines and "Page n of m" on every page, then the PDF/A file. */
  finish(footer: [string, string], meta: PdfMeta): Buffer {
    const { doc } = this;
    doc.pages.forEach((pg, i) => {
      const fy = MARGIN + FOOTER - 18;
      doc.line(pg, MARGIN, fy + 10, MARGIN + WIDTH, fy + 10, MUTED, 0.5);
      doc.text(pg, footer[0], MARGIN, fy, 6.5, { color: MUTED });
      doc.text(pg, footer[1], MARGIN, fy - 9, 6.5, { color: MUTED });
      const n = `Page ${i + 1} of ${doc.pages.length}`;
      doc.text(pg, n, MARGIN + WIDTH - doc.width(n, 6.5), fy - 9, 6.5, { color: MUTED });
    });
    return doc.render(meta);
  }
}
