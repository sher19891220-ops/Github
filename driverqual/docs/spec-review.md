# Review of the Master Implementation Prompt

This is a defect log for `Driver_Qualification_Platform_Master_Implementation_Prompt.md`.
Every item below was found by implementing the specification, and every one is
resolved in `master-implementation-prompt-v2.md` and in the code under
`driverqual/`. Section numbers refer to the original document.

Severity key: **Blocker** — the spec as written produces a wrong or
unimplementable result. **Gap** — the spec is silent on something a real
implementation must decide. **Clarity** — correct but ambiguous enough that two
builders would disagree.

---

## Blockers

### B1. §2.3 and §5.4 contradict each other on the overall decision

§2.3 states "the driver-level overall decision **must equal** the selected
company's Auto Liability result." §5.4 then requires that when Auto Liability is
`Not Evaluated`, the overall decision is `Manual Review`. Those cannot both hold.

**Resolution.** The rule is "overall mirrors Auto Liability, with one named
exception." v2 states it as an explicit mapping table:

| Auto Liability | Driver-level overall |
| --- | --- |
| Qualified | Qualified |
| Not Qualified | Not Qualified |
| Manual Review | Manual Review |
| Not Evaluated | **Manual Review** |

The exception has a reason worth stating in the spec: "no rule is configured" is
a neutral fact about the *system*, but for a *person* awaiting a decision it is a
review item. Implemented in `overallDecision()` (`src/domain/engine.ts`).

### B2. §5.2 states two different experience figures for the same driver

The Fabrice Karambizi case gives an original issue date of "June 2024" and an
evaluation date of "August 2026", then says to expect "approximately 26 completed
months" and in the next breath that the system "must never state that 28 months
is less than two years." June 2024 → August 2026 is 26 months, not 28. As written
the acceptance case cannot be turned into an assertion — 26 and 28 are both
presented as the expected value.

Worse, "approximately" has no place in an acceptance test. "June 2024" is not a
date; the answer differs by a day depending on whether the card issued on the 1st
or the 30th.

**Resolution.** v2 fixes exact dates (original issue `2024-06-15`, evaluation
`2026-08-19`) and asserts exactly **26**. The "28 months" figure is separated out
as its own guard test, because it tests a different thing: that the *narrative*
can never assert a false comparison. Both live in `tests/unit/acceptance.test.ts`.

### B3. §5.1 is ambiguous about which date decides lookback membership

Phenias's "Fail to Appear" record has violation date `2023-05-02` and conviction
date `2023-09-07`. The 36-month window from the `2026-07-31` MVR order date opens
on `2023-07-31`. So the record is **outside** the window by violation date and
**inside** it by conviction date.

§3.1 says to prefer the conviction date for classification, but never says which
date the window test uses. A builder reading the spec could exclude this record
as out-of-window — getting the right answer for the wrong reason, and getting a
different answer the moment the record is a moving violation.

**Resolution.** v2 defines a single **effective date** per record — conviction
when present, otherwise violation — and requires that the *same* date decide
classification, window membership and ordering. Phenias's record is therefore
in-window and excluded on classification, which is the correct reasoning.
Asserted explicitly in `tests/unit/evidence.test.ts`.

### B4. §4.2's numeric guard is not implementable as specified

"If the generated explanation makes an impossible numeric comparison, do not
issue Not Qualified" — with no definition of what an impossible comparison is or
how it is detected in free text.

**Resolution.** v2 specifies a concrete, testable guard: extract every
`<N> <unit> <comparator> <M> <unit>` claim from the narrative, normalise both
sides to months, and re-evaluate the comparator. Any claim that does not hold
downgrades a `Not Qualified` to `Manual Review` and names the failed comparison.
Implemented in `src/domain/guard.ts`; "28 months is less than two years" is
caught as `28 < 24 → false`.

### B5. §10 and §18 disagree about who decides

§10 says to "use structured model output" with `decision` as the first field.
§18 says "never rely on one unconstrained AI prompt for the final decision."
Taken together it is unclear whether the model's `decision` field is the
decision.

**Resolution.** v2 makes the split explicit: the **engine** decides; the model
only ever drafts prose. The model's echoed `decision` exists solely so it can be
compared against the engine's — and any disagreement rejects the model's text
rather than changing the outcome. `validateModelExplanation()` also rejects
criteria the applied guideline does not contain, and vague boilerplate such as
"does not meet guidelines".

### B6. §10's JSON schema omits `Not Evaluated` and most of what §10 demands

The schema's `decision` enum lists three statuses, but §2.4 defines four. The
prose above the schema requires company, coverage, guideline version, calculated
experience and counted violations with dates, none of which the schema has
fields for.

**Resolution.** v2 aligns the enum with §2.4 and adds the missing fields.

### B7. §6.1's three-document limit conflicts with §1

§1 lists CDL, MVR, PSP, driver licence, medical card, guidelines and COIs. §6.1
then caps applicant intake at "up to three documents: current MVR, CDL/driver
licence, and medical card" — leaving PSP with nowhere to go.

**Resolution.** v2 requires MVR, CDL/licence and medical card as the *minimum*
set and allows further typed documents (PSP and others) up to a configured limit,
default 8.

---

## Gaps

### G1. No definition of "completed months" at month boundaries

"Full calendar months between two dates" is undefined when the anniversary day
does not exist in the target month — a CDL issued on 31 January, measured on 28
February.

**Resolution.** v2 specifies anniversary-day clamping: when the origin day
exceeds the length of the target month, the last day of that month completes it.
`completedMonths()` implements it; `tests/unit/dates.test.ts` covers leap days
and short months.

### G2. No timezone rule

Dates arriving as timestamps and converted through a local timezone shift by a
day, which silently moves records across window boundaries and changes month
counts.

**Resolution.** v2 requires every date to be a calendar date (`YYYY-MM-DD`) with
no time component, and all arithmetic to be done on integer (year, month, day)
triples. `src/domain/dates.ts` never constructs a local-time `Date`.

### G3. Only one lookback window is contemplated

§3.1 says "the selected guideline's lookback window," singular. Real Auto
Liability criteria use several concurrently: 36 months for minor violations,
60 for majors, 60 for DUI.

**Resolution.** v2 makes `lookbackMonths` a property of each individual
condition, not of the guideline.

### G4. Violation severity is missing entirely

The four event types (Moving Violation, Administrative, Accident, Unknown) cannot
express the major/serious/minor distinction every real guideline is built on. A
DUI and a seat-belt ticket would count identically.

**Resolution.** v2 adds a severity tier — Major, Serious (49 CFR 383.51(c)),
Minor, Unknown — orthogonal to event type. Implemented in
`src/domain/classification.ts` with the FMCSA categories.

### G5. Unclassifiable records have no defined handling

The spec lists administrative patterns to exclude but never says what happens to
a description matching nothing — the common case with state-specific statute
codes such as "ORC 4511.99 entry".

**Resolution.** v2 requires unmatched descriptions to classify as `Unknown` and
to raise a data gap forcing Manual Review. They are never assumed minor. This
matters directly: a permissive fallback would have counted Phenias's
administrative records as violations.

### G6. "Stale" is used as a Manual Review trigger but never defined

§2.4 lists stale evidence as a Manual Review cause with no threshold.

**Resolution.** v2 sets a configurable MVR freshness limit, default 90 days from
order date to evaluation date, and requires a future-dated MVR to be rejected
outright.

### G7. "Low-confidence" is likewise undefined

**Resolution.** v2 sets a default field-confidence floor of 0.80. Below it, the
conditions depending on that field return indeterminate rather than pass or fail.

### G8. Nothing governs how a guideline PDF becomes evaluable criteria

§8 stores guideline files; §18 lists "guideline interpretation" as a module; no
section says who checks that the interpretation is right. Since every decision
depends on it, an unreviewed interpretation could reject drivers silently.

**Resolution.** v2 requires a guideline to carry a versioned rule set with a
review status, and forbids any decision from an unapproved interpretation —
those return Manual Review. `isEvaluable()` enforces it and is covered by tests.

### G9. No permission matrix for the four roles

§15 names Administrator, Safety Reviewer, Recruiter and Read Only without saying
what each may do.

**Resolution.** v2 adds a matrix; the Team & roles screen renders it.

### G10. Which points basis applies is never stated

§3.2 captures both state points and MVR activity points; no rule says which a
threshold uses. The two differ substantially — Phenias's backing violation
carries 2 state and 4 MVR activity points.

**Resolution.** v2 makes the basis an explicit property of each points condition.

### G11. Guideline replacement is under-specified

§8.1 requires version history but does not say what happens to the guideline
being replaced, nor how past evaluations stay reproducible.

**Resolution.** v2 requires the superseded guideline to be archived rather than
deleted, linked from its replacement, and retained so stored evaluations can be
replayed. Enforced by a partial unique index permitting one active guideline per
(company, coverage).

### G12. Company deletion says "do not silently delete linked records" without saying what to do

**Resolution.** v2 requires deletion to be refused while applicants still
reference the company, with the affected counts reported. Guidelines, coverages
and that company's evaluations cascade; no other company's data is touched.

### G13. §16 forbids fictional data; §17 requires Phenias and Fabrice test cases

Read literally these conflict.

**Resolution.** v2 confines acceptance fixtures to the test suite and forbids
seeding them into any deployed database. The application ships empty, with empty
states that name the next action.

---

## Clarity

### C1. §4.2's "28 months is greater than 2 years" reads as a rule

It is an illustration of a comparison the system must get right, listed among
genuine rules. v2 moves it into the guard section where it belongs.

### C2. Two different anchors are used without being contrasted

MVR windows anchor on the MVR order date (§3.1); experience anchors on the
evaluation date (§4.2). Both are correct, and the difference is easy to miss.
v2 states them side by side with the reason for each.

### C3. §4.2 says to ignore reported experience; §6.1 says staff may correct fields

**Resolution.** v2 draws the line at the *input*: staff may correct the original
issue date, and the month count is always derived from it, never entered.

### C4. §11's alert cadence is unspecified

"Alerts beginning 90 days before expiration" does not say whether the alert
persists, repeats, or how expiry is treated. v2 specifies one open alert per
(coverage, severity), opening at 90 days and remaining open through expiry.

### C5. Coverage normalisation names one alias

"Motor Truck Cargo" → "Cargo" is given as the example; real COIs carry many more.
v2 requires a documented alias table and an explicit failure for unrecognised
labels rather than a best guess. Implemented in `normalizeCoverageType()`.

---

## Defects found by implementing, not by reading

### I1. The DUI pattern missed Ohio's wording

The first classifier draft matched "driving under the influence" but not
"operating a vehicle while under the influence" — Ohio's OVI, which matters
because the primary acceptance case is an Ohio carrier. A major violation would
have fallen through to `Unknown`. Caught by `tests/unit/classification.test.ts`
and fixed by broadening the pattern to the offence language rather than the verb.

### I2. The numeric guard missed the way people actually write

The first guard required the comparison's halves to be adjacent, so it caught
"28 months is less than 2 years" but not "28 months, which is less than 2 years"
— the more natural phrasing, and therefore the more likely one. Fixed with a
bounded filler that cannot cross a sentence boundary or an intervening
month/year figure.

### I3. Preselecting companies in the comparison modal ran unrequested evaluations

The comparison modal initially preselected the first two companies, which stored
evaluation rows for a company the user never chose. It now preselects only the
applicant's own company.
