# Intake matrix — four ways in, one standard of proof

The operator's requirement, stated once and applying to everything: **every
figure this system needs must be enterable four ways — dropped as a
document, typed by a person, pulled from a Google Sheet, or pulled from an
API — and every one of them editable afterwards.**

This document fixes what that means so each workstream builds the same
thing, and records the one decision that made it possible.

---

## 1. The decision: a typed number has provenance too

Three of the four paths already worked. The second did not, and not for a
UI reason. `provenance_matches_kind` requires a document id, a connector
pull id, or a calc run id. A person typing a figure into a form has none of
them, so **a manual entry was literally uninsertable** — the constraint that
makes every number traceable also made manual entry impossible.

Three ways to fix that; two were wrong:

- **Reuse `adjustment`.** It requires `reverses_entry_id`, so a first-time
  manual figure has nothing to reverse. It would also file a fresh assertion
  under "correction", which is a different thing.
- **Fabricate a placeholder document.** The tempting one and the worst one:
  it makes a typed number indistinguishable from a parsed invoice, in the
  exact table whose job is telling those apart.
- **Say what it is.** A manual figure traces to a *named person who asserted
  it, on a stated basis, at a stated time*. That is real provenance — weaker
  than a document, and the system renders it as weaker.

So `source_kind` gains `manual`, and it is the only kind whose evidence is
an `accounting.manual_attestation` rather than a pointer at a file. A manual
entry may not borrow a document, and a parsed entry may not borrow an
attestation (assertions 47 and 48).

**The rule did not loosen. It got one more honest case.**

## 2. The matrix

Every row supports all four. "Edit" is universal: any staged row is editable
before commit, and any committed figure is corrected by a reversing entry,
never an overwrite.

| What | Upload | Manual | Sheet | API |
| --- | --- | --- | --- | --- |
| Revenue / loads | dispatch export ✅ | ✅ | ✅ | TMS later |
| Fuel | EFS / Relay statement ✅ | ✅ | ✅ | fuel-card API later |
| **Maintenance** | shop invoice ✅ | ✅ | ✅ | shop system later |
| **Factoring** | Triumph statement ✅ | ✅ | ✅ | factor API later |
| Registration | IRP / HVUT invoice ✅ | ✅ | — | — |
| Tolls | toll statement ✅ | ✅ | ✅ | transponder API later |
| **IFTA mileage** | Samsara / Motive / ELD export ✅ | ✅ | ✅ | Samsara API — **needs a token** |
| **Truck status** | — | ✅ mark on the fleet board | registry only | Samsara / Motive — **needs a token** |
| Intercompany | — | ✅ | registry only | — |
| **IFTA rates** | — | ✅ **the source of record** | — | — |

✅ = built and tested. "Registry only" means the sheet can be registered but
nothing parses that shape yet, and the screen says so rather than offering a
sync that would write nothing and look like an empty sheet.

**IFTA mileage** moved from "needs a parser" to ✅: the telematics report
parses on upload (`parseByDocType` → `parseIftaMileage`), and its rows stage
with a jurisdiction and a mileage quantity and **no amount**. That makes
`ifta_mileage` the first *non-posting* document type — miles are a
measurement, not money, so `commitDocument` refuses the whole document with a
422 rather than rejecting every row for a missing amount, which would have
read as "this report was bad" when the report was fine and the destination
was wrong. The rows stay in staging, attached to their source document, and
the IFTA engine reads them there.

**IFTA rates are the one row with no upload path, and that is deliberate.**
Rates are published quarterly and no document this build ingests carries
them, so the manual column is not a fallback here — it is the source of
record. `accounting.ifta_rate` requires `source_note` and `entered_by`: a
rate's provenance is a named person naming where they read it. A
jurisdiction with miles and no rate is withheld from the return and named,
never taxed at zero.

Everything in the Manual column is one form driven by presets, and
everything in the Sheet column is one guarded sync — which is why this is
configuration rather than nine builds.

## 2b. The sheet path: one guard, not one importer per sheet

A sheet is registered once in `accounting.sheet_source`, its column layout
is recorded on the first sync, and **every sync after that is refused if the
columns moved.**

That table and its `header_checksum` column have existed since migration
002, carrying the whole argument in a comment — *"a column gets inserted...
lets a sync fail loudly on a layout change instead of silently reading the
wrong column as an amount"* — and nothing used it. It was a column and a
comment, not a behaviour: a column inserted on a Tuesday would have shifted
every amount one place left and the sync would have reported success.

Three properties it is built with:

- **Refused, not warned.** A warning on a batch job is a line in a log
  nobody reads, and by then the rows are in staging.
- **The error names what changed** — added, removed, or moved. "Header
  checksum mismatch" tells an accountant nothing they can act on, and the
  person reading it is usually the person who inserted the column.
- **A pure reorder is called out separately**, because it is the most
  dangerous case and the least visible: every column is still present, so
  nothing looks wrong, and every value now lands in the wrong field.

The guard is escapable — columns legitimately change — but only
deliberately, by a named person, through a separate re-baseline action that
writes who accepted it into the source's notes. A guard that can be stepped
over silently is not a guard.

**Nothing in the app fetches from Google Drive.** There is no Drive client
in its dependencies, so the export is pasted or supplied by whatever fetched
it. That boundary is worth keeping visible: deciding whether text is safe to
ingest is separable from, and more important than, fetching it.

## 3. Truck status — the fleet board's missing source

`FLEET-BOARD-SPEC.md` §6 asked where status lives. The answer is now: in
`accounting.truck_status_history`, from Samsara, Motive, a sheet, or a
person marking it — and the board reads `v_truck_status_current`.

Three properties it is built with:

- **Effective-dated**, like truck-to-entity. "In the shop" is a fact about a
  span of days; a screen showing last Tuesday must show last Tuesday's
  status, not today's.
- **One state at a time**, enforced by an exclusion constraint. Overlapping
  spans would let the board show a truck simultaneously assigned and in the
  shop, and a utilisation figure built on that means nothing.
- **A truck with no status is absent from the view, not defaulted to
  `open`.** "Nobody has told us" and "available" are different facts.
  Assertion 53.

The ready/home timers come from `hours_in_status` on that view, so "Ready
24+" is a measured duration rather than a guess.

**This does not reopen lane-text inference.** Deriving status from words in
the dispatch sheet is still wrong — 28 cells carrying `SHOP`/`HOME`/`OOS`
also carry real revenue, measured. Status comes from a maintained source or
it is unknown.

## 4. What a screen must show, per path

A figure's path is visible, always, because the four are not equally strong:

| Path | Rendered as | Why |
| --- | --- | --- |
| Document | the file name, linked | strongest: a third party produced it |
| API | connector + pull time | strong, but a snapshot of a system that rewrites itself |
| Sheet | sheet + tab + sync time | the operator's own record, and it changes |
| Manual | **who asserted it, and on what basis** | a person's word — useful, and not an invoice |

A P&L or dashboard total that mixes them says how much of itself is
attested rather than documented. That is the same discipline as the existing
caveat band: a number that is 90% documented and 10% asserted is a different
number from one that is fully documented, and the screen must not flatten
the two.

## 5. Superseding, not overwriting

When the invoice finally arrives for something a person typed, the document
is uploaded normally and the attestation is marked superseded by it. **The
attestation is not deleted.** "We believed $1,200 on a phone call, the
invoice said $1,450" is exactly what the reconciliation screen exists to
surface — and deleting the first number destroys the only evidence that a
variance ever existed.
