import { api, ApiFailure, Charge, ValueUsed } from './api';

export const CATEGORIES = ['BOTH', 'BK_ONLY', 'PE_ONLY', 'LISTED_ZERO', 'NOT_LISTED'] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_TEXT: Record<Category, string> = {
  BOTH: 'Duty and levy', BK_ONLY: 'Duty only', PE_ONLY: 'Levy only', LISTED_ZERO: 'Listed, zero rate', NOT_LISTED: 'No charge',
};

export interface CatalogueRow {
  productId: string;
  commodityCode: string | null;
  group: string | null;
  itemNoAsPrinted: string | null;
  nameId: string;
  nameEn: string | null;
  hsCodes: { code: string; isEx: boolean }[];
  keySpec: string | null;
  bk: Charge;
  pe: Charge;
  totalUsdPerMt: string | null;
  totalNote: string | null;
  category: Category;
  sharedHs: boolean;
  draftClassification: boolean;
  classificationRegulation: string | null;
}

export interface Facet {
  id: string;
  label: string;
  count: number;
}

export interface CatalogueResponse {
  date: string;
  versionNo: number;
  publishedAt: string | null;
  scheduledApplied: { changeSetId: string; title: string; effectiveAt: string }[];
  notices: string[];
  query: string;
  referencePrices: { seriesId: string; code: string; name: string; kind: string; unit: string; value: ValueUsed | null; bands: { table: string; ordinal: number; label: string | null }[] }[];
  kpis: Record<Category | 'shown' | 'sharedHs', number>;
  facets: { commodity: Facet[]; group: Facet[]; category: Facet[]; regulation: Facet[]; sharedHs: number };
  total: number;
  page: number;
  pageSize: number;
  rows: CatalogueRow[];
  suggestion: string | null;
}

export const getCatalogue = (params: URLSearchParams) => api<CatalogueResponse>(`/catalogue?${params.toString()}`);

export interface CalcLineCharge extends Charge {
  totalUsd: string | null;
}

export interface CalcResult {
  id?: string;
  pebDate: string;
  paymentDate: string;
  versionNo: number;
  isSimulation: boolean;
  refPriceOverride: string | null;
  status: 'COMPLETE' | 'INCOMPLETE';
  lines: {
    ordinal: number;
    productId: string;
    product: string;
    quantityMt: string;
    bk: CalcLineCharge;
    pe: CalcLineCharge;
    totalUsd: string | null;
    fx: ValueUsed | null;
    totalIdr: string | null;
    warnings: string[];
  }[];
  totals: { bkUsd: string | null; peUsd: string | null; usd: string | null; idr: string | null };
  missing: string[];
  disclaimer: string;
  notices?: string[];
  scheduledApplied?: { title: string }[];
  createdAt?: string;
  evidenceId?: string | null;
}

export interface CalcInput {
  lines: { productId: string; quantityMt: string }[];
  pebDate: string;
  paymentDate: string;
  refPriceOverride: string;
}

export const calcProducts = (date: string) =>
  api<{ entityId: string; nameId: string; nameEn: string | null; hsCodes: string[] }[]>(`/calculations/products?date=${date}`);
export const previewCalculation = (input: CalcInput) => api<CalcResult>('/calculations/preview', { method: 'POST', body: input });
export const saveCalculation = (input: CalcInput) => api<CalcResult & { id: string }>('/calculations', { method: 'POST', body: input });
export const listCalculations = () =>
  api<{ id: string; pebDate: string; versionNo: number; isSimulation: boolean; status: string; totalUsd: string | null; totalIdr: string | null; createdAt: string; products: string; evidenceId: string | null }[]>('/calculations');
export const getCalculation = (id: string) => api<CalcResult & { id: string; inputsHash: string; resultHash: string }>(`/calculations/${id}`);
export const verifyCalculation = (id: string) =>
  api<{ match: boolean; inputsIntact: boolean; versionNo: number; storedResultHash: string; replayedResultHash: string }>(`/calculations/${id}/verify`);

/** CSV/XLSX download links (FR-EXP-01); the browser sends the session cookie, so a plain link works. */
export function exportUrl(path: 'catalogue' | `calculations/${string}`, format: 'csv' | 'xlsx', params = new URLSearchParams()): string {
  const q = new URLSearchParams(params);
  q.delete('page');
  q.delete('pageSize');
  q.set('format', format);
  return `/api/exports/${path}?${q.toString()}`;
}

export interface ExportJob {
  id: string;
  kind: string;
  format: 'csv' | 'xlsx';
  status: 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED' | 'EXPIRED';
  versionNo: number;
  date: string;
  search: string | null;
  rowCount: number | null;
  fileName: string | null;
  byteSize: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
}

export const listExportJobs = () => api<ExportJob[]>('/exports/jobs');
export const getExportJob = (id: string) => api<ExportJob>(`/exports/jobs/${id}`);
export const exportJobFileUrl = (id: string) => `/api/exports/jobs/${id}/file`;

/**
 * Downloads the catalogue export; above the synchronous limit the API refuses with EXPORT_TOO_LARGE and the export
 * is queued as a job instead (US-47-N1 AC3), whose owner is notified when the file is ready.
 */
export async function exportCatalogue(format: 'csv' | 'xlsx', params: URLSearchParams):
  Promise<{ queued: false } | { queued: true; job: ExportJob; rows: number }> {
  const res = await fetch(exportUrl('catalogue', format, params), { credentials: 'same-origin' });
  if (res.ok) {
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `ecr-catalogue.${format}`;
    const href = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
    return { queued: false };
  }
  const e = (await res.json().catch(() => ({}))).error ?? {};
  if (e.code !== 'EXPORT_TOO_LARGE') throw new ApiFailure(res.status, e.code ?? 'ERROR', e.message ?? `Export failed (${res.status})`, e.details);
  const query = Object.fromEntries([...params].filter(([k]) => k !== 'page' && k !== 'pageSize'));
  const job = await api<ExportJob>('/exports/jobs', { method: 'POST', body: { format, query } });
  return { queued: true, job, rows: e.details?.rows ?? 0 };
}

export interface EvidencePack {
  evidenceId: string;
  calculationId: string;
  contentSha256: string;
  pdfSha256: string;
  byteSize: number;
  pdfaProfile: string;
  createdAt: string;
  retainUntil: string;
  verifyUrl: string;
}

export interface EvidenceCheck {
  evidenceId: string;
  valid: boolean;
  checks: { pdfIntact: boolean; payloadIntact: boolean; replayMatch: boolean };
  pdfSha256: string;
  contentSha256: string;
  byteSize: number;
  createdAt: string;
  createdBy: string;
  versionNo: number;
  pebDate: string;
  paymentDate: string;
  lines: { product: string; quantityMt: string; totalUsd: string | null }[];
  totals: { bkUsd: string | null; peUsd: string | null; usd: string | null; idr: string | null };
  canDownload: boolean;
}

export const createEvidence = (calculationId: string) =>
  api<EvidencePack & { created: boolean }>(`/calculations/${calculationId}/evidence`, { method: 'POST' });
export const verifyEvidence = (evidenceId: string) => api<EvidenceCheck>(`/evidence/${encodeURIComponent(evidenceId)}/verify`);
export const evidenceFileUrl = (evidenceId: string) => `/api/evidence/${encodeURIComponent(evidenceId)}/file`;
