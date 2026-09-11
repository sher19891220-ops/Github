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
| Revenue / loads | dispatch export | per-load entry | dispatch sheet ✅ | TMS later |
| Fuel | EFS / Relay statement ✅ | per-purchase entry | fuel sheet ✅ | fuel-card API later |
| **Maintenance** | shop invoice ✅ | per-repair entry | maintenance sheet | shop system later |
| **Factoring** | Triumph statement | per-invoice status | factoring sheet | factor API later |
| Registration | IRP / HVUT invoice ✅ | per-unit entry | — | — |
| Tolls | toll statement ✅ | per-crossing entry | expenses sheet ✅ | transponder API later |
| **IFTA mileage** | **Samsara / Motive / ELD export** | per-state entry | mileage sheet | Samsara API |
| **Truck status** | — | mark in the UI | status sheet | Samsara / Motive |
| Intercompany | — | per-transfer entry | — | — |

✅ = built and tested today. Everything else is the same two components
(`upload` and `manual`) pointed at a different doc type or category, plus a
sheet purpose, which is why this is configuration rather than nine builds.

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
