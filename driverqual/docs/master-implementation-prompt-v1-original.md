# Driver Qualification Platform — Master Implementation Prompt

## Instructions to the AI builder

Build a production-ready, responsive web application called **DriverQual — Driver Qualification Platform** for a trucking-company safety department. Do not create a static mockup. Implement the complete working application, database, document uploads, AI extraction, company-specific guideline management, qualification engine, auditability, error handling, and tests described below.

The platform helps a safety team upload a CDL, MVR, PSP, driver license, medical card, insurance driver guidelines, and certificates of insurance; extract the relevant facts; and determine whether the driver qualifies for a selected trucking company under that company’s applicable insurance driver criteria.

The most important requirement is **evidence-based, company-specific, coverage-specific evaluation**. The system must never invent criteria, combine unrelated policies, infer violations or suspensions, or treat incomplete evidence as proof that a driver is not qualified.

---

## 1. Product goals

The system must:

1. Let safety staff add and manage multiple trucking companies.
2. Keep every company’s applicants, insurance programs, coverages, and guidelines separate.
3. Let users upload one or more driver documents by drag-and-drop.
4. Read CDL, MVR, PSP, driver-license, and medical-card information and populate applicant fields.
5. Let users verify extracted evidence before saving it.
6. Let users upload, replace, or remove driver guidelines, tagged by company and coverage.
7. Evaluate the same driver separately against Zone-OH LLC, Xtrack LLC, or any other selected company.
8. Explain the decision using only the selected company’s applicable guideline.
9. Show Qualified, Not Qualified, Manual Review, or Not Evaluated for each coverage.
10. Use only the Auto Liability driver-qualification result for the driver-level overall decision unless the Auto Liability guideline explicitly incorporates another requirement.
11. Provide clear reasons, evidence used, excluded evidence, missing evidence, and the exact guideline applied.
12. Support desktop, tablet, and mobile browsers.

---

## 2. Core business rules

### 2.1 Company isolation

- Every guideline must have a required `company_id` and `coverage_type`.
- Every applicant must have an applying company.
- Each evaluation result must store applicant, company, coverage, guideline version, result, reasons, and evaluation timestamp.
- Selecting Zone must use only Zone’s active guideline files.
- Selecting Xtrack must use only Xtrack’s active guideline files.
- Evaluating a driver for one company must not delete or overwrite stored results for another company.
- Switching the applicant’s company must automatically reevaluate that applicant for the newly selected company.
- The applicant profile must show only the currently selected company’s evaluation rows.
- A multi-company comparison screen may show several companies side by side, but each result must remain fully independent.

### 2.2 Coverage types

Support these exact coverage choices:

- Auto Liability
- General Liability
- Cargo
- Trailer Interchange
- Physical Damage
- Workers Compensation
- Occupational Accident Insurance
- Bobtail / Non-Trucking Liability

Normalize legacy labels such as “Motor Truck Cargo” to “Cargo.”

### 2.3 Driver-level overall decision

- Auto Liability is the controlling driver-qualification coverage.
- The driver-level overall decision must equal the selected company’s Auto Liability result.
- General Liability, Cargo, Physical Damage, Workers Compensation, Occupational Accident, Trailer Interchange, and Bobtail results must not make the driver globally Not Qualified.
- If the selected company has no active Auto Liability driver guideline, overall status is Manual Review and the explanation must say that no applicable Auto Liability driver guideline is configured.
- Other coverage results may be displayed independently, but they must not influence the overall driver decision.
- A guideline from another coverage must never be imported into the Auto Liability evaluation.

### 2.4 Decision statuses

Use these statuses consistently:

- **Qualified** — the evidence supports at least one complete eligibility path and no applicable disqualifier exists.
- **Not Qualified** — verified evidence clearly conflicts with an explicit requirement in the selected company and coverage guideline.
- **Manual Review** — required evidence is missing, stale, unclear, contradictory, low-confidence, or uses a legacy extraction format.
- **Not Evaluated** — no active guideline exists for that company and coverage, or the policy is not used for driver qualification.

Never use missing information alone as proof of Not Qualified.

---

## 3. MVR and evidence logic

### 3.1 Dates and lookback periods

- Extract and store the MVR order/report date.
- Use the MVR order date—not today—as the anchor for MVR lookback windows.
- For an MVR event, use conviction date when available; otherwise use violation/event date.
- If a required event date is missing or unclear, return Manual Review.
- Exclude events outside the selected guideline’s lookback window.
- Preserve original dates exactly and store normalized ISO dates separately.

### 3.2 Violation classification

Each MVR entry must include:

- Exact description
- Violation/event date
- Conviction/disposition date
- State
- State points
- MVR activity points
- Disposition
- Event type
- Whether it falls within the relevant lookback period
- Whether it is countable
- Exclusion reason when not countable

Valid event types:

- Moving Violation
- Administrative
- Accident
- Unknown

Administrative/non-driving records include:

- Abandoned vehicle fee
- Fee due
- Fail to appear / trial / court entry
- Parking
- Toll
- Registration or reinstatement fee
- Similar zero-point administrative records

These records must not count as minor moving violations unless the selected Auto Liability guideline explicitly says otherwise.

### 3.3 Suspensions

- Never infer a suspension from a violation, fee, court record, disposition, or red-light event.
- Extract a suspension only when the source document explicitly reports a suspension record.
- A suspension can affect an evaluation only when the exact selected Auto Liability driver guideline explicitly makes suspension history or status a qualification criterion.
- Do not apply a generic insurance-industry suspension rule.
- Legacy or unverified inferred suspension data must be ignored and the applicant must be placed in Manual Review until current documents are reread.

### 3.4 Accidents and medical evidence

- Accidents must include date, description, at-fault status, and preventability when stated.
- Do not infer fault or preventability.
- Missing medical-card evidence matters only if the exact selected guideline requires medical evidence.
- When required medical evidence is missing, expired, or unclear, return Manual Review—not Not Qualified—unless the guideline explicitly mandates disqualification.

---

## 4. CDL experience calculation

### 4.1 Required extraction

Extract a dedicated `cdl_original_issue_date` from the first/original CDL issue date or “CDL since” date.

Do not substitute:

- Current card issue date
- Renewal date
- Duplicate/replacement date
- Expiration date
- MVR order date

If the original CDL issue date is unavailable, display “Cannot calculate” and use Manual Review only when experience is required by the guideline.

### 4.2 Deterministic calculation

Calculate completed experience months in application code, not with AI:

```text
completed_months = full calendar months between original CDL issue date and evaluation date
```

Use completed months for all comparisons:

- 12 months = 1 year
- 24 months = 2 years
- 28 months is greater than 2 years

Never let the AI claim that 28 months is less than two years. Add a deterministic validation guard: if the generated explanation makes an impossible numeric comparison, do not issue Not Qualified; change it to Manual Review and identify the invalid comparison.

When the original issue date is available, ignore manually reported experience months for qualification. Show both the original date and calculated months to the user for verification.

### 4.3 Alternative eligibility paths

Read the guideline as a rule tree, not as a flat list. Evaluate all alternative paths.

Example: if a guideline contains a two-year path and a one-year path with different violation limits, two years is not an absolute requirement. Apply the path the applicant actually satisfies. Never choose a stricter branch merely to reject the driver.

---

## 5. Required acceptance examples

Create automated tests for these cases.

### 5.1 Phenias Mugisha

MVR order date: `2026-07-31`.

Records:

1. `2021-10-20 — Abandoned Vehicle Fee Due — 0 points`
2. `2023-05-02 — Fail to Appear – Trial/Court; conviction 2023-09-07 — 0 points`
3. `2024-05-20 — Limitations on Backing; conviction 2024-07-24 — 2 state points / 4 MVR activity points`

Expected behavior:

- Abandoned Vehicle Fee Due is Administrative and not a moving violation.
- It is also outside the 36-month window measured from 2026-07-31.
- Fail to Appear / Trial / Court is Administrative and not a moving violation.
- Limitations on Backing is the only countable moving violation within 36 months.
- Countable moving violations = 1, not 3.
- Do not invent “Failure to stop for red light.”
- Do not infer any suspension.
- Apply only Zone-OH LLC’s Auto Liability driver criteria to Zone’s overall driver decision.
- Do not add a two-year requirement unless it is an actual mandatory requirement with no applicable alternative path in the selected Zone Auto Liability guideline.

### 5.2 Fabrice Karambizi

Original CDL issue date: June 2024.
Evaluation date: August 2026.

Expected behavior:

- Calculate approximately 26 completed months, depending on the exact June issue day.
- The result is at least 24 months and therefore satisfies a two-year minimum.
- The system must never state that 28 months is less than two years.
- The displayed evidence must show the original CDL issue date and calculated completed months.
- Current license renewal/issue dates must not replace the original CDL issue date.

### 5.3 Coverage isolation

Given:

- Auto Liability = Qualified
- General Liability = Not Qualified
- Cargo = Manual Review
- Physical Damage = Not Qualified

Expected driver-level overall decision: **Qualified**, because Auto Liability controls the driver qualification result.

### 5.4 Missing Auto Liability guideline

If a company has Cargo and Physical Damage guidelines but no Auto Liability driver guideline:

- Auto Liability = Not Evaluated
- Overall = Manual Review
- Explanation: no active Auto Liability driver guideline is configured for the selected company.

---

## 6. Applicant workflow

### 6.1 Add applicant

Provide a prominent **Add applicant** button that opens a responsive side panel.

Required flow:

1. Select applying company from a populated dropdown.
2. Drag and drop up to three documents: current MVR, CDL/driver license, and medical card.
3. Accept PDF, JPG, PNG, and HEIC, up to 20 MB per file.
4. Click **Read documents and fill fields**.
5. Display extraction confidence and warnings.
6. Populate personal and CDL fields.
7. Display extracted MVR events for verification.
8. Display original CDL issue date and calculated experience months.
9. Allow staff to correct fields before saving.
10. Click **Verify, evaluate, and create**.
11. Save the applicant and evaluate only the selected company’s guidelines.

Required applicant fields:

- Applying company
- First, middle, and last name
- Date of birth
- Phone
- Email
- CDL number
- CDL state
- CDL class
- Original CDL issue date
- Calculated experience months
- Driver type
- Recruiter

If no companies exist, show “No companies available” and an **Add a company** action. Do not leave an empty, broken dropdown.

### 6.2 Update documents

Each applicant row and profile must provide **Update CDL/MVR** or **Update documents**.

The update flow must:

- Replace the applicant’s current qualification evidence.
- Reread the documents using the latest extraction format.
- Show MVR date, license status, medical status, original CDL issue date, calculated experience, countable events, administrative events, explicit suspensions, and warnings.
- Require user verification.
- Save the new evidence.
- Automatically reevaluate the assigned company.

Legacy extraction results must display Manual Review until documents are reread. Old potentially incorrect Not Qualified results must not remain visible as authoritative.

---

## 7. Company management

### 7.1 Add company

Required fields:

- Company name
- DBA
- Status
- USDOT number
- MC number
- Address
- Contact
- Notes

When a user enters a USDOT number, provide a lookup action that fills company name, DBA, address, operating status, USDOT, and MC information from an authorized FMCSA data source. If FMCSA integration is not configured or the lookup fails, show a clear error and allow manual entry.

### 7.2 Company cards

Each company card must show:

- Company name and status
- USDOT and MC
- Active coverage count
- Guideline count
- Applicant count
- Coverage tags

Actions:

- Add coverage / upload COI
- Add driver qualification guideline
- Delete company

Company deletion requires confirmation and must safely handle related applicants, guidelines, policies, and files. Do not silently delete linked records.

---

## 8. Guideline management

### 8.1 Add guideline

The guideline form must include:

- Company dropdown
- Coverage dropdown
- Insurance carrier (optional)
- Policy number (optional)
- Version
- Effective date
- Expiration date
- Drag-and-drop file upload

Do not require a separate “Guideline name” field. Derive a usable display name from company, coverage, carrier, or uploaded filename.

Guidelines must be replaceable or removable at any time. Preserve version history and audit entries.

### 8.2 Guideline library

- Provide a company selector above the library.
- When a company is selected, automatically refresh the counts and list to show only that company’s guidelines.
- Show tags for company, coverage, status, effective date, expiration date, and version.
- Provide Replace and Remove actions.
- Allow adding a missing guideline directly from an applicant’s coverage decision card, preselecting that applicant’s company and coverage.

---

## 9. Multi-company comparison

Each applicant must have a **Compare companies** action.

The comparison modal must:

- List all active companies with checkboxes.
- Show each company’s active guideline count.
- Allow one or several companies to be selected.
- Evaluate each selected company independently.
- Show company name, Auto Liability result, per-coverage results, guideline used, criteria applied, evidence used, excluded records, data gaps, and decision explanation.
- Clearly state that one company’s result does not change another company’s result.

When a user changes the applicant’s applying-company dropdown, automatically reevaluate and refresh the dashboard row.

---

## 10. Qualification explanation requirements

Every evaluated result must contain:

- Company applied
- Coverage applied
- Guideline file/version applied
- Decision
- Exact requirement or eligibility path applied
- Applicant evidence used
- Calculated experience and source date when relevant
- Counted violations with dates
- Administrative or out-of-window events excluded, with reasons
- Explicit data gaps
- Why the driver passed, failed, or requires review

Never produce vague text such as “does not meet guidelines.” Never cite a requirement that is absent from the selected guideline.

Use structured model output with at least:

```json
{
  "decision": "Qualified | Not Qualified | Manual Review",
  "reason": "string",
  "criteria_applied": ["string"],
  "eligibility_path": "string",
  "evidence_used": ["string"],
  "excluded_evidence": ["string"],
  "data_gaps": ["string"]
}
```

Validate model output in application code before saving it.

---

## 11. Insurance coverage and COI workflow

Under each company, provide **Add coverage / upload COI**.

Users must be able to drag and drop a certificate of insurance. Extract and verify:

- Coverage type
- Carrier
- Policy number
- Effective date
- Expiration date
- Limits when available

Allow manual correction before saving.

Generate alerts beginning 90 days before expiration. Show expired and expiring policies in:

- Dashboard notifications
- Needs Attention
- Company coverage tags
- Reports

---

## 12. Required screens

Implement these working navigation areas:

- Dashboard
- Applicants
- Manual reviews
- Documents
- Companies
- Insurance programs
- Rules & guidelines
- Reports
- Audit log
- Team & roles
- Settings

### Dashboard

Show:

- Total applicants
- Qualified
- Manual Review
- Documents needing review
- Not Qualified
- 90-day coverage alerts
- Recent applicants table

Applicant table columns:

- Driver
- Applying company dropdown
- CDL
- Auto Liability
- General Liability
- Cargo
- Physical Damage
- Overall
- Actions

Actions:

- Compare companies
- Update CDL/MVR
- Reevaluate
- Remove applicant

On mobile, keep the driver column visible and allow horizontal scrolling with a clear swipe hint.

---

## 13. Settings and integrations

Provide a functioning Settings screen for:

- OpenAI API key status and secure server-side connection
- FMCSA API configuration/status
- Extraction model
- Accepted formats and upload limits
- Security summary

Secrets must be stored server-side only, encrypted or through deployment secrets. Never expose a full API key in the browser, logs, responses, or database records visible to users.

The OpenAI key form must show Save/Connect, Refresh status, and Remove actions with clear success or error messages.

---

## 14. Data model

At minimum, create durable tables/collections for:

- Companies
- Applicants
- Applicant documents
- Extracted applicant evidence
- Coverages / insurance programs
- Guidelines
- Guideline versions/files
- Coverage evaluations
- Company comparison runs
- Users and roles
- Audit events
- Integration settings/status
- Expiration notifications

Each evaluation must be reproducible. Store the guideline IDs and versions, normalized evidence snapshot, model version, evaluation-engine version, timestamp, and final structured result.

Do not delete another company’s evaluation when reevaluating one company.

---

## 15. Security and compliance

- Treat driver records as sensitive.
- Store files in private object storage.
- Enforce server-side file validation and size limits.
- Protect against unauthorized cross-company data access.
- Keep secrets server-side.
- Add role-based access: Administrator, Safety Reviewer, Recruiter, Read Only.
- Log creates, updates, deletions, guideline replacements, document changes, company changes, reevaluations, and final reviewer decisions.
- AI results are decision support, not the final hiring decision.
- Display a disclaimer that an authorized safety or underwriting representative must review the result.

---

## 16. UI and responsive requirements

Design direction:

- Clean professional safety/insurance dashboard
- Dark navy navigation
- White cards on a light gray background
- Green primary actions
- Green Qualified, red Not Qualified, amber Manual Review, gray Not Evaluated
- Clear typography and high contrast
- No fictional production applicants or fake guidelines
- Empty states must explain the next action

Mobile requirements:

- Responsive navigation menu
- Full-screen applicant drawer
- Bottom-sticky form actions
- Touch targets at least 44 px
- Single-column forms
- Responsive modals
- Horizontal table scrolling
- No clipped dropdowns or inaccessible buttons

---

## 17. Testing requirements

Implement automated unit, integration, and UI tests.

Required unit tests:

- Completed-month calculation from CDL issue date
- 24 months satisfies two years
- 28 months cannot be less than two years
- Phenias administrative-event classification
- 36-month MVR window anchored to MVR order date
- Conviction-date preference
- No inferred suspensions
- Auto Liability-only overall decision
- Company isolation
- Legacy extraction produces Manual Review

Required integration tests:

- Add company and populate applicant dropdown
- Upload/read applicant documents
- Verify/edit extracted evidence
- Create applicant and evaluate selected company
- Switch company and automatically reevaluate
- Compare Zone and Xtrack independently
- Add, replace, and remove guideline
- Filter guideline library by company
- Upload COI and create 90-day alert
- Update documents and reevaluate

Required UI tests:

- Every navigation button works
- Settings works
- Add applicant opens and submits
- Drag-and-drop works on desktop and file-picker works on mobile
- Company dropdown is populated
- Responsive layout works at phone, tablet, and desktop widths
- Errors are visible and actionable

Do not report the product complete until the production build and tests pass.

---

## 18. Recommended implementation approach

Use a modern full-stack TypeScript stack suitable for secure document workflows. A recommended architecture is:

- React / Next.js-compatible frontend
- TypeScript server routes
- Relational SQL database
- Private object storage for PDFs/images
- Server-side OpenAI Responses API with strict JSON schemas
- Secure deployment secrets
- Background or queued reevaluation for long-running document jobs

Separate the system into these services/modules:

1. Document ingestion and validation
2. CDL/MVR/medical extraction
3. Evidence normalization
4. Guideline storage/versioning
5. Guideline interpretation
6. Deterministic rule validation
7. Company/coverage evaluation
8. Explanation generation
9. Audit logging
10. Notifications and expiration monitoring

Never rely on one unconstrained AI prompt for the final decision. Use AI to extract and interpret documents, then apply deterministic validation for dates, months, lookback windows, event classification, company/coverage isolation, and overall-status calculation.

---

## 19. Definition of done

The application is complete only when:

- Real users can add companies and applicants.
- Company dropdowns populate correctly.
- Driver documents and guidelines upload successfully.
- Extracted fields are visible and editable.
- CDL experience is calculated from the original issue date.
- Phenias and Fabrice acceptance cases pass.
- Zone and Xtrack results remain separate.
- Auto Liability alone controls driver-level overall qualification.
- Administrative records are not counted as moving violations.
- Suspensions are never inferred.
- Missing evidence produces Manual Review rather than false rejection.
- Every decision identifies the company, coverage, guideline, rule, evidence, exclusions, and reason.
- Guideline replacement/removal and company deletion work safely.
- COI expiration alerts begin 90 days before expiration.
- Mobile and desktop workflows are usable.
- All tests and the production build pass.
- The deployed application contains no fictional applicants, companies, policies, or guidelines.

Build this as a real operational safety platform, not a demonstration dashboard.
