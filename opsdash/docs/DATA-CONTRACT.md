# Data Contract v1 — Accounting / CEO Ops Dashboard

**Status:** fixed for Phase 2 fan-out, with three open items in §7 that must be
closed against the live schema before the Phase 3 IFTA agent starts.
**Authority:** this document + `db/migrations/001_accounting_core.sql`. Where they
disagree, the migration wins — it is the artifact that has actually been executed.
**Verified:** migration applies clean on PostgreSQL 16; all seven assertions in
`db/verify/002_contract_assertions.sql` pass.

---

## 1. The read/write boundary

The `public` schema of the aiops database belongs to the n8n workflows. This
build **never writes to it**.

| Schema | Owner | This app's access |
| --- | --- | --- |
| `public` | n8n scheduled ingestion | `SELECT` only |
| `accounting` | this build | full |

Everything new lives in `accounting`. Two reasons, both practical: an n8n workflow
that recreates a table cannot take the ledger with it, and a `SELECT`-only grant on
`public` makes "do not re-ingest data that's already flowing in" (§1) a permission,
not a promise.

Provision a dedicated role before Phase 2:

```sql
CREATE ROLE opsdash_app LOGIN PASSWORD :'pw';
GRANT USAGE ON SCHEMA public TO opsdash_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO opsdash_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO opsdash_app;
GRANT USAGE, CREATE ON SCHEMA accounting TO opsdash_app;
GRANT ALL ON ALL TABLES IN SCHEMA accounting TO opsdash_app;
```

---

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
| Connector provenance | `connector_pull` |
| Ledger | `ledger_entry` |
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

## 5. How the existing tables are used

Per §1's build directive: join, do not re-ingest.

| Need | Existing source | Written into |
| --- | --- | --- |
| Revenue actuals | `load_pipeline`, `dispatch_weekly_summary` | `ledger_entry` via `connector` |
| Open pipeline (prediction) | `load_pipeline` | `forecast_run.basis` — **never** the ledger |
| Fuel reconciliation | `samsara_fuel_reports`, `truck_fuel_history` | `fuel_reconciliation` |
| Mileage | `samsara_vehicle_stats`, `v_truck_miles_30d`, `live_trips` | IFTA + permit engine inputs |
| Truck / driver identity | `samsara_vehicles`, `samsara_drivers`, `live_trucks` | `source_key_map` |
| Entity roll-up cross-check | `weekly_company_summary` | Phase 4 reconciliation test |
| Lease-to-own balances | `debt_balances`, `debt_collections` | `ledger_entry` via `connector` |

**Open loads never post to the ledger.** They are forecast input only. Posting them
would present an estimate as an actual, which §2 forbids.

Toll and maintenance-cost data have no upstream source and arrive **only** through
drag-drop ingestion. `truck_inspections` / `inspection_reports` / `pti_inspections`
are inspection events, not costs, and must not be treated as a maintenance-cost
source.

---

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

## 7. Open items — must close before Phase 3

1. **Per-jurisdiction mileage has no identified source.** §1 lists no table
   carrying miles by state; `v_truck_miles_30d` is a total. The IFTA engine
   (§4.3) needs miles *per state per truck per quarter* and cannot be built
   without it. `db/verify/001_confirm_ground_truth.sql` section B probes for it.
   This is the single biggest schedule risk in the build.
2. **Per-state fuel purchase.** IFTA nets tax-paid gallons by state. Whether
   `samsara_fuel_reports` carries a purchase state is unconfirmed; if not, the
   EFS/Relay documents become the sole IFTA fuel source and Phase 3 hard-depends
   on Phase 2.
3. **Entity attribution.** Which existing column identifies Zone / Xtrack / AFG,
   and whether it lives on the truck, the load, or only on
   `weekly_company_summary`.

---

## 8. Application stack

New app at `opsdash/`, not an extension of `driverqual/` — different domain,
different database, and §4's layering requires the calc engine to stay independent
of the qualification app. Stack mirrors the patterns already proven in this repo:
Next.js 15 + TypeScript + zod + vitest + Playwright, with `pg` in place of libSQL.
