export interface Me {
  user: { id: string; email: string; fullName: string; roles: string[]; permissions: string[]; privileged: boolean; hubSubject: string | null; tourSeenAt: string | null };
  totp: { enabled: boolean; enrolled: boolean; required: boolean; enrollmentRequired: boolean };
  session: { id: string; authMethod: string; absoluteExpiresAt: string; idleTimeoutMinutes: number; steppedUpAt: string | null };
  csrfToken: string;
  hubDashboardUrl: string;
}

export interface LogoutResult {
  loggedOut: true;
  scope: 'CURRENT' | 'ALL' | 'NONE';
  revokedSessions: number;
  hubSessionEnded: boolean;
  hubDashboardUrl: string;
  message: string;
}

export interface UserSummary {
  id: string;
  email: string;
  fullName: string;
  department: string | null;
  status: string;
  roles: string[];
  totpEnrolled: boolean;
  liveSessions: number;
  lastLoginAt: string | null;
}

export const ALL_ROLES = ['VIEWER', 'MAKER', 'CHECKER', 'USER_ADMIN', 'AUDITOR', 'SUPER_ADMIN'];

/** Error carrying the API's stable error code (Technical Design §5.2). */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

let csrfToken = '';

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') {
    headers['X-CSRF-Token'] = csrfToken;
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error ?? {};
    throw new ApiFailure(res.status, e.code ?? 'ERROR', e.message ?? `Request failed (${res.status})`, e.details);
  }
  return data as T;
}

export async function fetchMe(): Promise<Me | null> {
  try {
    const me = await api<Me>('/auth/me');
    csrfToken = me.csrfToken;
    return me;
  } catch (e) {
    if (e instanceof ApiFailure && e.status === 401) return null;
    throw e;
  }
}

export function signInUrl(returnTo = window.location.pathname): string {
  return `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export const logout = (allSessions = false) => api<LogoutResult>('/auth/logout', { method: 'POST', body: { allSessions } });

export const startTotpEnrollment = () => api<{ secret: string; otpauthUri: string }>('/auth/totp/enroll', { method: 'POST' });
export const confirmTotpEnrollment = (code: string) =>
  api<{ recoveryCodes: string[] }>('/auth/totp/confirm', { method: 'POST', body: { code } });
export const stepUp = (input: { code?: string; recoveryCode?: string }) =>
  api<{ method: string; recoveryCodesLeft: number }>('/auth/step-up', { method: 'POST', body: input });

export const listUsers = (q: string) => api<UserSummary[]>(`/admin/users?q=${encodeURIComponent(q)}`);
export const setUserRoles = (id: string, roles: string[], reason: string) =>
  api<UserSummary>(`/admin/users/${id}/roles`, { method: 'PUT', body: { roles, reason } });
export const userAction = (id: string, action: 'deactivate' | 'reactivate' | 'reset-totp' | 'revoke-sessions', reason: string) =>
  api<unknown>(`/admin/users/${id}/${action}`, { method: 'POST', body: { reason } });
export const createUser = (input: { email: string; fullName: string; department: string; roles: string[]; reason: string }) =>
  api<UserSummary>('/admin/users', { method: 'POST', body: input });
export const updateUser = (id: string, input: { email?: string; fullName?: string; department?: string; reason: string }) =>
  api<UserSummary>(`/admin/users/${id}`, { method: 'PATCH', body: input });
export interface RoleAccessMatrix {
  pages: { key: string; label: string; group: string; hint: string; levels: { key: string; label: string }[] }[];
  roles: { code: string; name: string; access: Record<string, string>; locked: Record<string, string> }[];
}
export const getRoleAccess = () => api<RoleAccessMatrix>('/admin/roles/access');
export const saveRoleAccess = (role: string, access: Record<string, string>, reason: string) =>
  api<{ role: string; changed: string[] }>(`/admin/roles/${role}/access`, { method: 'PUT', body: { access, reason } });
export const deleteUser = (id: string, reason: string) =>
  api<{ id: string; result: 'REMOVED' | 'ANONYMISED' }>(`/admin/users/${id}`, { method: 'DELETE', body: { reason } });

// ---------------------------------------------------------------- registry and change sets

export type EntityType =
  | 'REGULATION' | 'COMMODITY' | 'PRODUCT_GROUP' | 'PRODUCT'
  | 'REF_SERIES' | 'REF_VALUE' | 'BAND_TABLE' | 'SCHEDULE' | 'SCHEDULE_LINE';
export type Operation = 'CREATE' | 'UPDATE' | 'END_DATE';
/** As stored: rollback adds WITHDRAW (a record the rolled-back version created). */
export type ItemOperation = Operation | 'WITHDRAW';

export const REG_TYPES = ['UU', 'PP', 'PERPRES', 'PMK', 'KMK', 'PERMENDAG', 'KEPMENDAG', 'PERMENPERIN', 'OTHER'];
export const REG_STATUSES = ['DRAFT_RANCANGAN', 'PROMULGATED', 'IN_FORCE', 'AMENDED', 'REVOKED'];
export const REG_RELATIONS = ['AMENDS', 'REVOKES', 'IMPLEMENTS'];
export const DOC_ROLES = ['MAIN', 'ANNEX', 'CORRIGENDUM', 'SECONDARY'];
export const DOC_KINDS = ['REGULATION', 'ANNEX', 'REF_PRICE_DECREE', 'HE_DECISION', 'FX_DECREE', 'OTHER'];
export const PARAM_OPERATORS = ['<', '≤', '=', '≥', '>', 'RANGE', 'TEXT'];

export interface SourceDocument {
  id: string;
  title: string;
  docKind: string;
  docNumber: string | null;
  docDate: string | null;
  officialUrl: string | null;
  sha256: string;
  byteSize: string;
  isSecondary: boolean;
  scanResult: string;
  publisherName: string | null;
  recheckMismatch?: boolean;
  reused?: boolean;
  /** In listings: what currently cites the document. */
  regulations?: { id: string; label: string }[];
  values?: { id: string; label: string }[];
}

export interface RegulationData {
  regType: string;
  number: string;
  year: number;
  titleId: string;
  titleEn: string | null;
  issuer: string;
  status: string;
  promulgatedOn: string | null;
  effectiveOn: string | null;
  endsOn: string | null;
  officialUrl: string | null;
  bpkStatusUrl: string | null;
  relations: { relation: string; regulationId: string; label?: string }[];
  documents: { sourceDocumentId: string; role: string; title?: string; sha256?: string; isSecondary?: boolean; publisherName?: string | null }[];
}

export interface RegulationView extends RegulationData {
  entityId: string;
  label: string;
  relatedBy: { relation: string; regulationId: string; label: string }[];
  versionFrom: number;
}

export interface HistoryEntry {
  versionFrom: number;
  versionTo: number | null;
  publishedAt: string;
  changeSetId: string;
  changeSetTitle: string;
  approvedBy: string | null;
  label: string;
}

export interface CommodityData {
  code: string;
  nameId: string;
  nameEn: string | null;
  isInScope: boolean;
  validFrom: string | null;
  validTo: string | null;
}

export interface GroupData {
  commodityId: string | null;
  code: string;
  label: string;
  ordinal: number;
  validFrom: string | null;
  validTo: string | null;
}

export interface CommodityView extends CommodityData {
  entityId: string;
  groups: (GroupData & { entityId: string; productCount: number })[];
}

export interface ProductParameter {
  name: string;
  operator: string;
  valueText: string;
  valueMin: number | null;
  valueMax: number | null;
  unit: string | null;
  isPrimary: boolean;
}

export interface ProductData {
  groupId: string | null;
  itemNoAsPrinted: string | null;
  nameId: string;
  nameEn: string | null;
  synonyms: string[];
  definition: string | null;
  notes: string[];
  annexPage: number | null;
  classificationRegulationId: string | null;
  validFrom: string | null;
  validTo: string | null;
  fxOnPebDate: boolean;
  otherObligationsNote: string | null;
  parameters: ProductParameter[];
  hsCodes: { code: string; isEx: boolean; exDescription: string | null; sharedWith?: { entityId: string; nameId: string }[] }[];
}

export interface ProductSummary {
  entityId: string;
  itemNoAsPrinted: string | null;
  nameId: string;
  nameEn: string | null;
  group: { entityId: string; label: string } | null;
  commodityCode: string | null;
  keySpec: string | null;
  hsCodes: { code: string; isEx: boolean }[];
  sharedHs: boolean;
  classificationRegulation: string | null;
  validFrom: string | null;
  validTo: string | null;
}

export type EntityData =
  | RegulationData | CommodityData | GroupData | ProductData
  | RefSeriesData | RefValueData | BandTableData | ScheduleData | ScheduleLineData;

export interface ChangeItem {
  id: string;
  entityType: EntityType;
  entityId: string;
  operation: ItemOperation;
  label: string;
  before: EntityData | null;
  after: EntityData;
  changes: { field: string; before: unknown; after: unknown }[];
  editedBy: string[];
  itemComment: string | null;
  /** Sheet and row of an imported item, e.g. "Products!7". */
  importRow: string | null;
}

export interface Finding {
  id: string;
  ruleCode: string;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  entityType: string | null;
  entityId: string | null;
  field: string | null;
  message: string;
  acknowledged?: boolean;
}

export interface ChangeSet {
  id: string;
  title: string;
  justification: string;
  status: string;
  kind: 'NORMAL' | 'IMPORT' | 'ROLLBACK';
  rollbackOfVersion: number | null;
  rolledBackByVersion: number | null;
  importJob: { id: string; fileName: string } | null;
  createdBy: { id: string; name: string };
  reviewedBy: { id: string; name: string } | null;
  submittedAt: string | null;
  decisionComment: string | null;
  approvedAt: string | null;
  effectiveAt: string | null;
  versionNo: number | null;
  updatedAt: string;
  editors: string[];
  items: ChangeItem[];
  references: Record<string, string>;
  findings: Finding[];
}

export interface ChangeSetSummary {
  id: string;
  title: string;
  status: string;
  kind: string;
  createdByName: string;
  reviewedByName: string | null;
  itemCount: number;
  updatedAt: string;
  effectiveAt: string | null;
  versionNo: number | null;
}

export const listRegulations = (q = '') => api<RegulationView[]>(`/regulations?q=${encodeURIComponent(q)}`);
export const getRegulation = (id: string) =>
  api<RegulationView & { history: HistoryEntry[]; classifiedProducts: { entityId: string; nameId: string; itemNoAsPrinted: string | null }[] }>(`/regulations/${id}`);
export const listCommodities = () => api<CommodityView[]>('/commodities');
export const listProducts = (q = '') => api<ProductSummary[]>(`/products?q=${encodeURIComponent(q)}`);
export const getProduct = (id: string) =>
  api<ProductData & {
    entityId: string;
    group: { entityId: string; label: string; code: string } | null;
    commodity: CommodityData | null;
    classificationRegulation: { entityId: string; label: string } | null;
    history: HistoryEntry[];
  }>(`/products/${id}`);
export const listSourceDocuments = (q = '') => api<SourceDocument[]>(`/source-documents?q=${encodeURIComponent(q)}`);

export const listChangeSets = (status = '') => api<ChangeSetSummary[]>(`/change-sets${status ? `?status=${status}` : ''}`);
export const getChangeSet = (id: string) => api<ChangeSet>(`/change-sets/${id}`);
export const createChangeSet = (title: string, justification: string) =>
  api<ChangeSet>('/change-sets', { method: 'POST', body: { title, justification } });
export const saveChangeItem = (
  setId: string,
  item: { itemId?: string; entityType: EntityType; entityId?: string; operation: Operation; after?: unknown; validTo?: string },
) => api<ChangeSet>(`/change-sets/${setId}/items`, { method: 'PUT', body: item });
export const removeChangeItem = (setId: string, itemId: string) => api<ChangeSet>(`/change-sets/${setId}/items/${itemId}`, { method: 'DELETE' });
export const changeSetAction = (setId: string, action: string, body: unknown = {}) =>
  api<ChangeSet>(`/change-sets/${setId}/${action}`, { method: 'POST', body });
/** Creates the ROLLBACK change set for a published version; another Checker approves it (US-30-P2). */
export const rollbackVersion = (versionNo: number, reason: string) =>
  api<ChangeSet>(`/data-versions/${versionNo}/rollback`, { method: 'POST', body: { reason } });

// ---------------------------------------------------------------- Excel import (F-28)

export interface ImportReportEntry {
  sheet: string;
  row: number | null;
  column: string | null;
  field: string | null;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  code: string;
  message: string;
}

export interface ImportJob {
  id: string;
  fileName: string;
  fileSha256: string;
  templateVersion: string;
  status: 'VALIDATED' | 'VALIDATED_WITH_ERRORS' | 'COMMITTED';
  rowCount: number;
  errorCount: number;
  warningCount: number;
  report: ImportReportEntry[];
  changeSetId: string | null;
  createdAt: string;
}

export const listImports = () =>
  api<{ id: string; fileName: string; status: string; rowCount: number; errorCount: number; warningCount: number; changeSetId: string | null; createdAt: string }[]>('/imports');
export const getImport = (id: string) => api<ImportJob>(`/imports/${id}`);
export const commitImport = (id: string, body: { title: string; justification: string; acknowledgeWarnings: boolean }) =>
  api<ImportJob>(`/imports/${id}/commit`, { method: 'POST', body });

// ---------------------------------------------------------------- notifications (F-48)

export interface AppNotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string;
  versionNo: number | null;
  createdAt: string;
  readAt: string | null;
}

export interface Subscription {
  id: string;
  scopeType: 'COMMODITY' | 'PRODUCT_GROUP' | 'PRODUCT';
  scopeEntityId: string;
  label: string;
  createdAt: string;
}

export interface Bulletin {
  versionNo: number;
  publishedAt: string;
  title: string;
  kind: string;
  rollbackOfVersion: number | null;
  rolledBackByVersion: number | null;
  items: { entityType: string; operation: string; label: string }[];
  date: string;
  impact: ImpactRow[];
}

export const listNotifications = (unreadOnly = false) => api<AppNotification[]>(`/notifications${unreadOnly ? '?unread=true' : ''}`);
export const unreadNotifications = () => api<{ unread: number }>('/notifications/unread-count');
export const markNotificationsRead = (id?: string) => api<{ unread: number }>('/notifications/read', { method: 'POST', body: id ? { id } : {} });
export const listSubscriptions = () => api<Subscription[]>('/subscriptions');
export const subscribe = (scopeType: Subscription['scopeType'], scopeEntityId: string) =>
  api<Subscription[]>('/subscriptions', { method: 'POST', body: { scopeType, scopeEntityId } });
export const unsubscribe = (id: string) => api<Subscription[]>(`/subscriptions/${id}`, { method: 'DELETE' });
export const unsubscribeByToken = (token: string) =>
  api<{ unsubscribed: boolean; label: string | null }>('/subscriptions/unsubscribe', { method: 'POST', body: { token } });
export const getBulletin = (versionNo: number) => api<Bulletin>(`/data-versions/${versionNo}/bulletin`);

/** Multipart upload of an import workbook; the answer is the dry-run report. */
export async function uploadImport(file: File): Promise<ImportJob> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/imports', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error ?? {};
    throw new ApiFailure(res.status, e.code ?? 'ERROR', e.message ?? `Upload failed (${res.status})`, e.details);
  }
  return data as ImportJob;
}

/** Multipart upload of an official source PDF (Technical Design §4.2.2). */
export async function uploadSourceDocument(file: File, fields: Record<string, string>): Promise<SourceDocument> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v) form.append(k, v);
  form.append('file', file);
  const res = await fetch('/api/source-documents', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error ?? {};
    throw new ApiFailure(res.status, e.code ?? 'ERROR', e.message ?? `Upload failed (${res.status})`, e.details);
  }
  return data as SourceDocument;
}

// ---------------------------------------------------------------- tariffs and reference prices

export const SERIES_KINDS = ['REFERENCE_PRICE', 'HARGA_EKSPOR', 'FX_RATE'];
export const CADENCES = ['MONTHLY', 'HALF_MONTHLY', 'WEEKLY'];
export const CHARGE_TYPES = ['BK', 'PE'];
export const BASES_FOR: Record<string, string[]> = {
  BK: ['BAND_USD_PER_MT', 'AD_VALOREM_PCT', 'BAND_PCT', 'ZERO_LISTED'],
  PE: ['PCT_OF_REF_PRICE', 'FIXED_USD_PER_MT', 'ZERO_LISTED'],
};

export interface RefSeriesData {
  code: string;
  name: string;
  kind: string;
  unit: string;
  cadence: string;
  productId: string | null;
}

export interface RefValueData {
  seriesId: string | null;
  periodFrom: string;
  periodTo: string;
  value: string;
  sourceDocumentId: string | null;
  sourceReference: string | null;
}

export interface Band {
  lowerExclusive: string | null;
  upperInclusive: string | null;
  label: string;
}

export interface BandTableData {
  code: string;
  name: string;
  refSeriesId: string | null;
  bands: Band[];
  validFrom: string | null;
  validTo: string | null;
}

export interface ScheduleData {
  regulationId: string | null;
  chargeType: string;
  annexLabel: string;
  commodityId: string | null;
  validFrom: string | null;
  validTo: string | null;
}

export interface ScheduleLineData {
  scheduleId: string | null;
  kelompok: string | null;
  itemNo: string | null;
  uraian: string;
  basisType: string;
  pct: string | null;
  usdPerMt: string | null;
  bandTableId: string | null;
  refSeriesId: string | null;
  bandValues: string[];
  productIds: string[];
  validFrom: string | null;
  validTo: string | null;
}

export interface ValueUsed {
  seriesId: string;
  seriesCode: string;
  value: string;
  unit: string;
  periodFrom: string;
  periodTo: string;
  sourceDocumentId: string | null;
  sourceReference: string | null;
  fallback: boolean;
}

export interface Charge {
  chargeType: 'BK' | 'PE';
  status: 'CHARGED' | 'LISTED_ZERO' | 'NOT_LISTED' | 'MISSING_VALUE' | 'DATA_ERROR';
  usdPerMt: string | null;
  message: string | null;
  basisType?: string;
  rate?: string | null;
  band?: { ordinal: number; label: string } | null;
  referencePrice?: ValueUsed | null;
  hargaEkspor?: ValueUsed | null;
  line?: { lineId: string; label: string; regulationId: string | null; regulation: string | null; annexLabel: string | null; kelompok: string | null; itemNo: string | null; uraian: string };
}

export interface SeriesView extends RefSeriesData {
  entityId: string;
  product: string | null;
  current: ValueUsed | null;
  latest: (RefValueData & { valueId: string }) | null;
}

export interface ScheduleView extends ScheduleData {
  entityId: string;
  regulation: string | null;
  commodity: string | null;
  lineCount: number;
}

export interface ScheduleLineView extends ScheduleLineData {
  entityId: string;
  label: string;
  refSeries: string | null;
  bandTable: { code: string; bands: Band[] } | null;
  products: { entityId: string; nameId: string }[];
}

export interface ImpactRow {
  productId: string;
  product: string;
  bk: { before: Charge; after: Charge };
  pe: { before: Charge; after: Charge };
  changed: boolean;
}

export const listRefSeries = (date = '') => api<SeriesView[]>(`/ref-series${date ? `?date=${date}` : ''}`);
export const getRefSeries = (id: string) =>
  api<RefSeriesData & { entityId: string; product: string | null; values: (RefValueData & { entityId: string; sourceDocument: { id: string; title: string; sha256: string; publisher: string | null } | null })[] }>(`/ref-series/${id}`);
export const listBandTables = () => api<(BandTableData & { entityId: string; refSeries: string | null })[]>('/band-tables');
export const listSchedules = () => api<ScheduleView[]>('/schedules');
export const getSchedule = (id: string) => api<ScheduleView & { lines: ScheduleLineView[] }>(`/schedules/${id}`);
export const getProductCharges = (id: string, date = '') => api<{ date: string; bk: Charge; pe: Charge }>(`/products/${id}/charges${date ? `?date=${date}` : ''}`);
export const getImpact = (setId: string) => api<{ date: string; rows: ImpactRow[] }>(`/change-sets/${setId}/impact`);

/**
 * Rounds an exact decimal string for display (BR-CAL-05: 2 decimals for USD, 0 for IDR), half up, without
 * going through binary floating point. Thousands are separated for reading.
 */
export function formatDecimal(value: string | null | undefined, dp = 2): string {
  if (value === null || value === undefined || value === '') return '—';
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) return value;
  const [, sign, int, frac = ''] = m;
  const padded = (frac + '0'.repeat(dp + 1)).slice(0, dp + 1);
  let scaled = BigInt(int + padded.slice(0, dp));
  if (Number(padded[dp]) >= 5) scaled += 1n;
  const digits = scaled.toString().padStart(dp + 1, '0');
  const whole = digits.slice(0, digits.length - dp).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${whole}${dp ? '.' + digits.slice(-dp) : ''}`;
}
