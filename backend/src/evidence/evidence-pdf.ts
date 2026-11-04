import { BASIS_TEXT, grouped, STATUS_TEXT, wibDateTime } from '../exports/present';
import { MUTED, PdfLayout, WIDTH } from './pdf-layout';

/** Everything the evidence pack prints; its canonical SHA-256 is printed in every page footer. */
export interface EvidencePayload {
  evidenceId: string;
  generatedAt: string;
  generatedBy: { name: string; email: string };
  verifyUrl: string;
  calculation: {
    id: string;
    savedAt: string;
    pebDate: string;
    paymentDate: string;
    versionNo: number;
    versionPublishedAt: string | null;
    status: string;
    inputsSha256: string;
    resultSha256: string;
  };
  lines: {
    ordinal: number;
    product: string;
    hsCodes: string[];
    classification: string | null;
    quantityMt: string;
    bk: EvidenceCharge;
    pe: EvidenceCharge;
    totalUsd: string | null;
    fx: { seriesCode: string; value: string; periodFrom: string; periodTo: string; sourceReference: string | null } | null;
    totalIdr: string | null;
    warnings: string[];
  }[];
  totals: { bkUsd: string | null; peUsd: string | null; usd: string | null; idr: string | null };
  referenceValues: { seriesCode: string; periodFrom: string; periodTo: string; value: string; unit: string; sourceReference: string | null; fallback: boolean }[];
  legalReferences: { chargeType: string; regulation: string | null; annex: string | null; kelompok: string | null; itemNo: string | null; uraian: string }[];
  sources: { title: string; docNumber: string | null; docDate: string | null; officialUrl: string | null; publisher: string | null; sha256: string }[];
  missing: string[];
  disclaimer: string;
}

export interface EvidenceCharge {
  status: string;
  basis: string | null;
  rateOrBand: string | null;
  usdPerMt: string | null;
  totalUsd: string | null;
  legalReference: string | null;
  message: string | null;
}

/** Lays the payload out on A4 pages and returns the PDF/A-2b file. */
export function renderEvidencePdf(p: EvidencePayload, payloadSha256: string): Buffer {
  const out = new PdfLayout();
  const paragraph = out.paragraph.bind(out);
  const heading = out.heading.bind(out);
  const table = out.table.bind(out);
  const facts = out.facts.bind(out);
  const usd = (v: string | null) => (v === null ? 'n/a' : grouped(v));
  const charge = (c: EvidenceCharge) => c.status === 'CHARGED' ? usd(c.usdPerMt) : STATUS_TEXT[c.status] ?? c.status;

  out.title('Export charge evidence pack', p.evidenceId,
    'Export Charges Registry (ECR) — Indonesian export duty (Bea Keluar, BK) and export levy (Pungutan Ekspor, PE)');

  facts([
    ['Evidence ID', p.evidenceId],
    ['Generated', `${wibDateTime(p.generatedAt)} by ${p.generatedBy.name} <${p.generatedBy.email}>`],
    ['Calculation', `${p.calculation.id}, saved ${wibDateTime(p.calculation.savedAt)}`],
    ['PEB date (duty and levy)', p.calculation.pebDate],
    ['Payment date (KMK rate)', p.calculation.paymentDate],
    ['Data version', `${p.calculation.versionNo}${p.calculation.versionPublishedAt ? `, published ${wibDateTime(p.calculation.versionPublishedAt)}` : ''}`],
    ['Status', p.calculation.status === 'COMPLETE' ? 'Complete' : 'Incomplete'],
  ]);

  heading('Shipment');
  table(
    [
      { title: '#', width: 18 }, { title: 'Product and HS codes', width: 150 }, { title: 'Quantity MT', width: 52, align: 'right' },
      { title: 'BK USD/MT', width: 50, align: 'right' }, { title: 'BK USD', width: 58, align: 'right' },
      { title: 'PE USD/MT', width: 50, align: 'right' }, { title: 'PE USD', width: 58, align: 'right' },
      { title: 'Total USD', width: 75, align: 'right' },
    ],
    [
      ...p.lines.map((l) => [String(l.ordinal), `${l.product}\nHS ${l.hsCodes.join(', ') || '—'}`, grouped(l.quantityMt), charge(l.bk),
        usd(l.bk.totalUsd), charge(l.pe), usd(l.pe.totalUsd), usd(l.totalUsd)]),
      ['', 'Total', '', '', usd(p.totals.bkUsd), '', usd(p.totals.peUsd), usd(p.totals.usd)],
    ],
    7.5,
    true,
  );
  facts([
    ['Total USD', usd(p.totals.usd)],
    ['Total IDR', p.totals.idr === null ? 'n/a' : `${grouped(p.totals.idr)} (rounded half up to whole rupiah, BR-CAL-05)`],
  ]);

  heading('How each charge was determined');
  for (const l of p.lines) {
    paragraph(`${l.ordinal}. ${l.product} — ${grouped(l.quantityMt)} MT`, 8.5, { bold: true });
    if (l.classification) paragraph(`Classified under ${l.classification}.`, 8, { indent: 12 });
    for (const [name, c] of [['Duty (BK)', l.bk], ['Levy (PE)', l.pe]] as const) {
      const parts = [
        STATUS_TEXT[c.status] ?? c.status,
        c.basis && (BASIS_TEXT[c.basis] ?? c.basis),
        c.rateOrBand,
        c.status === 'CHARGED' && c.usdPerMt !== null && `USD ${grouped(c.usdPerMt)}/MT × ${grouped(l.quantityMt)} MT = USD ${usd(c.totalUsd)}`,
        c.legalReference && `per ${c.legalReference}`,
        c.message,
      ].filter(Boolean);
      paragraph(`${name}: ${parts.join('; ')}.`, 8, { indent: 12 });
    }
    if (l.fx) {
      paragraph(`IDR: KMK ${l.fx.seriesCode} ${grouped(l.fx.value)} IDR/USD (${l.fx.periodFrom} – ${l.fx.periodTo})` +
        `${l.fx.sourceReference ? `, ${l.fx.sourceReference}` : ''}; line IDR ${l.totalIdr === null ? 'n/a' : grouped(l.totalIdr)} before rounding.`, 8, { indent: 12 });
    }
    for (const w of l.warnings) paragraph(`Note: ${w}`, 8, { indent: 12, color: MUTED });
    out.y -= 3;
  }

  if (p.referenceValues.length) {
    heading('Reference values used');
    table(
      [{ title: 'Series', width: 80 }, { title: 'Period', width: 110 }, { title: 'Value', width: 90, align: 'right' }, { title: 'Decree', width: WIDTH - 280 }],
      p.referenceValues.map((v) => [v.seriesCode, `${v.periodFrom} – ${v.periodTo}${v.fallback ? ' (previous period)' : ''}`,
        `${grouped(v.value)} ${v.unit}`, v.sourceReference ?? '—']),
    );
  }

  if (p.legalReferences.length) {
    heading('Legal references');
    table(
      [{ title: 'Charge', width: 40 }, { title: 'Regulation and annex', width: 150 }, { title: 'Item', width: 70 }, { title: 'Description as printed (uraian)', width: WIDTH - 260 }],
      p.legalReferences.map((r) => [r.chargeType, [r.regulation, r.annex].filter(Boolean).join(', ') || '—',
        [r.kelompok && `Kelompok ${r.kelompok}`, r.itemNo && `no. ${r.itemNo}`].filter(Boolean).join(' ') || '—', r.uraian]),
    );
  }

  if (p.sources.length) {
    heading('Official source documents');
    table(
      [{ title: 'Document', width: 170 }, { title: 'Official URL', width: 150 }, { title: 'SHA-256 of the stored file', width: WIDTH - 320 }],
      p.sources.map((s) => [[s.docNumber, s.title, s.docDate].filter(Boolean).join(' — ') + (s.publisher ? ` (${s.publisher})` : ''),
        s.officialUrl ?? '—', s.sha256]),
      7,
    );
  }

  if (p.missing.length) {
    heading('Missing values');
    for (const m of p.missing) paragraph(`• ${m}`);
  }

  heading('Integrity and verification');
  facts([
    ['Inputs SHA-256', p.calculation.inputsSha256],
    ['Result SHA-256', p.calculation.resultSha256],
    ['Content SHA-256', payloadSha256],
    ['Verify', p.verifyUrl],
  ]);
  paragraph('The content hash covers everything printed in this pack. Open the verification link while signed in to ECR: it ' +
    'checks the stored pack, replays the calculation at the data version shown and lets you compare this file with the original.', 8, { color: MUTED });

  heading('Disclaimer');
  paragraph(p.disclaimer, 8);

  return out.finish([`${p.evidenceId} · Content SHA-256 ${payloadSha256}`, `Verify: ${p.verifyUrl}`], {
    title: `ECR evidence pack ${p.evidenceId}`,
    identifier: p.evidenceId,
    description: `Content SHA-256 ${payloadSha256}; verify at ${p.verifyUrl}`,
    createdAt: new Date(p.generatedAt),
  });
}
