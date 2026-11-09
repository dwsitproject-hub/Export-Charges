/** Text of a PDF, page by page, through Mozilla pdf.js (no fonts rendered, no scripts evaluated). */

// pdf.js is an ES module; compiled to CommonJS this becomes require(), which Node 22 supports for ES modules.
export async function pdfText(body: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(body),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      pages.push(content.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join(''));
    }
    return pages.join('\n');
  } finally {
    await doc.destroy();
  }
}
