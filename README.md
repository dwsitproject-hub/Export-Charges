# ECR — Export Charges Registry

Indonesian palm oil export duty (Bea Keluar) and levy (Pungutan Ekspor) registry.
Specs: [PRD](docs/02-PRD-Export-Duty-Levy-Platform.md) · [Technical Design](https://claude.ai/artifact/N3ra2W5pRNhqqvZKRCiMYf).

## What is built so far

| Area | Status |
|---|---|
| Monorepo: `backend/` (NestJS 11, Node 22) and `frontend/` (React 19 + Vite) as npm workspaces | Done |
| PostgreSQL 18 schema: users, identities, roles, permissions, login state, sessions, local credentials (TOTP), hash-chained audit trail | Done (`backend/migrations`) |
| DWS Hub sign-in: OIDC authorization code + PKCE (S256), ID token verified via JWKS (RS256/ES256 only), `sub` as user key | Done |
| Just-in-time accounts: first DWS Hub sign-in creates the ECR account with `JIT_DEFAULT_ROLES` (default VIEWER) | Done |
| Sessions: server-side, idle 15/30 min, absolute 8 h, max 3 per user, CSRF token; logout | Done |
| Authenticator (TOTP) enrolment for privileged roles, step-up for sensitive actions, recovery codes, lockout | Done |
| Permission guard (`@Authorize`) with refused attempts audited (`AUTHZ_DENIED`) | Done |
| User administration: roles, deactivate/reactivate, end sessions, reset authenticator — with SoD-2/3/4 and BR-IAM-02 | Done |
| Audit log: search by person, action, entity and WIB dates, event details, hash-chain verification, CSV/XLSX export with the chain status | Done |
| Network allow-list (office + VPN) | Done |
| Regulation register with amendment links and official source documents (PDF, SHA-256, allow-listed publishers, virus scan) | Done |
| Commodities, product groups, palm product master with technical parameters and HS codes (BTKI 2022), shared-HS detection | Done |
| Maker-checker change sets: field-level diff, validation findings, four-eyes (SoD-1), step-up, scheduled publishing, version history | Done |
| Reference series and values (CPO reference price, Harga Ekspor per product, KMK FX), each with its official decree | Done |
| BK and PE schedules (annexes), schedule lines on six bases, band tables; duty and levy per tonne for any date | Done |
| Impact preview on change sets: duty and levy per tonne before and after, per affected product | Done |
| Catalogue: search, multi-select filters with counts, KPI tiles, unit-safe sorting, paging, permalinks, as-of date and data version | Done |
| Calculator: up to 50 lines, PEB and payment dates, KMK FX and IDR, what-if price, saved calculations with replay check | Done |
| CSV/XLSX export of the filtered catalogue and of saved calculations, with formula-injection guard | Done |
| PDF/A-2b evidence pack per saved calculation, verification page with replay and file comparison | Done |
| Rollback of a published version as a change set approved by a second Checker; rolled-back versions marked in history | Done |
| Excel import: versioned template, dry run with row-level report (also as Excel), one IMPORT change set per file | Done |
| Notifications in ECR and by email (transactional outbox, SMTP), change subscriptions, change bulletins | Done |
| Catalogue exports above 50,000 rows prepared in the background, owner-only download for 24 h | Done |
| Scheduled jobs: nightly data-quality check with dashboard, reference-price gap check, dormancy, audit-chain check, DWS Hub key refresh, session sweep | Done |
| *Sources* page: every official PDF behind the data (regulations, reference-price and KMK decrees) to open, download and check by SHA-256, with what each one is used for; the calculator links the decrees it used | Done |
| DWS Hub SDK in the web app (page views, errors, bug button, breadcrumbs, `identify` with the Hub `sub`, tracked actions, release tag for Sentinel) and staging deployment for two servers | Done |
| Daily source watch: BPK status and amendments of registered regulations, new PMK and Kepmendag documents on the official listings, new files on JDIH pages, changed official PDFs — reported to Makers, never published | Done |
| Quarterly access reviews: keep or revoke each role assignment, 14-day escalation, signed PDF/A report for auditors | Done |
| Configuration screen: session limits, step-up window, roles at first sign-in, network allow-list, disclaimer — bounded, audited, applied at once | Done |
| Web app layout: sidebar menu showing only what the person may use, home dashboard (work waiting, reference prices, notifications, recent versions), light and dark themes from the prototype's palette, usable from 360 px, sticky table headers | Done |

**Access model.** DWS Hub owns who may use ECR (its own invitations and access requests). ECR creates the
account at first sign-in and owns roles, account status, sessions and the audit trail. Privileged roles
(MAKER, CHECKER, USER_ADMIN, AUDITOR) must set up an authenticator app before using any protected function, and
confirm a code before sensitive actions — DWS Hub does not yet report MFA (Technical Design T-01). Roles listed in
`TOTP_EXEMPT_ROLES` (default `SUPER_ADMIN`) neither enrol nor confirm codes and rely on the DWS Hub sign-in alone; set
`TOTP_EXEMPT_ROLES=` (empty) to require the authenticator of Super Admins too. The Configuration page shows the setting.

## API

| Method and path | Access | Notes |
|---|---|---|
| `GET /api/auth/login?returnTo=` · `GET /api/auth/callback` | public (allow-listed network) | DWS Hub sign-in; also the launch URL to register in the Hub |
| `GET /api/auth/me` | signed in | Profile, roles, permissions, `hubSubject` (DWS Hub `sub`, for the Hub SDK), TOTP status, CSRF token |
| `POST /api/auth/logout` | signed in (idempotent) | `{"allSessions": true}` signs out every browser |
| `GET /api/auth/totp/status` · `POST /api/auth/totp/enroll` · `POST /api/auth/totp/confirm` | signed in | Authenticator setup; confirm returns 10 recovery codes once |
| `POST /api/auth/step-up` | signed in | `{"code"}` or `{"recoveryCode"}`; valid 5 minutes |
| `GET /api/admin/users?q=&status=&role=` · `GET /api/admin/users/{id}` | `user.manage` | |
| `PUT /api/admin/users/{id}/roles` | `user.manage` + step-up | `{"roles": [...], "reason": "..."}`; ends the user's sessions |
| `POST /api/admin/users/{id}/deactivate` · `/reactivate` · `/reset-totp` | `user.manage` + step-up | `{"reason"}` required |
| `POST /api/admin/users/{id}/revoke-sessions` | `user.manage` | `{"reason"}` required |
| `GET /api/admin/reviews` · `GET /api/admin/reviews/{id}` | `accessreview.read` (User Admins, Super Admins, Auditors) | Campaigns with progress and what waits for you; one campaign with every assignment, its decision and whether you may decide it |
| `POST /api/admin/reviews/{id}/items/{itemId}` | `user.manage` + step-up | `{"decision": "KEEP"\|"REVOKE", "reason"}` (reason required to revoke); a revoke removes the role and ends the user's sessions; the last decision completes the review (`closed: true`). `SOD_VIOLATION` on your own access, `FORBIDDEN` for an administrator's assignment unless Super Admin, `ALREADY_DECIDED`, `REVIEW_CLOSED`, `ROLE_ALREADY_REVOKED` (Keep on a role removed since) |
| `GET /api/admin/config` | `config.manage` | Each setting with its value, default, allowed range and last change; the deployment-only settings read-only |
| `PUT /api/admin/config` | `config.manage` + step-up | `{"values": {"key": value \| null}, "reason"}`; null restores the default; values outside the limits → 400 `INVALID_INPUT` with the allowed range per field; returns the settings and `changed` |
| `GET /api/admin/reviews/{id}/report` · `GET /api/admin/reviews/{id}/report/verify` | `accessreview.read` | The signed PDF/A report of a completed review (409 `REPORT_NOT_READY` before; download audited); the check of stored file, content hash and signature |
| `GET /api/audit-events?actor=&action=&actorUserId=&entityType=&entityId=&from=&to=&before=` · `GET /api/audit-events/verify` · `GET /api/audit-events/facets` | `audit.read` | Newest first, paged by chain sequence. `actor` matches name or email (or `system`); `action` takes several, comma-separated; a date `from`/`to` is a whole WIB day. Facets: the actions and entity types present, with counts |
| `GET /api/audit-events/export?format=csv\|xlsx&…` | `audit.export` | Same filters, oldest first, header block with the hash-chain status (verified at export time), filters, exporter and time; more than 50,000 events → `EXPORT_TOO_LARGE`; audited as `AUDIT_EXPORTED` |
| `GET /api/regulations?q=&status=&type=` · `GET /api/regulations/{entityId}` | `catalogue.read` | Published register; detail adds documents, amendment chain both ways, classified products, history |
| `GET /api/commodities` · `GET /api/products?q=&commodity=&group=` · `GET /api/products/{entityId}` | `catalogue.read` | `q` matches names, synonyms, definition or HS digits; detail lists products sharing each HS code |
| `GET /api/hs-codes?q=` · `GET /api/source-publishers` | `catalogue.read` | Current BTKI codes by digit prefix; the official-source allow-list |
| `POST /api/source-documents` (multipart) | `source.upload` | `file` (PDF ≤ 25 MB) + `docKind`, `title`, `officialUrl`, `docNumber`, `docDate`, `isSecondary`; same file twice → same record (`reused: true`) |
| `GET /api/source-documents?q=` · `GET /api/source-documents/{id}` · `.../file[?download=1]` | `catalogue.read` | Each with `regulations` and `values` that cite it. Viewers see documents cited by a published regulation or reference value (decrees included); the file opens in the browser (`inline`) unless `download=1`, and is re-hashed on every read |
| `GET /api/change-sets?status=&mine=` · `GET /api/change-sets/{id}` · `GET /api/data-versions` | `changeset.read` | Detail has items with before/after and a field-level diff, findings, reference labels |
| `POST /api/change-sets` · `PUT /api/change-sets/{id}/items` · `DELETE .../items/{itemId}` · `POST .../discard` | `changeset.create` (owner) | Item: `{entityType, operation: CREATE\|UPDATE\|END_DATE, entityId?, itemId?, after?, validTo?}` |
| `POST /api/change-sets/{id}/submit` · `/withdraw` | `changeset.submit` (owner) | `{"acknowledgeWarnings": true}` once warnings are reviewed |
| `POST /api/change-sets/{id}/start-review` | `changeset.approve` + SoD-1 | Re-validates against today's published data |
| `POST /api/change-sets/{id}/approve` · `/reject` · `/cancel-schedule` | `changeset.approve` + SoD-1 + step-up | Approve `{effectiveDate}` (WIB; today or earlier publishes now, later schedules); reject `{comment, itemComments}`; cancel `{reason}` |
| `GET /api/change-sets/{id}/impact?date=` | `changeset.read` | Per affected product: BK and PE per tonne with the published data and with the set applied |
| `GET /api/ref-series?date=` · `GET /api/ref-series/{entityId}` | `catalogue.read` | Series with the value in force on the date and the latest value; detail lists every value with its decree |
| `GET /api/band-tables` · `GET /api/schedules?chargeType=` · `GET /api/schedules/{entityId}` | `catalogue.read` | Schedule detail lists its lines with band amounts and linked products |
| `GET /api/catalogue?q=&date=&version=&commodity=&group=&category=&regulation=&sharedHs=&sort=&dir=&page=&pageSize=` | `catalogue.read` | Multi-select filters comma-separated; returns rows, facet counts, KPI tiles, reference prices with their band, notices and a "did you mean" suggestion |
| `POST /api/calculations/preview` · `POST /api/calculations` | `calc.run` | `{lines: [{productId, quantityMt}], pebDate?, paymentDate?, refPriceOverride?, versionNo?}`; preview is not stored |
| `GET /api/calculations` · `GET /api/calculations/{id}` · `GET /api/calculations/{id}/verify` · `GET /api/calculations/products?date=` | `calc.run` | Own calculations only; verify replays the inputs at the stored data version and compares the result hash |
| `GET /api/products/{entityId}/charges?date=` | `catalogue.read` | BK and PE per tonne on the date, with basis, band, reference price or Harga Ekspor used, decree and legal reference |
| `GET /api/exports/catalogue?format=csv\|xlsx&…` | `export.run` | Same parameters as `/api/catalogue`; every matching row (paging ignored) under a header block with D, V, prices, filters, user, time and disclaimer; more than `EXPORT_ASYNC_THRESHOLD` (50,000) rows → 422 `EXPORT_TOO_LARGE` with `{rows, limit, jobUrl}` |
| `POST /api/exports/jobs` · `GET /api/exports/jobs` · `GET /api/exports/jobs/{id}` | `export.run` (requester only) | `{format, query}` with the catalogue's query parameters; 201 with the job (QUEUED), data version pinned; at most 3 open jobs per person (`EXPORT_QUEUE_FULL`, 429) |
| `GET /api/exports/jobs/{id}/file` | `export.run` (requester only) | 24 h after it is ready (410 `EXPORT_EXPIRED` afterwards, 409 `EXPORT_NOT_READY` before); re-hashed on download |
| `GET /api/jobs` · `GET /api/jobs/{name}/runs` | `audit.read` | Each scheduled job with its schedule and last run; the last 30 runs of one job |
| `GET /api/source-watch` | `changeset.read` | `?status=OPEN\|DONE\|DISMISSED`; items of the daily source watch (open first) and its last run |
| `POST /api/source-watch/{id}/resolve` | `changeset.create` | `{"status": "DONE"\|"DISMISSED", "note"}` (note required to dismiss); audited as `SOURCE_WATCH_RESOLVED`; 409 `ALREADY_RESOLVED` |
| `POST /api/jobs/{name}/run` | `config.manage` + step-up | Runs the job now (409 `JOB_RUNNING` when another instance holds it); audited as `JOB_RUN_REQUESTED` |
| `GET /api/dq/findings` | `dq.read` | Findings of the latest nightly data-quality run, each with the record's label and page |
| `GET /api/exports/calculations/{id}?format=csv\|xlsx` | `export.run` | Own calculations; lines, totals, missing values; a simulation is titled as such |
| `POST /api/calculations/{id}/evidence` | `evidence.create` (author) | 201 with the new pack, 200 with the existing one; refused for a simulation (`SIMULATION_NOT_EVIDENCE`), an incomplete result (`CALCULATION_INCOMPLETE`) or a failed replay (`REPLAY_MISMATCH`) |
| `GET /api/evidence/{evidenceId}` · `.../file` | `catalogue.read`; author or `audit.read` | The PDF is re-hashed on every download (`EVIDENCE_INTEGRITY`) |
| `GET /api/evidence/{evidenceId}/verify` | `catalogue.read` (anyone signed in) | Stored PDF intact, printed content intact, calculation replays identically; totals to compare with the paper |
| `POST /api/data-versions/{v}/rollback` | `changeset.approve` + step-up | `{reason}`; 201 with a ROLLBACK change set (SUBMITTED). `ALREADY_ROLLED_BACK`, `ROLLBACK_PENDING`, `ROLLBACK_CONFLICT` (a later version changed a record), `ROLLBACK_INVALID` (the result would not validate) |
| `POST /api/change-sets/{id}/cancel-rollback` | `changeset.approve` (initiator) | An open rollback (SUBMITTED, returned to DRAFT, or REJECTED) → CANCELLED; its records are released |
| `GET /api/imports/template` | `import.run` | The current template (`ECR-IMPORT-1`) with a Lists sheet of the codes ECR knows |
| `POST /api/imports` (multipart `file`) · `GET /api/imports` | `import.run` | 201 with the dry-run report; refused files: `FILE_TOO_LARGE`, `FILE_REJECTED` (not .xlsx, macros, DTD, damaged, infected), `TEMPLATE_OUTDATED` (with `templateUrl`) |
| `GET /api/imports/{id}` · `.../report` | uploader or `changeset.read` | The report as JSON or as an Excel workbook |
| `POST /api/imports/{id}/commit` | `import.run` + `changeset.create` (uploader) | `{title?, justification?, acknowledgeWarnings?}`; re-checks the stored file, then creates one IMPORT change set (DRAFT) |
| `GET /api/notifications?unread=` · `GET /api/notifications/unread-count` · `POST /api/notifications/read` | signed in | Own notifications; `{id}` marks one read, no id marks all |
| `GET /api/subscriptions` · `POST /api/subscriptions` · `DELETE /api/subscriptions/{id}` | `catalogue.read` | `{scopeType: COMMODITY\|PRODUCT_GROUP\|PRODUCT, scopeEntityId}`; subscribing twice changes nothing |
| `POST /api/subscriptions/unsubscribe` | public (allow-listed network) | `{token}` from the email link (HMAC-signed subscription id) |
| `GET /api/data-versions/{v}/bulletin` | `catalogue.read` | What version *v* changed and BK/PE per tonne of every affected product before and after, on its publication date |

Rules enforced in user administration: nobody changes their own access (SoD-3); only a Super Admin manages
USER_ADMIN/SUPER_ADMIN roles or accounts (BR-IAM-02); USER_ADMIN cannot be combined with MAKER or CHECKER
(SoD-2); at least two active Super Admins must remain (SoD-4); a reason is mandatory and audited.

### Change sets (maker-checker)

Makers never write published data. A change set holds items with the published "before" and the proposed
"after"; one record can be open in only one change set at a time (`ENTITY_LOCKED`). Submitting runs the
validation rules and stores the findings:

| Severity | Rules |
|---|---|
| Error (blocks) | Missing group, classification regulation, validity start or HS code (BR-PRD-01, DQ-01); duplicate regulation (BR-REG-01) or commodity/group code; circular amendment chain (BR-REG-02); regulation or reference value without an official document (BR-SRC-01); reference to an unregistered record; ending a commodity or group that still has valid records (US-22-N1); overlapping periods in a series (BR-REF-01); band table with a gap, an overlap, not from 0 or not ending without ceiling (BR-TRF-02); a basis the charge does not support, a banded or %-of-price line without a reference-price series, or a band table on another series (BR-TRF-04); band amounts not one per band (DQ-06); two active BK or two active PE lines for a product on overlapping dates (BR-TRF-01); ad-valorem or banded-% line for a product without a Harga Ekspor series |
| Warning (acknowledge to submit) | Product without definition or parameters (DQ-05); effective before promulgation; in force past its end date (DQ-09); ending a regulation that still classifies products; value more than 30 % from the previous period (BR-REF-02); gap between periods (DQ-07); band amounts falling as the price rises (DQ-06); line not linked to a product (DQ-08); line of a revoked regulation still valid |
| Info | Duplicate "as printed" item no. (DQ-04); shares an HS code with another product (BR-PRD-04); classified under a draft regulation (DQ-10) |

A Checker who did not create or edit the set (SoD-1) starts the review, which validates again, then approves
with a fresh authenticator code. Approval with today's date (WIB) publishes immediately as the next data
version; a later date schedules it, and the in-process `publish-due` job publishes it at 00:00 WIB (a set that
no longer validates stays scheduled and `CHANGESET_PUBLISH_FAILED` is audited). Publishing closes the replaced
row versions and inserts new ones in one transaction under an advisory lock; if a replaced version is no
longer current, approval fails with `STALE_CHANGE_SET`. Published rows, their children and source documents
are protected by database triggers against update and delete.

### Duty and levy per tonne

`chargeFor` (`backend/src/tariffs/charge-engine.ts`) finds the one BK or PE line linked to the product and valid
on the date (PRD §9.2, Technical Design §4.3.2):

| Basis | Per tonne |
|---|---|
| `BAND_USD_PER_MT` | The amount of the band containing the reference price for the date (lower edge exclusive, upper inclusive, BR-CAL-02) |
| `PCT_OF_REF_PRICE` | rate % × reference price for the date |
| `AD_VALOREM_PCT` | rate % × the product's Harga Ekspor; the previous period's when the new decision is not yet published (BR-CAL-03) |
| `BAND_PCT` | the band's % × Harga Ekspor |
| `FIXED_USD_PER_MT` | the amount |
| `ZERO_LISTED` | 0, shown as "Listed at 0" — different from "Not listed" (no line, BR-CAL-06) |

A missing reference price for the date gives `MISSING_VALUE` with the reason instead of a number. All amounts
are exact decimals (`decimal.js` and PostgreSQL `numeric`), returned as strings and rounded only for display.
Quantity, IDR at the KMK rate and the PEB/payment-date rules come with the calculator.

### Calculator and catalogue

Every read takes a business date D (the PEB date) and a data version V (Technical Design §4.3.1). V defaults to
the latest version; an earlier V reads exactly the row versions that were current then, so a past answer can
be reproduced. For a date after today, approved change sets scheduled to take effect by then are applied on top
(US-45-N1 AC2); a calculation relying on them cannot be saved.

| Rule | How |
|---|---|
| Duty and levy dates (BR-CAL-01) | Rates, bands and prices in force on the PEB date. The levy date is not stated in PMK 69/2025 (OQ-03); the PEB date is used |
| IDR (BR-CAL-09) | KMK USD/IDR on the payment date (default the PEB date), or on the PEB date for goods marked special-characteristic; the payment date may be at most 30 days before the PEB date |
| Rounding (BR-CAL-05) | Exact decimals throughout; only the IDR grand total is rounded, half up, to whole rupiah |
| Missing values (US-44-N2) | A missing reference price, Harga Ekspor or KMK rate is named and the affected total is left empty (`INCOMPLETE`) |
| What-if (US-44-P2) | `refPriceOverride` replaces every reference price on the PEB date; the result is a labelled simulation. A value that is not positive is ignored with a notice |
| Warnings (BR-CAL-03, BR-CAL-07) | Previous-period Harga Ekspor, a product sharing its HS code with one charged differently, a draft classification |
| Replay (NFR-AUD-01) | A saved calculation keeps its inputs, V and full result with SHA-256 hashes; saved rows cannot be changed |
| KPI tiles (US-46) | Each product is in exactly one of: duty and levy, duty only, levy only, listed at 0, not listed. Listed but not computable for the date counts as charged |
| Search (US-41) | Literal words, case and diacritics ignored, over names, synonyms, definition, parameters, notes and schedule uraian; HS codes in any format by digit prefix; at most 200 characters |
| Sorting (US-42-N1) | Known USD/MT amounts sort numerically; rows without a computable amount follow, grouped by reason, in both directions |

The catalogue is computed in memory from the published data on each request (fine for the palm scope of a few
hundred products); the materialised view in the Technical Design is the route if it grows to thousands.

**Differences from the original Technical Design (now recorded in Technical Design v0.2, §10).** HS codes and parameters are
children of the product version, and amendment links and documents children of the regulation version, rather
than separately versioned records, so a product and everything printed with it is reviewed as one item.
Reference series are change-set records too, so a new Harga Ekspor series is reviewed like other data.
Validation builds the candidate state in memory instead of temporary tables (hundreds of records). BR-TRF-01 is
enforced by validation under the publish lock rather than an exclusion constraint on a helper table; BR-REF-01
has both (`ref_value_no_overlap`, which needs the `btree_gist` extension).

### Exports and evidence packs

CSV (UTF-8 with BOM, CRLF) and XLSX (one sheet, frozen header row, filter on the table, amounts as numbers) are
written in-process (`backend/src/exports/tabular.ts`); no spreadsheet library. Text cells starting with `=`, `+`,
`-`, `@`, tab or CR get a leading `'` (US-47-N1 AC2). Every export is audited as `EXPORT_DOWNLOADED`. The web app
shows the export links only to roles with `export.run`; *Copy link* copies the catalogue permalink.

**Large exports (US-47-N1 AC3).** A catalogue export above `EXPORT_ASYNC_THRESHOLD` rows (default 50,000) is not
streamed: the API answers `EXPORT_TOO_LARGE` and the web app queues it with `POST /api/exports/jobs` (a POST, so it is
CSRF-protected, never a side effect of a link). The job pins the data version current at the request, so the file shows
the data as it was asked for. An in-process runner (`EXPORT_JOB_INTERVAL_MS`, default 15 s, also started right after a
request) builds the file with the same code as the direct export, stores it under `exports/{yyyy}/`, and notifies the
requester in ECR and by email with a link to `/exports/{id}`, which opens only after sign-in. Only the requester can see
the job or download the file, for 24 hours; then the runner deletes the file and keeps the job as EXPIRED. A run lost
with its process is queued again after 30 minutes; a query that cannot run fails at once and the requester is told
(`EXPORT_FAILED`). Audit: `EXPORT_REQUESTED`, `EXPORT_GENERATED`, `EXPORT_DOWNLOADED`, `EXPORT_FAILED`. *My large
exports* (`/exports`) lists them.

An evidence pack (`backend/src/evidence`) is one PDF/A-2b file per saved calculation, `EV-` + UUIDv7. It prints
the inputs, per-line duty and levy with basis, band, price used and legal reference, totals (IDR rounded at the end
only), the reference values and KMK rate with their decrees, the schedule lines as printed, the official source
documents with their SHA-256, the inputs and result hashes, and the disclaimer. Every page footer carries the
evidence ID, the **content SHA-256** (the canonical JSON of everything printed, stored in `evidence_pack.payload`)
and the verification link `${PUBLIC_BASE_URL}/verify/{evidenceId}`. The SHA-256 of the PDF file itself is kept in
the database (a file cannot contain its own hash) and shown on the verification page, which also hashes a PDF
the reader holds, in the browser, to say whether it is the original. Before generating, the calculation is
replayed at its data version; a mismatch is refused and audited. Packs are immutable (trigger) and kept 10 years
(`retain_until`). Files go to the object store under `evidence/{yyyy}/`.

The PDF is written by a small PDF/A-2b writer (`pdfa.ts`): DejaVu Sans (from the `dejavu-fonts-ttf` package,
free licence) embedded as TrueType with unused glyph outlines removed, WinAnsi encoding (characters outside it,
such as `≤`, print as `<=`), an sRGB output intent built in code, XMP with `pdfaid:part 2`/`conformance B`, no
encryption, scripts, links or transparency. This replaces the headless-Chromium route in the Technical Design. It
has not yet been checked with veraPDF (no Java here); run `verapdf --flavour 2b` on a sample in CI before go-live.

### Rollback

A Checker rolls back data version *v* from its change set (*Roll back version v*, with a reason and a fresh
authenticator code). ECR builds a ROLLBACK change set straight into SUBMITTED: every record *v* changed gets its
values from before *v* (UPDATE), every record *v* created is withdrawn, and every record *v* withdrew is re-created
under its own id. WITHDRAW is a new item operation: publishing closes the record's current row version without a
successor, so the record leaves the current data and stays in history; nothing is deleted. The rollback is refused
when a later version changed one of the records (roll back the later version first, or correct the data with a normal
change set), and when the result would fail validation (e.g. a withdrawn group still used by a product,
`ROLLBACK-REFERENCED`). The initiator counts as its editor, so another Checker must review and approve it (SoD-1,
US-30-N1 AC2). On publishing, the rolled-back version gets `rolled_back_by_version`; data versions, change sets and
record history show it as ROLLED_BACK.

### Excel import

*Import* (Makers) offers the template: sheets **Products**, **Lines** (schedule lines of a registered BK or PE schedule)
and **Prices** (reference values), plus **About** with the template version and **Lists** with the codes ECR knows.
Columns are found by header; records are referred to by code or label (commodity `PALM`, group `I`, regulation
`PMK 38/2024`, series `CPO`, band table `CPO-17`), products in Lines by the Products sheet's *Row key* or an ECR id,
and decrees by document number or SHA-256 of an uploaded source document. A filled *ECR id* changes that published
record; its empty cells keep the published values.

The upload (≤ 10 MB, `.xlsx` only, virus-scanned) is read by a strict reader (`backend/src/imports/xlsx-reader.ts`):
no macros, DTDs, encryption or over-compressed parts. Formula cells and text starting with `=`, `+`, `-` or `@` are
errors. Every row goes through the same parser as the editors, so the report lists all of a row's problems at once;
once all rows read, the whole set goes through the change-set validation and its findings are mapped back to sheet,
row and column. The dry run saves only the job and its report (`import_job`); *Create change set* reads the stored
file again, re-checks it and creates one IMPORT change set (DRAFT) whose items carry their sheet row
(`change_item.import_row`). The Maker then submits it as usual.

### Notifications

Every notice is written in the same transaction as the workflow change that causes it (`notification` plus an
`email_outbox` row), so it exists exactly when the change does. The in-process `email-outbox` job sends due emails every
`EMAIL_OUTBOX_INTERVAL_MS` (default one minute) and retries failures with back-off (1, 2, 5, 10, 30, 60, 120 minutes;
FAILED after 8 attempts). Someone deactivated before the email goes out receives nothing (CANCELLED). Emails hold a
title, one sentence and a link into ECR; never item data (US-48-N1 AC2).

| Event | Who is told |
|---|---|
| Change set or rollback submitted | Every active Checker except the set's editors (US-29-P1 AC1) |
| Rejected · returned to draft by failing validation at review · scheduled · schedule cancelled · published | The Maker (US-29-N2) |
| Scheduled publication failed (`publish-due`) | Checkers and the Maker, once a day per set while it keeps failing |
| Version published | Everyone following an affected commodity, product group or product: one notice per version, with a link to the change bulletin and a one-click unsubscribe link per matching subscription (US-48) |

"Affected" uses the same rule as the impact preview: products changed directly, products on changed schedule lines,
and products charged through a changed schedule, band table, reference series or value. People follow things on
*Notifications* or with *Follow changes* on a product page. The nav shows the unread count.

`MAIL_TRANSPORT` picks the transport: `smtp` (nodemailer to the corporate relay, STARTTLS required; mandatory with
`COOKIE_SECURE=true`), `log` (local development: the message is written to the API log) or `memory` (tests).

### Audit log

*Audit log* (`/admin/audit`, `audit.read`: Auditors and Super Admins) searches the hash-chained trail by person (name,
email or `system`), action, entity type and id, and WIB dates; the filters stay in the address. Each row opens to the
recorded values before and after, the user agent, the session and the event hash (US-50-P1 AC1). *Verify hash chain*
recomputes the whole chain. *Export CSV/XLSX* (`audit.export`) exports the filtered events oldest first, with the chain
status checked at that moment in the header; the export is itself audited. There is no route that changes or deletes
an event (US-50-N1 AC1). The narrower views of the permission matrix (Makers and Checkers on their own data, User Admins
on identity events) are not built; those roles see history on change sets and records instead.

### Access reviews

PRD F-12 and L2-1.9. The `access-review` job opens a campaign on the first run of each quarter (normally its first
day, 08:00 WIB; a fresh server opens the current quarter's at once) with one item per live role assignment, holding the
user's status and last sign-in at that moment. *Access reviews* (`/admin/reviews`) shows each campaign; User Admins keep
or revoke each assignment with a fresh authenticator code, and assignments of anyone holding USER_ADMIN or SUPER_ADMIN
are reviewed by a Super Admin (BR-IAM-02). Nobody reviews their own access (SoD-3), and a revoke follows the same rules
as *Users* (SoD-2, at least two Super Admins). Items not decided 14 days after the start are escalated: marked, and Super
Admins are alerted once a day. The last decision closes the campaign and stores a PDF/A-2b report listing every decision;
its footer prints the SHA-256 of its content and an HMAC-SHA256 signature of that hash made with the server key
(`ECR_ENCRYPTION_KEY`). Auditors and Super Admins are notified and can download it and check the stored file, content
and signature from the page.

### Configuration

PRD F-52. *Configuration* (`/admin/config`, Super Admins) changes these settings; a saved value overrides the
environment value and *Restore default* returns to it. Each save needs a fresh authenticator code and a reason, is
audited as `CONFIG_CHANGED` with the values before and after, and applies at once: open sessions get the new idle and
absolute limits, sessions beyond a lower per-person limit end, and the network guard uses the new list on the next
request. Other API instances reload saved values every `SETTINGS_REFRESH_MS` (default 5 s).

| Setting | Allowed (US-52-N1) | Default |
|---|---|---|
| Idle timeout | 5–60 min | 30 |
| Idle timeout for privileged roles | 5–60 min, not longer than the general one | 15 |
| Absolute session limit | 1–12 h | 8 |
| Sessions per person | 1–5 | 3 |
| Authenticator confirmation (step-up) valid for | 1–15 min | 5 |
| Roles at first sign-in | non-privileged roles only, or none | `JIT_DEFAULT_ROLES` |
| Office and VPN networks | 1–50 addresses or CIDR ranges, not `0.0.0.0/0`, must include the saver's own address | `ALLOWED_NETWORKS` |
| Disclaimer | 20–1000 characters | the wording in `config.ts` |

A saved calculation keeps the disclaimer it was made with, so replays and evidence packs still match after the wording
changes. A stored value that breaks the limits (edited in the database) is ignored with a warning and the default used.
The DWS Hub client, redirect URI, mail, virus scan and cookie settings are shown read-only: they need a deployment. The
authenticator rule for privileged roles is set by `TOTP_EXEMPT_ROLES` (deployment). Email templates (FR-CFG-01) are not configurable yet.

### Scheduled jobs

A scheduler in the API process (`backend/src/jobs`) checks every `SCHEDULER_TICK_MS` (default one minute) which jobs
are due. Each run takes a PostgreSQL advisory lock named after the job, so with several API instances only one runs it,
and is recorded in `job_run`; a run still RUNNING after two hours is marked FAILED (its process died). A job that throws
alerts Super Admins once a day. *Jobs* (`/admin/jobs`, `audit.read`) shows the last run and history of each; Super
Admins can *Run now* with a fresh authenticator code.

| Job | When (WIB) | What it does |
|---|---|---|
| `dq-nightly` | 01:00 | Every published record through the change-set rules (FR-DQ-01); findings stored without a change set and kept 30 days; *Data quality* (`/data-quality`, `dq.read`) lists the latest run; errors alert Makers and Checkers |
| `dormancy` | 01:30 | BR-IAM-11: last activity (sign-in, reactivation or creation) older than 80 days → one warning to the user; older than 90 days → `DORMANT_DISABLED`, sessions ended, `USER_DORMANT_DISABLED` audited. Never below two active Super Admins (SoD-4): those are kept and Super Admins are alerted. A User Admin's reactivation restarts the 90 days |
| `audit-chain-verify` | 03:30 | Recomputes the whole hash chain (US-50-N1 AC2); a break is recorded as `AUDIT_CHAIN_BROKEN`, alerts Super Admins and Auditors, and the run is FAILED |
| `source-watch` | 06:00 | See *Source watch* below |
| `ref-gap-check` | 07:00 | Each reference-price series used by a schedule line and each KMK series needs a value covering today (US-27-N2); missing ones alert Makers and Checkers |
| `access-review` | 08:00 | Opens this quarter's access review if it has none and tells User Admins; escalates items still open 14 days after their campaign started (see *Access reviews*) |
| `jwks-refresh` | every 6 h | Reloads the DWS Hub discovery document and checks the JWKS still has an RS256 or ES256 signing key |
| `session-sweep` | every 15 min | Ends sessions past their idle or absolute limit, deletes expired sign-in states and sessions ended more than 30 days ago |

A daily job runs at the first tick after its time, also when the server was down at that moment (a fresh server runs
every daily job once on its first tick). `publish-due`, `email-outbox` and the export runner keep their own short
intervals.

### Source watch

PRD FR-SRC-03 and FR-SRC-04 (`backend/src/source-watch`). Every day at 06:00 WIB the API reads the official
publishers over HTTPS and records what a Maker should look at; it never changes registry data. *Source watch*
(`/source-watch`, Makers, Checkers, Auditors and Super Admins) lists the items; a Maker marks each *done* (entered in a change set) or
*dismissed* with a reason. New items notify Makers and Checkers.

| Check | Read from | Reported as |
|---|---|---|
| Status and amendments of each regulation with a BPK link | its `peraturan.bpk.go.id/Details/…` page: *Status*, *Diubah dengan*, *Dicabut dengan* | `STATUS_CHANGE` when BPK no longer lists it as in force, or names an amending or revoking regulation not registered in ECR |
| New documents | BPK search, newest first, for "bea keluar", "dana perkebunan" and "kelapa sawit"; JDIH Kemendag for "harga referensi" | `NEW_DOCUMENT` for an entry not seen before (and not already registered) |
| New files of a registered regulation | its JDIH Kemenkeu `/dok/…/files` page | `NEW_FILE` (e.g. a corrigendum or annex) |
| Stored PDFs with a direct official `.pdf` link | the official file, re-downloaded | `FILE_CHANGED`; the document is marked `recheck_mismatch`, which blocks records citing it (SRC-HASH) |

The first read of a listing only records what is there, so the watch reports what appears afterwards. Each finding has
a fingerprint and is reported once. A page that cannot be read is listed in the run's details; when none can be read the
run fails and Super Admins are alerted. The server needs outbound HTTPS to `peraturan.bpk.go.id`, `jdih.kemenkeu.go.id`,
`jdih.kemendag.go.id` and the publishers of stored PDFs (UAT/production: allow these on the egress proxy). The listings
and their keywords are in `LISTINGS` in `source-watch.service.ts`.

### Logout

`POST /api/auth/logout` — Technical Design §4.1.4. A live session needs `X-CSRF-Token`; an expired one does
not; no session still returns 200. Always clears cookies and sends `Cache-Control: no-store` and
`Clear-Site-Data: "cache", "storage"`. DWS Hub has no end-session endpoint (T-05), so the response has
`hubSessionEnded: false` and the web app links to the Hub dashboard.

## Repository layout

```
backend/           API (NestJS): src/, migrations/, test/, db/init/ (PostgreSQL init scripts), Dockerfile,
                   docker-compose.staging.yml, deploy/, var/ (local file storage and official PDFs; not in git)
frontend/          Web app (React + Vite): src/, index.html, nginx.conf.template, Dockerfile,
                   docker-compose.staging.yml, deploy/
docs/              PRD, review of the prototype, DEPLOY-STAGING.md
assets/            The original HTML prototype
package.json       npm workspaces (@ecr/api = backend, @ecr/web = frontend) and the root scripts below
docker-compose.yml Database, and the whole app in Docker
.env               Local settings for both (copy of .env.example)
```

Run every command below from the repository root. Staging (FE 172.28.92.56:3160, BE 172.28.92.57:4160, ApsaraDB
RDS, DWS Hub SDK and Sentinel): [docs/DEPLOY-STAGING.md](docs/DEPLOY-STAGING.md).

## Run locally

Prerequisites: Node 22.12+, Docker Desktop. Ports: database 5443, API 3100, web 5173, Hub stub 4000.

```bash
cp .env.example .env        # then set ECR_ENCRYPTION_KEY (command is in the file)
npm install
npm run db:up               # PostgreSQL 18 on localhost:5443 (+ ecr_test database)
npm run migrate
npm run dev:hub             # local DWS Hub stand-in on http://localhost:4000 (skip when using the real Hub)
npm run dev:api             # http://localhost:3100/api
npm run dev:web             # http://localhost:5173 (proxies /api)
```

With the stub you sign in as `dev.admin@corp.example`; switch person with
`http://localhost:4000/dev/as?email=someone@corp.example&name=Someone`.

**Run it in Docker.** The same app as containers: migrations, API, web (nginx, which proxies `/api`) and the Hub
stub, on the same database, `.env` and `backend/var` as above, so accounts, authenticators and documents carry over.

```bash
docker compose up -d --build    # http://localhost:8095; Hub stub on http://localhost:4100 (also after code changes)
docker compose logs -f api      # API log (emails go here with MAIL_TRANSPORT=log)
docker compose down             # stop; the database volume is kept
```

Switch person with `http://localhost:4100/dev/as?email=someone@corp.example&name=Someone`. The stub runs in the
API container's network, so `localhost:4100` is the same address for the browser and the API. Ports are published
on 127.0.0.1 only. Update the whole stack rather than `up api` alone: a recreated API container needs the stub
re-attached, which `up` of the whole stack or of `web` does. The project network is fixed at 192.168.32.0/24 because its gateway is the browser's address
as the API sees it; `ALLOWED_NETWORKS` in the compose file allows only that and loopback. A list saved on
*Configuration* overrides it for both ways of running. The containers and `npm run dev:*` can run side by side.

**Walkthrough.** Grant one person MAKER and another CHECKER (each must sign in once first), set up their
authenticators, then: *Change sets → New change set* → add a regulation (upload its PDF), a commodity, a group
and a product → *Submit for review*; as the Checker *Start review → Approve*. The records then appear under
*Regulations* and *Products*. In a second change set add the CPO reference series and this month's value (upload
the decree), a band table (*Fill from upper edges*: `680, 730, …, 1430` gives the 17 CPO bands), a BK schedule
and a `BAND_USD_PER_MT` line for the product; the change set shows the impact, and once published the product
page shows its duty per tonne and *Schedules* and *Prices* list the data. *Catalogue* then lists the product
with its charges, and *Calculator* works out a shipment (add a `FX-USDIDR` series and value for IDR).

**Source documents.** Files are stored under `backend/var/storage` locally (the OSS bucket in UAT and
production). Uploads are virus-scanned by ClamAV when `CLAMD_HOST` is set; without it they are recorded as
`NOT_SCANNED`, which is refused at startup wherever `MALWARE_SCAN_REQUIRED` is true (the default with
`COOKIE_SECURE=true`).

**HS codes.** Migration 0005 seeds BTKI 2022 with the 141 codes the prototype's palm rows use. Load the full
tariff book (CSV with `code` and `description` columns) before go-live:

```bash
npm run load:btki -- --file btki-2022.csv --version "BTKI 2022" --reason "Full BTKI 2022 from INSW"
```

To use the real DWS Hub instead, register ECR in Hub Admin (`sso_mode = oidc`, unique `oauth_client_id`,
redirect URI `http://localhost:5173/api/auth/callback`, launch URL `http://localhost:5173/api/auth/login`)
and set `HUB_ISSUER`, `OIDC_CLIENT_ID` and `HUB_DASHBOARD_URL` in `.env`.

**First Super Admins.** Each person signs in once (gets VIEWER), then an operator grants the role; SoD-4
needs two:

```bash
npm run grant:role -- --email alice@corp.example --role SUPER_ADMIN --reason "Initial platform owner"
```

From then on, roles are managed on the Users page.

## Tests

```bash
npm test
```

Uses `TEST_DATABASE_URL` (the Docker database) when reachable, otherwise a throw-away embedded PostgreSQL 18
(`embedded-postgres`, initialised as UTF-8). Seventeen files, 131 tests, run against an in-process DWS Hub stub that follows the strict
OIDC contract:

- `test/auth.test.ts` — sign-in, just-in-time accounts, identity conflicts, token failures (wrong audience or
  issuer, HS256, expired, nonce mismatch), replayed state, login CSRF, open redirects, idle expiry, logout,
  audit chain, network allow-list.
- `test/admin.test.ts` — authenticator enrolment, step-up, replay refusal, lockout after five wrong codes,
  single-use recovery codes, the permission guard, user administration with SoD-2/3/4 and BR-IAM-02,
  deactivation, authenticator reset, audit log API.
- `test/registry.test.ts` — regulation register and source documents (unsafe, oversized and unofficial files,
  de-duplication, immutability), product and HS validation, shared HS codes, record locking, four-eyes and
  step-up, reject and rework, scheduling and publish-due, stale change sets, history and database guards.
- `test/malware-scan.test.ts` — ClamAV INSTREAM client and refusal of an infected upload (fake clamd).
- `test/load-btki.test.ts` — CSV parsing for the BTKI loader.
- `test/tariffs.test.ts` — reference values (decree, overlap in validation and database, 30 % jump, gaps), band
  tables, band edges, duty by price band and levy as % of price, listed at 0 vs not listed, missing prices,
  invalid lines, impact preview with exact decimals, Harga Ekspor with previous-period fallback.
- `test/catalogue.test.ts` — calculator (USD and IDR, rounding, invalid inputs, missing values, what-if, Harga
  Ekspor fallback, shared-HS warnings, save and replay across data versions, tamper detection) and catalogue
  (categories and tiles that add up for every filter combination, search, suggestions, facets, unit-safe
  sorting, paging, past versions, scheduled changes for future dates).
- `test/exports.test.ts` — catalogue and calculation CSV/XLSX (header block, filters, exact amounts, formula
  injection, permission, author only), evidence packs (one per calculation, PDF/A markers, hashes, payload,
  simulations and incomplete results refused, verification by others, download by author and auditor, tampered file,
  replay mismatch, immutability), and a changed disclaimer on new results while saved calculations still replay.
- `test/import-rollback.test.ts` — rollback (step-up, SoD-1, restore and withdraw, history marks, undoing a rollback,
  later-version conflicts, broken references, cancel) and Excel import (template, dry run without writes, commit into
  one change set with row lineage, row-level errors and the Excel report, formula cells, outdated template, unsafe
  files, locked records).
- `test/notifications.test.ts` — Checkers told on submit (not the editors), Maker on reject, no draft data in emails,
  read state, subscriptions by commodity, group and product with one notice per version, deactivated users skipped,
  change bulletin, signed one-click unsubscribe, scheduling and daily publish-failure alerts, retry with back-off, and
  delivery through a fake SMTP relay.
- `test/export-jobs.test.ts` — exports above the limit refused with the job address, queued job built at the pinned
  version, requester-only notice, email and download, expiry and file removal, open-job limit, failed jobs.
- `test/jobs.test.ts` — scheduler due times (WIB daily slots and intervals, one run each), reference-price gap alert,
  nightly data-quality findings and dashboard, dormancy warning, disabling, SoD-4 protection and reactivation, session
  sweep, *Run now* with step-up, and the critical alert on a broken audit chain.
- `test/sources.test.ts` — documents with what cites them, decrees visible to Viewers once a published value cites them,
  uncited drafts hidden, and opening in the browser or downloading.
- `test/source-watch.test.ts` — BPK page and label parsing, an amendment not registered in ECR, listing baselines,
  new documents, a new JDIH file and a changed official PDF reported once, closing items (reason to dismiss, Makers
  only, audited), and a failed run when no source can be read; the official sites are replaced by test pages.
- `test/access-reviews.test.ts` — one campaign per quarter covering every live assignment, Super Admin review of
  administrators, SoD-3 and step-up, revoke ending the user's sessions, a role removed elsewhere, 14-day escalation,
  and completion with a downloadable signed report whose tampering the check detects.
- `test/settings.test.ts` — configuration listing (Super Admins only), every limit refused with its range (privileged
  default role, lock-out allow-list, privileged idle longer than general), step-up, changes applied to open sessions and
  new sign-ins with before/after audit, session cap, roles at first sign-in, allow-list, and an out-of-range stored value.
- `test/audit-log.test.ts` — audit search by name or email, `system`, several actions, entity and WIB day boundaries,
  facets, CSV/XLSX export with the chain status and formula-safe text, export permission, and a broken chain in the
  export header.
