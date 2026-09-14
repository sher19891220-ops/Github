# What I need from you, exactly

Collect these before the next session. Each section says what to export, what
fields are load-bearing, and what happens if a field is missing.

---

## (a) QuickBooks OAuth2 credentials

From the Intuit Developer portal (https://developer.intuit.com) → your app →
**Keys & OAuth**.

Give me four things:

| Field | Where it comes from | Notes |
|---|---|---|
| `client_id` | App → Keys & OAuth → Production Keys | ~50 chars, starts `AB` |
| `client_secret` | Same screen | 40 chars |
| `refresh_token` | OAuth Playground, or the app's first consent redirect | **Rotates on every use** and dies after 100 days idle |
| `realm_id` (per company) | The `realmId` query param on the OAuth redirect, or Settings → Account and Settings → Billing & Subscription | One per QuickBooks company file |

Redirect URI must be registered in the portal before the consent flow works —
`http://localhost:8000/callback` is fine for a one-time token grab.

Deliver as either:
- `config/quickbooks_credentials.json` (copy `config/quickbooks_credentials.example.json`), or
- env vars `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_REFRESH_TOKEN`

Both are gitignored. Do not paste these into chat — put them on the Mac Mini
and I'll read them from there.

**The one question I need answered with the credentials:** is it *one QuickBooks
company file per entity*, or *one file with Classes/Locations per entity*? That
single answer sets `ENTITY_RESOLUTION` in `ingest_quickbooks.py`, and everything
downstream keys off entity. If it's Classes, I also need the exact Class names as
typed in QuickBooks — "Zone" vs "Zone LLC" vs "ZONE" are three different strings.

**Also useful, cheap to produce:** Reports → Chart of Accounts → Export to Excel.
Lets me pre-build the GL-account → taxonomy map before we ever call the API.

---

## (b) Fuel report export

From Comdata / EFS / WEX / whoever issues the cards. **CSV preferred**, one
month of real data is enough to lock the parser.

Load-bearing fields:
- transaction date **and time** (time disambiguates same-amount same-day fills)
- card number or driver ID
- **unit/truck number** — the single most valuable field; without it fuel can't
  be attributed per truck and per-unit cost stays incomplete
- location (merchant name, city, state)
- gallons, price per gallon, total amount
- product type (diesel vs. DEF vs. reefer vs. in-store merchandise — these must
  not land in one bucket)

What I need to know alongside the file: does the card provider bill you as a
**single weekly/monthly ACH draft**? If so, that draft is one line on the bank
statement covering hundreds of fuel transactions — the reconciliation has to
match the draft total against the sum of its detail lines, not one-to-one, and
I need to know the billing cycle to build that.

---

## (c) Toll report export

PrePass / Bestpass / I-PASS / EZPass — CSV or Excel, one month.

Load-bearing fields:
- transaction date/time
- **transponder ID, and the transponder → unit mapping** (usually a separate
  screen; without it tolls attribute to a transponder, not a truck)
- plaza / toll authority, state
- amount
- account/sub-account if you have multiple

Same billing question as fuel: consolidated draft or per-transaction?

---

## (d) Incidents, assets, compliance costs

These can't be derived from bank memos — a $2,500 debit doesn't say whether it
was a deductible, a repair, or a settlement. Manual entry either way, so the
format is whatever is least work for you: **one spreadsheet, three tabs**, or
three CSVs. Blank cells are fine, I'd rather have a partial row than no row.

### Tab 1 — `incidents` (accidents/crashes)
| Column | Required | Notes |
|---|---|---|
| incident_date | yes | |
| unit_number | yes | truck or trailer involved |
| entity_id | yes | ZONE / XTRACK / AFG / ... |
| driver_name | | drives the driver-risk view |
| description | | one line is plenty |
| out_of_pocket_cost | yes* | paid directly, outside insurance |
| insurance_deductible_paid | yes* | deductible on a filed claim |
| claim_filed | | yes/no |

\* at least one of the two cost columns. Keeping them separate is the whole
point — deductible paid tells you claims behavior, out-of-pocket tells you what
insurance never covered.

### Tab 2 — `assets` (truck/trailer purchases, leases, rentals)
| Column | Required | Notes |
|---|---|---|
| unit_number | yes | |
| entity_id | yes | which entity holds it — Iron Lease vs. the operating company matters |
| acquisition_type | yes | purchase / lease / rent |
| acquisition_date | yes | |
| purchase_price | | for purchases |
| monthly_payment | | for lease/rent/financed |
| term_months | | needed to see total obligation, not just monthly cash-out |
| lienholder_or_lessor | | PACCAR Financial, Daimler, etc. |

If a truck is leased from your own Iron Lease LLC, say so explicitly — that's an
intercompany obligation and it should not be double-counted as a real expense at
the group level.

### Tab 3 — `compliance_costs` (registration, IFTA, permits)
| Column | Required | Notes |
|---|---|---|
| cost_type | yes | registration / ifta / permit / other |
| unit_number | | blank if it's entity-level, not per-truck |
| entity_id | yes | |
| period | yes | `2026-Q1` or `2026` |
| amount | yes | |
| paid_date | yes | |

IFTA is usually filed per entity per quarter, not per truck — entity-level rows
are expected and fine.

### Also needed, separately: the unit roster
The `units` table drives all per-unit reporting. One CSV:
`unit_number, unit_type (truck/trailer), entity_id, vin, in_service_date, out_service_date`

Without it, per-unit cost only covers trucks that happen to appear in a memo,
and a truck that cost you money while sitting idle looks like your cheapest
asset because nothing referenced it. `out_service_date` matters as much as
`in_service_date` — a unit sold in March shouldn't drag a full-year cost average.
