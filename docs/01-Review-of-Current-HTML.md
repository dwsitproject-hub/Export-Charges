# Review & Critique — `assets/Indo HS code and tarif.html`

| Item | Detail |
|---|---|
| Artefact reviewed | `assets/Indo HS code and tarif.html` (single file, 348 lines, ~125 KB, of which ~122 KB is one embedded JSON line) |
| Page title | *Palm Export Charges — Products, HS Codes, Specs, Duty & Levy* |
| Data stamp | "Compiled 14 August 2026" |
| Review date | 28 October 2026 |
| Method | Full read of HTML/CSS/JS + programmatic profiling of all 143 embedded data rows |

---

## 1. What the page is (understanding)

A self-contained, client-side reference table that joins **three legal sources** on product identity:

| Source | Role in the page | Field in data |
|---|---|---|
| *Rancangan* Permenperin — Klasifikasi Komoditas Turunan Kelapa Sawit (Lampiran) | Product master: group, item no., name, HS code(s), definition, technical ID parameters, annex page | `product`, `hs`, `definition`, `params`, `notes`, `page` |
| PMK 68/2025 (amending PMK 38/2024) — **Bea Keluar (Export Duty, BK)** | Palm: USD/MT across 17 CPO reference-price bands. Non-palm: flat ad-valorem %. Cocoa: % by cocoa reference price | `bk.rates[17]`, `bk.pctFlat`, `bk.cocoa` |
| PMK 9/2026 (amending PMK 69/2025) — **Pungutan Ekspor (Export Levy, PE / BPDPKS)** | % of CPO reference price, or fixed USD/MT | `pe.pct`, `pe.usd` |

The user enters a **CPO reference price** (default USD 900/MT) and the page computes Duty, Levy and Total per MT, with filters (search, charge status, derivative group), sorting, KPI tiles, and an expandable detail row (definition, parameters, duty band strip, schedule references, shared-HS warning).

### Data profile (measured, not estimated)

| Metric | Value |
|---|---|
| Total rows | **143** |
| Palm rows (Groups I–V) | 122 (I = 17, II = 14, III = 18, IV = 37, V = 36) |
| Non-palm rows | 21 (Hides 6, Wood 7, Metal minerals 6, Pine resin 1, Cocoa 1) |
| Duty **and** levy | 36 |
| Levy only (no duty) | 8 — matches the footer claim |
| Duty only (no levy) | 22 (21 non-palm + *Bungkil Pakan Ternak*) |
| Neither charge | **77 (54 %)** — classification-only products |
| Rows sharing an HS code with another row | 39 (of which 19 are uncharged) |
| Rows using partial "ex" HS codes | 85 |
| Distinct HS codes / codes reused across rows | 192 / 64 |
| Levy % values in use | 7.25 %, 10 %, 12 %, 12.5 % (+ fixed USD 0/5/15/25/30) |
| Duty bands | 17 labels / 16 edges (≤680 … >1,430) — consistent |
| Duty rate arrays | All 17 long and monotonic non-decreasing — consistent |
| Palm rows without definition | 4 (Split PFAD, Split PKFAD, Hydrogenated Crude PKO-based, Hydrogenated PKFAD) |
| Palm rows without technical parameters | 13 |

---

## 2. What is good (keep these in the production product)

1. **Correct join key philosophy.** It explicitly states that *product identity*, not HS code alone, determines the charge, and surfaces **shared tariff posts** as a declaration risk. This is the single most valuable insight in the page.
2. **Band-based duty model is right.** Palm BK is a stepped USD/MT table by CPO reference band; levy is a continuous % of the same reference price. The band strip in the detail row makes the step function visible.
3. **Provenance per row.** Each row links back to classification item no., annex page, PMK annex (*Lampiran / Kelompok / no.*) and quotes the schedule *uraian*.
4. **Honest caveats.** Draft status of the Permenperin, numbering defects in the source, and the 8 levy-only "circumvention gap" products are disclosed.
5. **Lightweight and offline.** Zero dependencies, works from a file, dark mode supported, output is HTML-escaped.

---

## 3. Critique — gap against the stated goal

> **Goal:** *"a structured list of Indonesia regulation of Levy and Duty on **all** export products."*

### 3.1 Scope gaps (biggest issue)

| # | Gap | Impact |
|---|---|---|
| S1 | **It is a palm tool, not an all-export-products registry.** 85 % of rows are palm derivatives; non-palm is a 21-row appendix covering only BK Annexes A, B, E, F, G. | Does not meet the stated goal. |
| S2 | **Non-palm export levies are not modelled.** The page itself notes a cocoa levy schedule (PMK 69/2025 Lampiran C) but holds no data for it. Any other commodity levies under the same PMK family are absent. | Under-reports charges for non-palm exporters. |
| S3 | **No regulation register.** Regulations are free text in the footer; there is no list of instruments with number, issuer, status (draft / in force / revoked), promulgation date, effective date and amendment chain (e.g. PMK 38/2024 → 68/2025; 69/2025 → 9/2026). | Users cannot tell which law governs a row or whether it is still valid. |
| S4 | **No time dimension.** One snapshot, one hard-coded default reference price (900). Reference prices are set per period by the Ministry of Trade, and the PMKs are amended frequently. | Cannot answer *"what was due on a shipment dated X?"* — the core audit/tax question. |
| S5 | **Non-tariff export obligations are out of scope** (export bans/restrictions, export approvals, surveyor verification, export-proceeds retention, DMO). | Acceptable for v1, but must be an explicit scope decision, not silent. |
| S6 | **Regulatory content is unverified in the artefact.** The classification is explicitly a *draft* (tracked changes, blank signature dates). Rates must be re-verified against the official gazette (JDIH Kemenkeu / Kemendag / Kemenperin) before being used for declarations. | Legal/financial risk if used as a source of truth. |

### 3.2 Functional & calculation defects (verified in the code)

| # | Defect | Evidence | Severity |
|---|---|---|---|
| F1 | **Default sort contradicts the page text.** Header says non-palm items are "at the bottom", but the default sort key is `scope + groupLabel + no` and `"non-palm" < "palm"` alphabetically, so **non-palm rows render first**. | `render()` sort, `sortKey='group'` | Medium |
| F2 | **KPI tiles do not reconcile.** Tiles show *duty+levy*, *levy-only* and *no charge* but omit **duty-only (22 rows)**, so 36 + 8 + 77 = 121 ≠ 143. | `el('tiles').innerHTML` | Medium |
| F3 | **"Shared HS risk" tile vs pill mismatch.** Tile/filter count all 39 rows with a shared code; the warning pill is shown only on the 19 uncharged ones. | `nShared` vs `risk` | Low |
| F4 | **Mixed units in one numeric column.** Duty column mixes USD/MT (palm) and % ad-valorem (non-palm). Sorting by Duty treats % rows as `-1`; Total shows "—" for them. No FOB/export-value input exists to convert % to money. | `dutyOf()`, sort | High |
| F5 | **Cocoa duty is not calculable.** Shows static "0–7.5 %"; there is no cocoa reference-price input although the band data (`bk.cocoa`) exists. | `dutyOf()` | Medium |
| F6 | **No quantity / shipment calculation.** Results are per MT only; no tonnage × rate, no IDR conversion (exchange rate *Kurs Menteri Keuangan*), no rounding rules. | — | Medium |
| F7 | **String truncation after escaping.** `esc(r.pe.uraian).slice(0,150)` can cut an HTML entity in half (e.g. `&am`) and silently drops the rest of the legal description. | `detail()` | Low |
| F8 | **Confusing shared-HS text.** Renders "(levy I · USD 30)" — the Roman numeral is the *Kelompok*, not a rate. | `detail()` warn box | Low |
| F9 | **HS search is format-sensitive.** `15111000` or `1511 10 00` does not find `1511.10.00`; schedule *uraian* text is not searchable. | `render()` filter | Low |
| F10 | **One HS cell is not a code.** `"ex 4407 (all subheadings listed in Annex A)"` breaks HS validation, sorting and any future integration. | data row `np-10` | Low |
| F11 | **"No charge" is ambiguous.** It means "not listed in any schedule", not "rate is zero"; these are different legal positions (cf. FFB which is listed with USD 0). | tiles, pills | Low |

### 3.3 UX, accessibility and front-end quality

| # | Issue |
|---|---|
| U1 | **Sticky table header does not work** — `.card{overflow:hidden}` makes the card the sticky container, so the header scrolls away with the page. |
| U2 | **Not usable on mobile** — 7-column table inside `overflow:hidden` with no horizontal scroll; columns are crushed/cut. |
| U3 | **Keyboard/screen-reader access** — rows and column headers are click-only (`tr`/`th` with no `tabindex`, no `aria-expanded`, no `aria-sort`). Fails WCAG 2.1 AA 2.1.1. |
| U4 | **Full re-render on every keystroke** and re-binding of all row listeners; acceptable at 143 rows, will not scale to an all-products registry (thousands of rows). |
| U5 | **Language mix** — UI in English, product names/definitions in Bahasa Indonesia, with no language toggle. |
| U6 | **No export, print, permalink or saved state** — users cannot share a filtered view or attach a calculation to a shipment file. |
| U7 | Invalid CSS shorthand `font:14px inherit` (silently ignored). |

### 3.4 Data governance & production-readiness (blocking)

| # | Issue |
|---|---|
| G1 | **Data is hard-coded in the HTML.** Any rate change requires a developer to edit a 122 KB JSON line. No validation, no review, no rollback. |
| G2 | **No maker-checker / approval.** A single wrong digit in a band array changes every shipment's duty with no second pair of eyes. |
| G3 | **No audit trail or versioning** — who changed what, when, why, under which regulation. |
| G4 | **No authentication or access control** — anyone with the file can alter and redistribute it as if authoritative. |
| G5 | **No effective-dating** of products, HS mappings, rates or reference prices. |
| G6 | **Source numbering defects** (duplicate item 10 in Group II, 4 in Group IV, 27 in Group V; missing 3 in Group III) are carried as-is; a production system needs a surrogate key plus the "as printed" number. |
| G7 | **No BTKI version** stated for HS codes (8-digit Indonesian tariff book), so codes cannot be validated or migrated when BTKI is revised. |

---

## 4. Verdict

| Dimension | Rating (1–5) | Comment |
|---|---|---|
| Domain insight | **4** | Shared-HS risk, band model, provenance — strong. |
| Data completeness vs "all export products" | **1.5** | Palm-centric; non-palm levy, regulation register and history missing. |
| Calculation correctness | **3** | Palm per-MT logic is sound; ad-valorem, cocoa, quantity and FX not handled. |
| UX / accessibility | **2.5** | Clean visual design; sticky header, mobile and keyboard access broken. |
| Production readiness | **1** | No backend, auth, RBAC, audit, approval, or versioning. |

**Conclusion:** an excellent *analyst's prototype* for palm derivatives and a good source of the product/rate data model, but not a system of record. The accompanying PRD (`docs/02-PRD-Export-Duty-Levy-Platform.md`) turns it into a governed, multi-commodity, effective-dated platform with login, RBAC and admin registration, and keeps the strengths listed in §2.

### Top 10 fixes carried into the PRD

1. Regulation Register with status, effective dates and amendment chain (S3, G5).
2. Effective-dated rates and monthly reference prices; "as-of date" lookup (S4).
3. Commodity-agnostic data model covering all BK and PE schedules (S1, S2).
4. Calculator with quantity, FOB value (for ad valorem), commodity-specific reference price and IDR conversion (F4–F6).
5. Maker-checker approval and versioned publishing (G1, G2).
6. Immutable audit trail (G3).
7. Authentication, MFA for privileged roles, RBAC, invite-based admin registration (G4).
8. HS normalisation, BTKI versioning, structured "ex" handling (F9, F10, G7).
9. Accessible, responsive UI with export/permalink (U1–U6).
10. Data-quality checks (duplicate item numbers, missing definitions, shared HS) on import (G6).
