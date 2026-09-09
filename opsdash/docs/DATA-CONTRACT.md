# Data Contract v1 — Accounting / CEO Ops Dashboard

**Status:** fixed for Phase 2 fan-out. Revised after reading the live Google
Sheets; aiops is out of scope. Three open items in §7 gate Phase 3.
**Authority:** this document + `db/migrations/001_accounting_core.sql`. Where they
disagree, the migration wins — it is the artifact that has actually been executed.
**Verified:** migrations apply clean on PostgreSQL 16; all twelve assertions in
`db/verify/002_contract_assertions.sql` pass. Run `npm run db:verify`.

---

## 1. Where this lives

**The aiops Postgres is out of scope.** It is not read, not written, not joined
to. This build owns a standalone PostgreSQL database, and every table lives in
an `accounting` schema inside it.

Inputs are exactly two:

| Input | Path | Provenance kind |
| --- | --- | --- |
| Google Sheets | read via the Drive connector | `connector` |
| Dropped documents | PDF / XLSX / CSV upload | `document` |

Sheets are read-only sources. Nothing this build does writes back to a sheet:
the operator's spreadsheet stays theirs, and the ledger is derived from it.

Sheet identity (Drive file id and tab) is configured at runtime in
`accounting.sheet_source`, never committed. This repository is public, and a
file id alongside a business name is a targeting aid.

## 2. The provenance model — the load-bearing idea

§8's first criterion ("every P&L figure traces to a source document or connector
pull") is enforced by a database constraint, not by convention. Every
`ledger_entry` declares a `source_kind` and the `provenance_matches_kind` CHECK
requires the matching pointer:

| `source_kind` | Required pointer | Means |
| --- | --- | --- |
| `document` | `source_document_id` | came off a dropped PDF/XLSX/CSV |
| `connector` | `connector_pull_id` | read from a `public.*` table |
| `derived` | `calc_run_id` | computed by the IFTA or permit engine |
| `adjustment` | `reverses_entry_id` | a human correction |

An entry that cannot name its origin **cannot be inserted**. Verified by assertion 1.

Two consequences the Phase 2/3/4 agents must design around:

- **`connector_pull` stores a `jsonb` snapshot of the upstream row, not a foreign
  key to it.** n8n keeps rewriting `public.*`; a pointer would silently change
  meaning after the fact. "Traced to a connector pull" is only true if we can show
  what the pull returned *at posting time*.
- **The ledger is append-only** (trigger-enforced; assertions 3a/3b). A correction
  posts a reversing entry. Nothing is ever `UPDATE`d or `DELETE`d, so a filed
  quarter cannot retroactively change under an auditor.

## 3. Money and identity rules

- Money is `numeric(14,2)`, quantities `numeric(14,4)`, tax rates `numeric(10,5)`.
  **No floating point anywhere in the money path.** Verified by assertion 6.
- `amount` is signed: **positive = inflow, negative = outflow**. `category.sign`
  states the expected direction per category; the P&L engine must not re-derive
  sign from the category name.
- Dimensions are **snapshotted onto the ledger row at post time**
  (`entity_id`, `truck_id`, `driver_id`, `driver_class`). A truck moving from Zone
  to Xtrack, or a driver converting from company to lease-to-own, must not silently
  restate a closed period. `truck_entity_history` and `driver_class_history` are
  what the posting code reads to resolve the correct value for the accrual date.
- Upstream systems disagree on identity. `source_key_map` is the single crosswalk
  from any `(source_system, source_key)` to a canonical `entity`/`truck`/`driver`.
  Nothing else may join on truck numbers by string match.

---

## 4. Table map

| Group | Tables |
| --- | --- |
| Dimensions | `entity`, `truck`, `driver`, `truck_entity_history`, `driver_class_history`, `source_key_map` |
| Taxonomy | `category` |
| Ingestion (§4.1) | `source_document`, `staging_row` |
| Connector provenance | `connector_pull`, `sheet_source` |
| Ledger | `ledger_entry` (incl. `charged_to`, `unit_type`) |
| Engines (§4.3–4.4) | `calc_run`, `ifta_rate`, `ifta_liability`, `permit_rate`, `permit_cost` |
| P&L (§4.5) | `pnl_period` *(cache — see below)* |
| Prediction (§4.6) | `forecast_run` |
| Reconciliation (§8) | `fuel_reconciliation` |
| Audit | `audit_event` |

`pnl_period` is a **cache, never the source of truth**. It must be fully
rebuildable from `ledger_entry` alone, and Phase 4 must ship that rebuild path.
Materializing every grain × entity × truck × driver × class combination is a
combinatorial trap; the atomic fact table is `ledger_entry` and the cache holds
only what the dashboard actually renders.

`staging_row` keeps `parsed_payload` (immutable, what the parser read) alongside
`reviewed_payload` (the operator's edits). An edited number therefore still traces
to both the document and to what the machine originally extracted — which is the
difference between a correction and a silent estimate.

---

## 5. Where the numbers come from

Established by reading the live sheets, not by assumption. Structures, and the
defects each parser must survive, are in `docs/SOURCE-DISCOVERY.md`.

| Need | Source | Written into |
| --- | --- | --- |
| Revenue | Dispatch Sheet, weekly per truck | `ledger_entry` via `connector` |
| Driver class | Dispatch Sheet `Payment` (CPM/LO/OO) | `driver_class_history` |
| Entity | free text in driver name; entity blocks in the fuel summary | `entity`, `source_key_map` |
| Fuel cost | Fuel sheet | `ledger_entry` via `connector` |
| Fuel gallons by state | **EFS/Relay statements only** | `ledger_entry` via `document` |
| Maintenance cost | Truck and trailer expenses sheet | `ledger_entry` via `connector` |
| Toll | partly the expenses sheet, partly documents | `ledger_entry` |
| Chargeback | expenses sheet `Expense side` | `ledger_entry.charged_to` |
| Truck / trailer | expenses sheet `Unit Type` | `ledger_entry.unit_type` |
| Miles by state | **Samsara IFTA export, dropped per quarter** | `ifta_mileage` document |

Three rules that fall out of the real data:

- **Never resolve identity by string match.** `Issued To` writes the same person
  as `"496648 NAME"`, `"Name # 6169"` and `"Name #495803"`. Everything goes
  through `source_key_map`.
- **A no-load day is not a zero-revenue day.** `transit`, `OFF`, `HOME`,
  `TOWING` and `OOS` must post no entry rather than a zero one, or average
  revenue per truck is silently wrong.
- **Parse sheets by header, never by column index.** Column order is not stable
  across sections of the same tab. `sheet_source.header_checksum` exists so a
  layout change fails loudly instead of reading the wrong column as an amount.

Open loads remain forecast input only, never ledger entries.

## 6. API shapes — what the Phase 2 agents build against

Fixed now so the parser agent and the UI agent can work in parallel (§3).
All money as decimal **strings**, never JSON numbers, to survive the float round-trip.

```
POST   /api/documents                 multipart; -> { documentId, sha256, duplicateOf? }
GET    /api/documents/:id             -> { documentId, docType, parseStatus, parseError, rowCount }
GET    /api/documents/:id/rows        -> { rows: StagingRow[] }
PATCH  /api/staging/:rowId            body: Partial<StagingRowEdit> -> { row: StagingRow }
POST   /api/documents/:id/commit      -> { committed: n, rejected: n, entryIds: string[] }
GET    /api/ledger                    ?entity&truck&driver&from&to&category -> { entries: LedgerEntry[] }
GET    /api/pnl                       ?grain&from&to&entity&truck&driver&driverClass -> { lines: PnlLine[] }
```

```ts
type StagingRow = {
  stagingRowId: string
  documentId: string
  rowIndex: number
  sourcePage: number | null
  parsedPayload: Record<string, unknown>   // immutable
  reviewedPayload: Record<string, unknown> | null
  entityId: string | null
  truckId: string | null
  driverId: string | null
  accrualDate: string | null               // YYYY-MM-DD
  categoryId: string | null
  amount: string | null                    // decimal string, signed
  quantity: string | null
  jurisdiction: string | null              // 2-letter
  status: 'parsed' | 'under_review' | 'committed' | 'rejected'
  reviewNotes: string | null
}

type PnlLine = {
  grain: 'day' | 'week' | 'month' | 'quarter' | 'year'
  periodStart: string; periodEnd: string
  entityId: string | null; truckId: string | null
  driverId: string | null; driverClass: string | null
  categoryGroup: string
  amount: string                           // decimal string
  entryCount: number
}
```

`POST /commit` is all-or-nothing per document and idempotent: the
`ux_ledger_staging_once` index means a repeated commit cannot double-post
(verified by assertion 4 for the connector path, same mechanism).

---

## 7. Open items

1. **Miles by state has no source.** No sheet carries it. The Samsara IFTA
   report export, dropped per quarter as an `ifta_mileage` document, is the
   only identified path. **Phase 3 cannot start until one arrives.**
2. **IFTA gallons by state depend on Phase 2.** The Fuel sheet has the purchase
   state (inside a postal address) but records `"full tank"` instead of a
   quantity often enough to be unusable; the fuel summary has real gallons but
   no state. EFS/Relay statements are therefore the authoritative source, which
   makes Phase 3 dependent on Phase 2 rather than parallel to it.
3. **Entity coverage.** Whether `xtrack` and `afg` have their own dispatch and
   expense sheets, or live inside Zone's with entity in free text.

## 8. Application stack

New app at `opsdash/`, not an extension of `driverqual/` — different domain,
different database, and §4's layering requires the calc engine to stay independent
of the qualification app. Stack mirrors the patterns already proven in this repo:
Next.js 15 + TypeScript + zod + vitest + Playwright, with `pg` in place of libSQL.
