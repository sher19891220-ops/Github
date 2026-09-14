# Data intake — what to send, and where it goes

## Read this first: the repository is public

`sher19891220-ops/Github` is a **public** GitHub repository. Real fuel, toll and
maintenance reports carry card numbers, account numbers, driver names and
sometimes addresses. None of that may be committed.

`tests/fixtures/real/` is git-ignored and is the only place real documents go.
Committed fixtures live in `tests/fixtures/redacted/` and are derived from the
real ones with identifiers replaced — same layout and edge cases, no live data.

If any of this should be private long-term, say so and the accounting module
moves to a private repository before Phase 2 ships. That is a five-minute change
now and a painful one later.

---

## 1. Documents — unblocks Phase 2

Drop into `opsdash/tests/fixtures/real/<type>/`. Originals, exactly as they
arrive from the vendor — **do not clean, re-save, or convert them.** The parser's
whole job is handling them as-issued, and a tidied XLSX hides the exact defects
worth testing against.

| Type | Folder | Need | Why |
| --- | --- | --- | --- |
| Fuel (EFS / Relay) | `fuel/` | 10–20 statements | Parser + the per-state gallons IFTA depends on |
| Toll | `toll/` | 10–20 statements | No upstream source exists; drag-drop is the only path |
| Maintenance cost | `maintenance/` | 10–20 invoices | Inspections are not costs; this is the only cost source |

Spread them across vendors and months if you can. Five statements from one
vendor in one format teaches the parser less than five from five.

**Send the ugly ones too** — the scanned PDF, the one with a merged-cell header,
the one someone hand-edited. Those are the cases that break parsers in month
three, and they are worth more to this build than clean copies.

## 2. A filed IFTA quarter — unblocks Phase 3

§6.3 requires validation against real filed numbers, not synthetic data. Send:

- The **filed return** for one recent quarter (the numbers to match to rounding).
- The **mileage data** behind it, per state per truck.
- The **fuel purchases** behind it, per state.

Without the filed return there is nothing to check the engine against, and an
IFTA engine that has only been tested against its own assumptions is not done.

**This is also where the biggest open risk sits:** no table in the aiops database
has been confirmed to carry miles *by state*. If your mileage-by-state comes from
a Samsara IFTA report, a spreadsheet, or your filing service rather than the
database, tell me which — it changes the Phase 3 plan.

## 3. Permit rates — unblocks Phase 3

Whatever you currently use to price permits: the rate sheet, a spreadsheet, or a
handful of recent permit invoices showing state, weight class and amount paid.
These seed `accounting.permit_rate` as maintained data, so a rate change never
needs a deploy.

## 4. Reference data — needed before anything can be attributed

- **Entities:** legal name and short code for each company (Zone, Xtrack, AFG, …).
- **Trucks:** unit number, VIN, weight class.
- **Drivers:** name, and lease-to-own vs company — **with the date each became
  one.** A driver who converted mid-year must not restate the earlier months, and
  the schema tracks that, but only if the dates come with the roster.

## 5. Four trailing weeks of actuals — unblocks Phase 5

Revenue, cost and margin as you booked them, for the last four completed weeks.
The prediction panel is back-tested against these and reports its real error.

## 6. Google Sheets access — already working

Nothing needed. The Drive connector reads your live sheets directly, and the
structures have been confirmed against real data — see `SOURCE-DISCOVERY.md`.

**The aiops Postgres is out of scope.** No connection string is needed; that
earlier request is withdrawn.

---

## Priority, if you are sending in stages

1. **A Samsara IFTA report export** for one quarter — the only unresolved input
   in the whole build. Nothing else can supply miles by state.
2. **EFS/Relay fuel statements** (§1) — opens Phase 2, and carries the gallons
   the IFTA engine needs, which the Fuel sheet does not reliably record.
3. **A filed IFTA quarter** (§2) — the number the engine gets validated against.
4. **Answers to the four questions** at the end of `SOURCE-DISCOVERY.md` — each
   one is a wrong-number risk, not a nicety.
5. **Trailing weeks** (§5) — needed only at Phase 5.

Toll and maintenance documents matter less than they did: those costs are
already maintained in your expense sheet, which the build now reads directly.
