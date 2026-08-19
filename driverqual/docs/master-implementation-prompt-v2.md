# Driver Qualification Platform — Master Implementation Prompt (v2)

> Revision of the original master prompt. Every contradiction, undefined term and
> gap identified in `spec-review.md` is resolved here. Changes from v1 are marked
> **[v2]** with the defect id from that review.

## Instructions to the AI builder

Build a production-ready, responsive web application called **DriverQual —
Driver Qualification Platform** for a trucking-company safety department. Do not
create a static mockup. Implement the complete working application: database,
document uploads, extraction, company-specific guideline management,
qualification engine, auditability, error handling and tests.

The platform helps a safety team upload a CDL, MVR, PSP, driver licence, medical
card, insurance driver guidelines and certificates of insurance; extract the
relevant facts; and determine whether the driver qualifies for a selected
trucking company under that company's applicable insurance driver criteria.

The most important requirement is **evidence-based, company-specific,
coverage-specific evaluation**. The system must never invent criteria, combine
unrelated policies, infer violations or suspensions, or treat incomplete evidence
as proof that a driver is not qualified.

---

## 0. Foundational conventions **[v2 — G1, G2]**

These bind every other section. Get them wrong and the rest cannot be correct.

### 0.1 Dates are calendar dates

Every date is a calendar date `YYYY-MM-DD` with no time and no timezone. All
arithmetic is performed on integer (year, month, day) triples. Never convert a
document date to an instant: a timezone shift moves records across window
boundaries and changes month counts by one, silently.

### 0.2 Completed months

```
completed_months(from, to):
  if to <= from: return 0
  months = (to.year - from.year) * 12 + (to.month - from.month)
  anniversary_day = min(from.day, days_in_month(to.year, to.month))
  if to.day < anniversary_day: months -= 1
  return max(0, months)
```

The anniversary-day clamp is required: a CDL issued 31 January completes its
first month on 28 February (29 in a leap year), not on 3 March. Completed years
are derived as `floor(completed_months / 12)` so the two can never disagree.

### 0.3 Two anchors, deliberately different **[v2 — C2]**

| Quantity | Anchored on | Why |
| --- | --- | --- |
| MVR lookback windows | the **MVR order/report date** | the MVR reports what was true when it was pulled |
| CDL experience | the **evaluation date** | experience accrues to the moment of the decision |

### 0.4 Lookback windows

A lookback of `N` months from anchor `A` covers `[A - N months, A]`, both
endpoints inclusive, with the same end-of-month clamping as §0.2. Each condition
carries its own `lookbackMonths`; a guideline routinely uses several at once
(36 months for minor violations, 60 for majors). **[v2 — G3]**

### 0.5 Effective date of an MVR record **[v2 — B3]**

Each record has one **effective date**: the conviction date when the MVR reports
one, otherwise the violation/event date. That single date decides classification,
window membership and ordering alike. A record must never be inside a window by
one date and outside by another.

Records with no usable date, and records dated after the MVR order date, are
excluded from every window and raise a data gap.

### 0.6 Thresholds **[v2 — G6, G7]**

| Setting | Default | Effect when breached |
| --- | --- | --- |
| MVR freshness | 90 days between order date and evaluation date | Manual Review |
| Field confidence floor | 0.80 | conditions depending on that field return indeterminate |
| Max upload size | 20 MB per file | rejected server-side |
| Documents per read | 8 | rejected server-side |

An MVR order date after the evaluation date is rejected outright.

---

## 1. Product goals

1. Let safety staff add and manage multiple trucking companies.
2. Keep every company's applicants, insurance programs, coverages and guidelines separate.
3. Let users upload one or more driver documents by drag-and-drop.
4. Read CDL, MVR, PSP, driver-licence and medical-card information and populate applicant fields.
5. Let users verify extracted evidence before saving it.
6. Let users upload, replace or remove driver guidelines, tagged by company and coverage.
7. Evaluate the same driver separately against Zone-OH LLC, Xtrack LLC or any other selected company.
8. Explain the decision using only the selected company's applicable guideline.
9. Show Qualified, Not Qualified, Manual Review or Not Evaluated for each coverage.
10. Use only the Auto Liability driver-qualification result for the driver-level overall decision.
11. Provide clear reasons, evidence used, excluded evidence, missing evidence and the exact guideline applied.
12. Support desktop, tablet and mobile browsers.

---

## 2. Core business rules

### 2.1 Company isolation

- Every guideline requires a `company_id` and a `coverage_type`.
- Every applicant has an applying company.
- Evaluations are keyed by `(applicant, company, coverage)` and stored one row per key.
- Selecting Zone uses only Zone's active guidelines; selecting Xtrack, only Xtrack's.
- Re-evaluating one company must not read, modify or delete another company's rows. **Make this structural**: the evaluator receives one guideline and cannot reach any other, and every write is scoped by `company_id`.
- Switching an applicant's company re-evaluates for the new company and retains the previous company's stored result.
- The applicant profile shows only the currently selected company's rows.
- A multi-company comparison may show several companies side by side; each result stays fully independent.

### 2.2 Coverage types

Auto Liability · General Liability · Cargo · Trailer Interchange · Physical Damage ·
Workers Compensation · Occupational Accident Insurance · Bobtail / Non-Trucking Liability

**[v2 — C5]** Maintain a documented alias table normalising real-world labels
("Motor Truck Cargo", "Commercial Auto Liability", "CGL", "NTL", …) onto these
canonical names. An unrecognised label is an explicit error, never a best guess.

### 2.3 Driver-level overall decision **[v2 — B1]**

Auto Liability is the controlling driver-qualification coverage. The overall
decision is a pure function of the Auto Liability result for the selected company:

| Auto Liability | Driver-level overall |
| --- | --- |
| Qualified | Qualified |
| Not Qualified | Not Qualified |
| Manual Review | Manual Review |
| Not Evaluated | **Manual Review** — "no active Auto Liability driver guideline is configured for this company" |

The last row is the only place the two differ: "no rule is configured" is a
neutral fact about the system, but for a person awaiting a decision it is a
review item.

No other coverage may make a driver globally Not Qualified. Other results are
displayed independently. A guideline from another coverage must never be imported
into the Auto Liability evaluation.

### 2.4 Decision statuses

- **Qualified** — evidence supports at least one complete eligibility path and no applicable disqualifier exists.
- **Not Qualified** — verified evidence conflicts with an explicit requirement in the selected company-and-coverage guideline.
- **Manual Review** — required evidence is missing, stale, unclear, contradictory, below the confidence floor, or captured in a legacy extraction format; or the guideline's interpreted criteria are not yet approved.
- **Not Evaluated** — no active guideline exists for that company and coverage, or the policy is flagged as not used for driver qualification.

Missing information is never, by itself, proof of Not Qualified.

### 2.5 Tri-state conditions **[v2 — new]**

Every condition evaluates to `pass`, `fail` or `indeterminate`. Indeterminate is
what keeps missing evidence out of the Not Qualified bucket, and the precedence
rules below are what make that guarantee hold:

1. Any disqualifier that definitively **fails** → **Not Qualified**.
2. Otherwise, any disqualifier that is **indeterminate** → **Manual Review**.
3. Otherwise, any eligibility path where all conditions **pass** → **Qualified**.
4. Otherwise, any path that is **indeterminate** → **Manual Review**.
5. Otherwise (every path decidable, every path fails) → **Not Qualified**.

---

## 3. MVR and evidence logic

### 3.1 Dates and lookback periods

- Extract and store the MVR order/report date; it anchors every MVR window (§0.3).
- Use the effective date defined in §0.5 for each record.
- A missing or unclear required event date yields Manual Review.
- Exclude events outside the relevant window, recording the reason.
- Preserve original date strings exactly; store normalised ISO dates separately.

### 3.2 Violation classification

Each MVR entry stores: exact description (verbatim, never paraphrased),
violation date, conviction date, state, state points, MVR activity points,
disposition, event type, **severity**, per-rule window membership, countability,
and an exclusion reason when not countable.

**Event types:** Moving Violation · Administrative · Accident · Unknown

**[v2 — G4] Severity tiers** for moving violations:

- **Major** — DUI/DWI/OWI/OVI, refusal to test, controlled substance, reckless, leaving the scene, felony involving a vehicle, driving while suspended/revoked, fleeing.
- **Serious** — 49 CFR 383.51(c): excessive speed (15+ over), improper or erratic lane change, following too closely, texting/handheld, operating without a valid CDL, railroad-crossing violations.
- **Minor** — ordinary moving violations.
- **Unknown** — description matched no rule.

**Administrative/non-driving records** include abandoned-vehicle fees, fees due,
failure to appear / trial / court entries, parking, tolls, registration and
reinstatement fees, proof-of-insurance filings, equipment and paperwork defects,
and failure to display or carry a licence. These never count as moving violations
unless the selected Auto Liability guideline explicitly says so.

**[v2 — G5] Unmatched descriptions classify as `Unknown` and raise a data gap
forcing Manual Review. They are never assumed minor.** Points are corroborating
evidence only — a zero-point record is not automatically administrative, and a
pointed record is not automatically a moving violation.

Automatic classification never overwrites a reviewer-confirmed classification.

### 3.3 Suspensions

- Never infer a suspension from a violation, fee, court record, disposition or red-light event.
- Record a suspension only when the source document carries an explicit suspension, revocation or disqualification record. Every suspension stores its provenance; only `explicit_document_record` is admissible.
- A suspension affects an evaluation only when the selected Auto Liability guideline explicitly makes suspension history a criterion. There is no generic industry suspension rule.
- Legacy or inferred suspension data is discarded and the applicant held in Manual Review until documents are re-read.

### 3.4 Accidents and medical evidence

- Accidents store date, description, at-fault status and preventability when stated. Never infer fault or preventability.
- Missing medical evidence matters only when the selected guideline requires it.
- Missing, expired or unclear medical evidence yields **Manual Review**, not Not Qualified, unless the guideline carries an explicit disqualifier.

---

## 4. CDL experience calculation

### 4.1 Required extraction

Extract a dedicated `cdl_original_issue_date` from the first/original CDL issue
date or "CDL since" date. Never substitute the current card issue date, renewal
date, duplicate/replacement date, expiration date or MVR order date.

When unavailable, display "Cannot calculate" and return Manual Review only where
the guideline requires experience.

### 4.2 Deterministic calculation

Calculate completed months in application code per §0.2, never with a model.
Use completed months for every comparison: 12 = 1 year, 24 = 2 years, 28 > 2 years.

**[v2 — C3]** Staff may correct the original issue *date*; the month count is
always derived from it and never entered directly. Display both the source date
and the derived months for verification.

### 4.3 Alternative eligibility paths

Read a guideline as a rule tree, not a flat list. Paths are alternatives (OR);
conditions within a path are conjunctive (AND). A guideline with a two-year path
and a one-year path does not make two years mandatory — apply the path the
applicant actually satisfies. Never select a stricter branch to justify a
rejection.

### 4.4 Numeric claim guard **[v2 — B4]**

Before storing any decision, scan its narrative for numeric claims of the form
`<N> <months|years> <comparator> <M> <months|years>`, allowing natural filler
between the halves ("28 months, which is less than 2 years") but never crossing a
sentence boundary. Normalise both sides to months and re-evaluate the comparator.

If a claim does not hold:

- a `Not Qualified` is **downgraded to Manual Review**, naming the failed comparison;
- any other decision is kept, with a validation warning attached.

"28 months is less than two years" must be caught as `28 < 24 → false`.

---

## 5. Required acceptance examples **[v2 — B2, B3]**

All fixtures live in the test suite only and are never seeded into a deployed
database.

### 5.1 Phenias Mugisha

MVR order date `2026-07-31`; evaluation date `2026-08-19`.

| # | Description | Violation | Conviction | State pts | MVR pts |
| --- | --- | --- | --- | --- | --- |
| 1 | Abandoned Vehicle Fee Due | 2021-10-20 | — | 0 | 0 |
| 2 | Fail to Appear – Trial/Court | 2023-05-02 | 2023-09-07 | 0 | 0 |
| 3 | Limitations on Backing | 2024-05-20 | 2024-07-24 | 2 | 4 |

Expected:

- The 36-month window is `2023-07-31` to `2026-07-31`.
- Record 1 is Administrative **and** outside the window (effective date 2021-10-20).
- Record 2 is Administrative and, by effective date `2023-09-07`, **inside** the window. It is excluded on classification, not on the window. **[v2 — B3]**
- Record 3 is the only countable moving violation (Minor).
- Countable moving violations = **1**, not 3.
- No "failure to stop for red light" is invented; no suspension is inferred.
- Only Zone-OH LLC's Auto Liability criteria decide Zone's overall decision.
- No two-year requirement is applied unless it is genuinely mandatory with no alternative path in the selected guideline.

### 5.2 Fabrice Karambizi

Original CDL issue date `2024-06-15`; evaluation date `2026-08-19`.

Expected:

- Exactly **26** completed months. **[v2 — B2: v1 said both "approximately 26" and "28"]**
- 26 ≥ 24, so a two-year minimum is satisfied.
- Evidence shown includes the original issue date and the derived months.
- The current card's issue date (`2025-11-02`) never replaces the original — using it would give 9 months and wrongly fail a two-year minimum.

The "28 months is not less than two years" requirement is a separate guard test
(§4.4), not this case.

### 5.3 Coverage isolation

Auto Liability Qualified; General Liability Not Qualified; Cargo Manual Review;
Physical Damage Not Qualified → **overall Qualified**.

### 5.4 Missing Auto Liability guideline

Company has Cargo and Physical Damage guidelines but no Auto Liability driver
guideline → Auto Liability `Not Evaluated`, overall `Manual Review`, explanation
naming the company and the missing guideline.

---

## 6. Applicant workflow

### 6.1 Add applicant

A prominent **Add applicant** button opens a responsive side panel:

1. Select the applying company from a populated dropdown.
2. Drag and drop documents. **[v2 — B7]** MVR, CDL/driver licence and medical card are the minimum set; further typed documents (PSP, others) are accepted up to the configured limit.
3. Accept PDF, JPG, PNG and HEIC up to 20 MB per file, validated server-side on extension, content type and size.
4. Click **Read documents and fill fields**.
5. Display extraction confidence and warnings.
6. Populate personal and CDL fields.
7. Display extracted MVR events with their automatic classification, for verification.
8. Display the original CDL issue date and the derived experience months.
9. Allow staff to correct any field before saving.
10. Click **Verify, evaluate, and create**.
11. Save the applicant and evaluate only the selected company's guidelines.

Required fields: applying company; first, middle and last name; date of birth;
phone; email; CDL number; CDL state; CDL class; original CDL issue date;
calculated experience months (derived, read-only); driver type; recruiter.

If no companies exist, show "No companies available" with an **Add a company**
action. Never render an empty, broken dropdown.

If extraction is unconfigured or fails, say so plainly and offer manual entry.
Never populate placeholder evidence.

### 6.2 Update documents

Each applicant row and profile offers **Update CDL/MVR**. The flow re-reads with
the current extraction format; shows MVR date, licence status, medical status,
original CDL issue date, derived experience, countable events, administrative
events, explicit suspensions and warnings; requires verification; saves a new
evidence snapshot without destroying earlier ones; and re-evaluates the assigned
company.

Legacy extraction results display Manual Review until documents are re-read. An
older, possibly incorrect Not Qualified must not remain visible as authoritative.

---

## 7. Company management

### 7.1 Add company

Fields: company name, DBA, status, USDOT number, MC number, address, contact,
notes.

A USDOT lookup fills name, DBA, address, operating status, USDOT and MC from an
authorised FMCSA source. When the integration is unconfigured or fails, show a
clear error and allow manual entry — never return placeholder company data.

### 7.2 Company cards

Each card shows name and status, USDOT and MC, active coverage count, guideline
count, applicant count and coverage tags. Actions: add coverage / upload COI, add
driver-qualification guideline, delete company.

**[v2 — G12]** Deletion is refused while applicants still reference the company,
reporting the affected counts. Guidelines, coverages and that company's
evaluations cascade. No other company's data is touched.

---

## 8. Guideline management

### 8.1 Add guideline

Form: company, coverage, insurance carrier (optional), policy number (optional),
version, effective date, expiration date, `used_for_driver_qualification` flag,
drag-and-drop file upload, and interpreted criteria.

There is no separate "guideline name" field — derive a display name from company,
coverage, carrier or filename.

**[v2 — G8] Interpretation and approval.** A guideline is stored twice: the
original file (authoritative, immutable) and an interpreted **rule set** the
engine evaluates. A rule set carries a review status of
`pending_interpretation`, `awaiting_approval` or `approved`. **No decision may be
issued from an unapproved interpretation** — those return Manual Review. This is
what stops an unreviewed machine reading of a PDF from silently rejecting
drivers.

**[v2 — G11] Replacement** archives the superseded guideline rather than deleting
it, links it from its replacement, and retains it so past evaluations replay
exactly. At most one active guideline per (company, coverage).

### 8.2 Rule set schema **[v2 — new]**

```jsonc
{
  "schemaVersion": 1,
  "eligibilityPaths": [{            // alternatives (OR)
    "id": "path.two_year",
    "label": "Two-year experience path",
    "sourceText": "verbatim guideline text this path came from",
    "conditions": [ /* conjunctive (AND) */ ]
  }],
  "disqualifiers": [{               // any one firing → Not Qualified
    "id": "dq.suspension",
    "label": "No suspensions in 36 months",
    "sourceText": "...",
    "condition": { }
  }],
  "notes": ""
}
```

Condition types:

| Type | Fields |
| --- | --- |
| `min_experience_months` | `months` |
| `min_age_years` | `years` |
| `max_events` | `category`, `lookbackMonths`, `max` |
| `max_points` | `basis` (`state` \| `mvr_activity`) **[v2 — G10]**, `lookbackMonths`, `max` |
| `license_status_in` | `statuses[]` |
| `cdl_class_in` | `classes[]` |
| `requires_valid_medical_card` | — |
| `max_suspensions` | `lookbackMonths`, `max` — present only when the guideline states it |

Event categories: `moving_violation`, `minor_moving_violation`,
`serious_moving_violation`, `major_moving_violation`, `accident`,
`at_fault_accident`, `administrative`.

### 8.3 Guideline library

Company selector above the library; selecting a company refreshes counts and list
to that company only. Show tags for company, coverage, status, review status,
effective date, expiration date and version. Provide Replace and Remove. Allow
adding a missing guideline directly from an applicant's coverage decision card,
preselecting that applicant's company and coverage.

---

## 9. Multi-company comparison

Each applicant has a **Compare companies** action opening a modal that lists
active companies with checkboxes and their active guideline counts.

**[v2 — I3]** Preselect only the applicant's own company. Preselecting others
would store evaluation rows nobody asked for.

Each selected company is evaluated independently, showing company name, Auto
Liability result, per-coverage results, guideline used, criteria applied,
evidence used, excluded records, data gaps and the decision explanation, with an
explicit statement that one company's result never changes another's.

Changing the applying-company dropdown re-evaluates and refreshes the row.

---

## 10. Qualification explanation requirements

Every evaluated result contains: company; coverage; guideline file and version;
decision; the exact requirement or eligibility path applied; applicant evidence
used; calculated experience and its source date where relevant; counted
violations with dates; excluded administrative or out-of-window events **with
reasons**; explicit data gaps; and why the driver passed, failed or requires
review.

Never produce vague text such as "does not meet guidelines". Never cite a
requirement absent from the selected guideline.

### 10.1 Who decides **[v2 — B5]**

**The engine decides. Models only ever draft prose.** A model's `decision` field
exists solely to be compared against the engine's; disagreement rejects the
model's text rather than changing the outcome. Reject any drafted explanation
that cites criteria the applied guideline does not contain, that is vague
boilerplate, or that fails the §4.4 numeric guard. On rejection, the
deterministic explanation stands.

### 10.2 Structured output **[v2 — B6]**

```json
{
  "decision": "Qualified | Not Qualified | Manual Review | Not Evaluated",
  "company": "string",
  "coverage": "string",
  "guideline_version": "string",
  "reason": "string",
  "criteria_applied": ["string"],
  "eligibility_path": "string | null",
  "evidence_used": ["string"],
  "excluded_evidence": ["string"],
  "data_gaps": ["string"],
  "calculated_experience_months": "number | null",
  "experience_source_date": "string | null",
  "counted_violations": [{ "date": "string", "description": "string" }],
  "engine_version": "string",
  "evaluated_at": "string"
}
```

Validate in application code before saving.

---

## 11. Insurance coverage and COI workflow

Under each company, **Add coverage / upload COI** accepts a drag-and-dropped
certificate and extracts coverage type, carrier, policy number, effective date,
expiration date and limits where available, with manual correction before saving.

**[v2 — C4]** Maintain at most one open alert per (coverage, severity). An
`expiring` alert opens exactly 90 days before expiration and remains open until
expiry, when it becomes `expired`. Surface alerts in dashboard notifications,
Needs Attention, company coverage tags and reports.

---

## 12. Required screens

Dashboard · Applicants · Manual reviews · Documents · Companies · Insurance
programs · Rules & guidelines · Reports · Audit log · Team & roles · Settings.

**Dashboard** shows total applicants, Qualified, Manual Review, documents needing
review, Not Qualified, 90-day coverage alerts, and a recent-applicants table with
columns: Driver · Applying company (dropdown) · CDL · Auto Liability · General
Liability · Cargo · Physical Damage · Overall · Actions (Compare companies,
Update CDL/MVR, Reevaluate, Remove).

On mobile, keep the driver column visible and allow horizontal scrolling with a
clear swipe hint. The page body itself must never scroll horizontally.

---

## 13. Settings and integrations

Settings covers OpenAI API key status and connection, FMCSA configuration and
status, extraction model, accepted formats and upload limits, and a security
summary.

Secrets are stored server-side only, encrypted or via deployment secrets. **A
secret never leaves the server in full** — status responses carry a masked hint
(last four characters) and nothing more. Never write a secret to a log, an audit
detail or any response. The key form offers Save/Connect, Refresh status and
Remove with clear success and error messages.

---

## 14. Data model

Durable tables for: companies · applicants · applicant documents · extracted
applicant evidence · coverages / insurance programs · guidelines · guideline
versions/files · coverage evaluations · company comparison runs · users and
roles · audit events · integration settings/status · expiration notifications.

Every evaluation is reproducible: store guideline id and version, the evidence
snapshot id, model version, engine version, timestamp and the full structured
result. Evidence snapshots are append-only; a re-read adds a row and marks it
current rather than overwriting. Audit events are append-only with no update or
delete path.

Re-evaluating one company never deletes another company's evaluation.

---

## 15. Security and compliance

Treat driver records as sensitive. Store files in private object storage. Enforce
server-side file validation and size limits. Protect against cross-company data
access. Keep secrets server-side. Log creates, updates, deletions, guideline
replacements, document changes, company changes, re-evaluations and final
reviewer decisions.

AI results are decision support, not the hiring decision. Display a disclaimer
that an authorised safety or underwriting representative must review the result.

### 15.1 Role permissions **[v2 — G9]**

| Capability | Administrator | Safety Reviewer | Recruiter | Read Only |
| --- | :-: | :-: | :-: | :-: |
| View applicants and decisions | ✓ | ✓ | own company | ✓ |
| Create applicants, upload documents | ✓ | ✓ | ✓ | — |
| Verify evidence, re-evaluate, compare | ✓ | ✓ | — | — |
| Record the final reviewer decision | ✓ | ✓ | — | — |
| Manage companies and coverages | ✓ | — | — | — |
| Add or replace guidelines | ✓ | — | — | — |
| Approve interpreted criteria | ✓ | — | — | — |
| Configure integrations and secrets | ✓ | — | — | — |
| Manage users and roles | ✓ | — | — | — |
| Read the audit log | ✓ | ✓ | — | — |

---

## 16. UI and responsive requirements

Clean professional safety/insurance dashboard: dark navy navigation, white cards
on light gray, green primary actions. Green Qualified, red Not Qualified, amber
Manual Review, gray Not Evaluated. Clear typography and high contrast.

**[v2 — G13]** No fictional applicants, companies, policies or guidelines in any
deployed database. Acceptance fixtures exist in the test suite only. Empty states
explain the next action.

Mobile: responsive navigation menu, full-screen applicant drawer, bottom-sticky
form actions, touch targets ≥ 44 px, single-column forms, responsive modals,
horizontal table scrolling, no clipped dropdowns or unreachable buttons.

---

## 17. Testing requirements

**Unit:** completed-month calculation including end-of-month clamping and leap
days · 24 months satisfies two years · 28 months is never less than two years ·
administrative-event classification · severity tiers · unmatched descriptions
stay Unknown · 36-month window anchored on the MVR order date · conviction-date
preference including the in-window/out-of-window split of §5.1 record 2 · no
inferred suspensions · suspensions apply only with an explicit criterion ·
Auto Liability-only overall decision including the Not Evaluated → Manual Review
row · company isolation, including refusal to apply another company's guideline ·
legacy extraction yields Manual Review · missing evidence never yields Not
Qualified · numeric guard downgrades · model-explanation validation.

**Integration:** add company and populate the applicant dropdown · upload and
read documents · verify and edit evidence · create applicant and evaluate the
selected company · switch company and auto-re-evaluate · compare Zone and Xtrack
independently and confirm neither result disturbs the other · add, replace and
remove guidelines with version history preserved · filter the library by company ·
upload a COI and open a 90-day alert at exactly 90 days and not at 91 · update
documents and re-evaluate · company deletion refused while applicants remain ·
audit trail completeness · evaluation reproducibility fields stored.

**UI, at phone, tablet and desktop widths:** every navigation link works ·
settings works and never echoes a secret · add applicant opens and submits ·
drag-and-drop and the file picker both work · the company dropdown is populated ·
errors are visible and actionable · no horizontal page overflow · tap targets
≥ 44 px.

Do not report the product complete until the production build, typecheck and all
three suites pass.

---

## 18. Recommended implementation approach

Modern full-stack TypeScript: React/Next.js frontend, TypeScript server routes,
relational SQL, private object storage, server-side model calls with strict JSON
schemas, deployment secrets, and queued re-evaluation for long-running jobs.

Modules: document ingestion and validation · extraction · evidence normalisation ·
guideline storage and versioning · guideline interpretation · deterministic rule
validation · company/coverage evaluation · explanation generation · audit
logging · notifications and expiration monitoring.

Never rely on one unconstrained prompt for the final decision. Models extract and
interpret; deterministic code owns dates, months, lookback windows, event
classification, company/coverage isolation and status calculation.

---

## 19. Definition of done

- Real users can add companies and applicants.
- Company dropdowns populate correctly; an empty state offers to add a company.
- Driver documents and guidelines upload successfully, validated server-side.
- Extracted fields are visible and editable before saving.
- CDL experience is calculated from the original issue date and shown with it.
- The §5 acceptance cases pass, with the exact figures given there.
- Zone and Xtrack results remain separate and neither disturbs the other.
- Auto Liability alone controls the driver-level decision, per the §2.3 table.
- Administrative records never count as moving violations; unmatched descriptions never default to minor.
- Suspensions are never inferred and apply only where a guideline says so.
- Missing evidence produces Manual Review, never a false rejection.
- No decision is issued from an unapproved guideline interpretation.
- Every decision identifies company, coverage, guideline, rule, evidence, exclusions and reason.
- Guideline replacement archives rather than destroys; company deletion is safe.
- COI alerts open exactly 90 days before expiration.
- Mobile and desktop workflows are usable; nothing is clipped or unreachable.
- Typecheck, unit, integration, UI suites and the production build all pass.
- The deployed application contains no fictional applicants, companies, policies or guidelines.

Build this as a real operational safety platform, not a demonstration dashboard.
