/**
 * The versioned Excel import template (PRD L2-3.6 step 1, US-28-N1 AC2). Columns are found by their header text in
 * row 1, so their order may change; a workbook from another template version is refused before any row is read.
 */
export const TEMPLATE_VERSION = 'ECR-IMPORT-1';

export interface ColumnDef {
  key: string;
  header: string;
  required?: boolean;
  help: string;
  width?: number;
}

export interface SheetDef {
  name: 'Products' | 'Lines' | 'Prices';
  purpose: string;
  columns: ColumnDef[];
}

export const PRODUCTS: SheetDef = {
  name: 'Products',
  purpose: 'New products, or changes to published ones (fill ECR id). On a change, empty cells keep the published value.',
  columns: [
    { key: 'key', header: 'Row key', required: true, help: 'Your reference for the row, unique in the file (e.g. PALM-I-3); Lines refer to products by it.', width: 14 },
    { key: 'id', header: 'ECR id', help: 'Empty for a new product; the product id to change a published one.', width: 38 },
    { key: 'commodity', header: 'Commodity', help: 'Commodity code, e.g. PALM.', width: 11 },
    { key: 'group', header: 'Group', help: 'Group code within the commodity, e.g. I or IV.', width: 8 },
    { key: 'itemNo', header: 'Item no.', help: 'Item number as printed in the annex.', width: 9 },
    { key: 'nameId', header: 'Name (Indonesian)', help: 'Product name as printed. Required for a new product.', width: 34 },
    { key: 'nameEn', header: 'Name (English)', help: 'Optional.', width: 28 },
    { key: 'synonyms', header: 'Synonyms', help: 'Separate with ; (semicolon).', width: 22 },
    { key: 'definition', header: 'Definition', help: 'Technical definition.', width: 34 },
    { key: 'hsCodes', header: 'HS codes', help: '8-digit BTKI codes separated with ; — prefix ex-codes with "ex ", e.g. ex 1511.90.36.', width: 24 },
    { key: 'exDescription', header: 'Ex description', help: 'What qualifies the product under its ex-codes.', width: 28 },
    { key: 'specName', header: 'Key spec name', help: 'Primary technical parameter, e.g. ALB.', width: 14 },
    { key: 'specOperator', header: 'Key spec operator', help: '<, <=, =, >=, >, RANGE or TEXT.', width: 10 },
    { key: 'specValue', header: 'Key spec value', help: 'e.g. 5', width: 12 },
    { key: 'specUnit', header: 'Key spec unit', help: 'e.g. %', width: 10 },
    { key: 'regulation', header: 'Classification regulation', help: 'As registered, e.g. PMK 38/2024 or Permenperin 11/2024.', width: 22 },
    { key: 'validFrom', header: 'Valid from', help: 'Date (YYYY-MM-DD).', width: 12 },
    { key: 'validTo', header: 'Valid to', help: 'Last day it applies; empty if open.', width: 12 },
    { key: 'fxOnPebDate', header: 'FX on PEB date', help: 'Y for goods with special characteristics (BR-CAL-09), otherwise N.', width: 9 },
    { key: 'notes', header: 'Notes', help: 'Separate with ;', width: 28 },
  ],
};

export const LINES: SheetDef = {
  name: 'Lines',
  purpose: 'Duty (BK) and levy (PE) schedule lines of an annex. The schedule (regulation, charge and annex) must already be registered.',
  columns: [
    { key: 'id', header: 'ECR id', help: 'Empty for a new line; the line id to change a published one.', width: 38 },
    { key: 'regulation', header: 'Regulation', required: true, help: 'e.g. PMK 38/2024.', width: 16 },
    { key: 'charge', header: 'Charge', required: true, help: 'BK or PE.', width: 8 },
    { key: 'annex', header: 'Annex', required: true, help: 'Annex label as registered, e.g. Lampiran I.', width: 14 },
    { key: 'kelompok', header: 'Kelompok', help: 'Group as printed.', width: 10 },
    { key: 'itemNo', header: 'Item no.', help: 'Number as printed.', width: 9 },
    { key: 'uraian', header: 'Uraian', help: 'Description exactly as printed. Required for a new line.', width: 40 },
    { key: 'basis', header: 'Basis', help: 'BAND_USD_PER_MT, AD_VALOREM_PCT, BAND_PCT, PCT_OF_REF_PRICE, FIXED_USD_PER_MT or ZERO_LISTED.', width: 20 },
    { key: 'pct', header: 'Rate %', help: 'For AD_VALOREM_PCT and PCT_OF_REF_PRICE.', width: 9 },
    { key: 'usdPerMt', header: 'USD/MT', help: 'For FIXED_USD_PER_MT.', width: 9 },
    { key: 'series', header: 'Reference series', help: 'Series code, e.g. CPO; for banded lines and % of reference price.', width: 14 },
    { key: 'bandTable', header: 'Band table', help: 'Band table code for banded lines.', width: 12 },
    { key: 'bandValues', header: 'Band amounts', help: 'One amount per band, lowest band first, separated with ;', width: 30 },
    { key: 'products', header: 'Products', help: 'Row keys from the Products sheet or product ids, separated with ;', width: 24 },
    { key: 'validFrom', header: 'Valid from', help: 'Date (YYYY-MM-DD).', width: 12 },
    { key: 'validTo', header: 'Valid to', help: 'Last day it applies; empty if open.', width: 12 },
  ],
};

export const PRICES: SheetDef = {
  name: 'Prices',
  purpose: 'New reference values (reference prices, Harga Ekspor, KMK rates). Upload each decree as a source document first.',
  columns: [
    { key: 'series', header: 'Series', required: true, help: 'Series code, e.g. CPO, HE-KERNEL or FX-USDIDR.', width: 14 },
    { key: 'periodFrom', header: 'Period from', required: true, help: 'Date (YYYY-MM-DD).', width: 12 },
    { key: 'periodTo', header: 'Period to', required: true, help: 'Last day of the period.', width: 12 },
    { key: 'value', header: 'Value', required: true, help: 'In the series unit; more than 0.', width: 12 },
    { key: 'decree', header: 'Decree', help: 'Decree number as cited, e.g. Kepmendag 1234/2026.', width: 24 },
    { key: 'document', header: 'Source document', help: 'Document number or SHA-256 of an uploaded source document.', width: 30 },
  ],
};

export const SHEETS: SheetDef[] = [PRODUCTS, LINES, PRICES];

/** At most this many data rows per sheet. */
export const MAX_ROWS = 5000;
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
