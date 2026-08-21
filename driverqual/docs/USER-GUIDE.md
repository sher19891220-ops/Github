# Using DriverQual

How to run real driver qualification work. For installing and hosting, see
`DEPLOY.md`; for what the system is and why it decides the way it does, see
`README.md`.

Read **Before you put real driver records in** at the bottom first if this
instance will hold real people's data.

---

## Signing in

If the server has `APP_ACCESS_CODE` set, everyone entering the system types that
code once per browser; the session lasts 12 hours. **Sign out** is at the bottom
of the navigation (behind the menu button on a phone).

Five wrong codes from one address triggers a 15-minute lockout, during which even
the correct code is refused. Attempts age out after 15 minutes, so an occasional
typo never accumulates into one.

If no code is configured, the app runs open and shows a red banner saying so on
every screen.

### On the length of your code

A four-digit code is ten thousand possibilities. The lockout is what makes that
survivable rather than trivial — without it, a script exhausts the space in
seconds. With it, an attacker gets five guesses per quarter-hour per address.

That is adequate for a small team on a URL nobody else knows. Two things it does
not give you, worth knowing rather than discovering:

- The address a lockout is keyed to comes from a request header, which a
  determined attacker can change. Lockout slows an honest attacker; it does not
  stop a patient one. Code length is what carries the rest.
- One shared code cannot identify a person. The audit log records **what changed
  and when**, with the guideline version and evidence snapshot behind every
  decision, but the actor is an address rather than a name. Everything needed to
  reconstruct or challenge a decision is there; who typed it is not.

Two habits worth keeping:

1. **Use more than four digits.** Eight characters costs nothing extra to type
   once per session and removes the arithmetic entirely.
2. **Change it when someone leaves.** Rotating the code signs everyone out
   immediately — the signing key is derived from it, so old sessions die the
   moment it changes.

## The shape of the work

Two loops, at different frequencies.

**Once per company** (and again whenever an insurer reissues its criteria):

1. Add the company.
2. Add its Auto Liability driver guideline and write out the criteria.
3. Approve the criteria.

**Once per driver:**

4. Add the applicant with their MVR, CDL and medical card.
5. Verify what was read off the documents.
6. Read the decision — and record your own.

Step 2 is the only part that takes real thought, and it is the part you do least
often. Everything after it is minutes per driver.

---

## 1. Add the company

**Companies → Add company.** Name is the only required field.

If FMCSA is configured (`FMCSA_API_KEY`), type the USDOT number and press **Look
up** to fill name, DBA, address and MC number. If it is not configured the
lookup says so and you type the details in — it never guesses.

Nothing about a company is shared with any other company. Applicants, coverages,
guidelines and decisions are all scoped to one.

---

## 2. Write out the guideline criteria

This is the step that matters. **Rules & guidelines → select the company → Add
guideline.**

Fill in the coverage (Auto Liability for driver qualification), carrier, version
and dates, then write the criteria as a rule tree in the JSON box.

### Drafting the criteria from the document

If `OPENAI_API_KEY` is configured, drag the guideline in and press **Read
guideline and draft criteria**. The criteria are written into the editor for you
to check.

**A draft is a reading, not an authority.** It is validated against the rule
schema before you see it — anything the engine could not evaluate is discarded
rather than shown as usable — but it is never saved on its own and never
approved on its own. You correct it, then you approve it. That sequence is the
point: a decision that rejects a driver rests on criteria a person signed off,
not on a machine's unreviewed reading of a PDF.

Read any warnings above the editor. The most common one — *"Only one eligibility
path was found"* — is worth taking seriously every time, for the reason in the
next section.

Without a key, the panel says extraction is unconfigured and you write the
criteria yourself. It never invents them.

### The two shapes a rule takes

**Eligibility paths are alternatives.** A driver who satisfies *any one* path
qualifies. Conditions *within* a path must all hold.

This is the part most worth getting right. Insurer guidelines are usually
written as prose that reads like a single list, but they very often contain
alternatives:

> *"Drivers must have two years of verifiable CDL experience with no more than
> three moving violations in 36 months. Drivers with one year of experience may
> be considered with no more than one moving violation."*

That is **two paths**, not one requirement with an exception. Written as one
path with a 24-month minimum, a driver with 14 months and a clean record is
rejected by a rule his insurer would have accepted.

**Disqualifiers are absolute.** A disqualifier's condition describes the
*acceptable* state; failing it disqualifies, whatever any path says.

### Worked example

The prose above becomes:

```json
{
  "schemaVersion": 1,
  "eligibilityPaths": [
    {
      "id": "path.two_year",
      "label": "Two-year experience path",
      "sourceText": "Two years of verifiable CDL experience, no more than three moving violations in 36 months.",
      "conditions": [
        { "type": "min_experience_months", "months": 24 },
        { "type": "max_events", "category": "moving_violation", "lookbackMonths": 36, "max": 3 },
        { "type": "license_status_in", "statuses": ["Valid"] }
      ]
    },
    {
      "id": "path.one_year",
      "label": "One-year experience path",
      "sourceText": "One year of experience considered with no more than one moving violation.",
      "conditions": [
        { "type": "min_experience_months", "months": 12 },
        { "type": "max_events", "category": "moving_violation", "lookbackMonths": 36, "max": 1 },
        { "type": "license_status_in", "statuses": ["Valid"] }
      ]
    }
  ],
  "disqualifiers": [
    {
      "id": "dq.major",
      "label": "No major violations in five years",
      "sourceText": "Any DUI, reckless driving, or leaving the scene within 5 years is unacceptable.",
      "condition": { "type": "max_events", "category": "major_moving_violation", "lookbackMonths": 60, "max": 0 }
    }
  ]
}
```

Put the insurer's actual words in `sourceText`. It is quoted back in the
explanation, so anyone auditing a decision sees the rule as written next to the
decision it produced.

### Every condition available

| Condition | Fields | Means |
| --- | --- | --- |
| `min_experience_months` | `months` | Completed months since the **original** CDL issue date |
| `min_age_years` | `years` | Age at the evaluation date |
| `max_events` | `category`, `lookbackMonths`, `max` | At most `max` matching records in the window |
| `max_points` | `basis`, `lookbackMonths`, `max` | At most `max` points; `basis` is `state` or `mvr_activity` |
| `license_status_in` | `statuses` | Any of `Valid`, `Expired`, `Suspended`, `Revoked`, `Disqualified` |
| `cdl_class_in` | `classes` | e.g. `["A"]` or `["A", "B"]` |
| `requires_valid_medical_card` | — | An unexpired medical certificate is on file |
| `max_suspensions` | `lookbackMonths`, `max` | Explicit suspension records only |

Categories for `max_events`: `moving_violation`, `minor_moving_violation`,
`serious_moving_violation`, `major_moving_violation`, `accident`,
`at_fault_accident`, `administrative`.

Three things worth knowing while you write these:

- **Each condition carries its own window.** Minors over 36 months and majors
  over 60 in the same path is normal, not a conflict.
- **Suspensions only matter if you say so.** There is no built-in suspension
  rule. Without `max_suspensions`, a suspension on the MVR affects nothing.
- **`administrative` exists but is rarely what you want.** Parking tickets and
  court fees are excluded from violation counts by default. Only count them if
  your insurer explicitly says to.

### Approve it

A saved guideline sits at **awaiting approval** and decides nothing — drivers
evaluated against it come back Manual Review. Press **Approve** when the
criteria match the document. That gate is what stops an untested rule from
quietly rejecting people.

Replacing a guideline later archives the old version rather than deleting it, so
past decisions can still be explained.

---

## 3. Add a driver

**Applicants → Add applicant.** Choose the company, enter the name, and drag in
the MVR, CDL/licence and medical card.

Press **Read documents and fill fields**. With `OPENAI_API_KEY` set, the fields
populate from the documents. Without it, the panel says extraction is
unconfigured and you type the evidence in — it never invents values.

### What to check before saving

Extraction is an assistant, not an authority. Four things are worth your eyes:

- **Original CDL issue date.** The one field most often wrong, because licences
  show several dates. It must be the *first* issue date — "CDL since" — not the
  current card's issue or renewal date. The panel shows the derived month count
  beside it; if that number looks far off, this date is why.
- **MVR order date.** Anchors every lookback window. An MVR older than 90 days
  holds the driver for review.
- **Each violation description**, kept exactly as printed. The classification
  shown beside it (Administrative, Minor, Serious, Major) drives what counts.
  Anything it could not classify is flagged rather than assumed harmless.
- **Suspensions**, which are recorded only when a document explicitly reports
  one. Never add a suspension because a violation looks like it caused one.

Press **Verify, evaluate, and create**.

---

## 4. Read the decision

The dashboard shows each coverage and an overall result. **Auto Liability alone
sets the overall decision** — a Cargo or Physical Damage result never makes a
driver Not Qualified.

| Status | Means |
| --- | --- |
| **Qualified** | An eligibility path is fully satisfied and no disqualifier fires |
| **Not Qualified** | Every path was decidable on the evidence, and each one fails |
| **Manual Review** | Something is missing, stale, unclear, or the guideline is unapproved |
| **Not Evaluated** | No active guideline for that company and coverage |

**Manual Review is not a soft rejection.** It means the system declined to
decide. Missing evidence never produces Not Qualified — that rule is what keeps
an absent medical card from reading as a disqualification.

Open **Compare** on any driver to see the reasoning: the guideline and version
applied, the exact path, the evidence used, and every record excluded *with the
reason it was excluded*. If a violation you expected to count did not, that list
tells you whether it fell outside the window or was classified as
non-countable.

### Other things you can do

- **Applying company dropdown** on any row moves a driver and re-evaluates them.
  The previous company's result is kept, not overwritten.
- **Compare** evaluates several companies at once, independently.
- **Update CDL/MVR** replaces the evidence with a fresh read and re-evaluates.
  Earlier evidence snapshots are retained.
- **Manual reviews** lists everyone held for review with the specific gap.
- **Audit log** records every change, with the guideline version and evidence
  snapshot behind each decision.

---

## 5. Record the human decision

Every result carries a disclaimer, and it is not decoration. The engine applies
criteria to evidence; it does not know about the interview, the reference check,
or anything else in the file. An authorised safety or underwriting
representative makes the hiring decision.

---

## Before you put real driver records in

- **There is no authentication yet.** Anyone with the URL has full access to
  every record. The Team & roles screen documents intended permissions; it does
  not enforce them. Put an authentication layer in front of a public URL.
- **Source documents are not retained.** They are read and discarded; only the
  extracted evidence is stored. If your retention policy requires keeping the
  originals, wire up private object storage.
- **Extraction and FMCSA lookup have not been exercised with live keys.** Run
  both against documents whose correct answers you already know before trusting
  them.
- **Back up the database**, and test a restore before you rely on it.
- **Guideline criteria are only as good as your translation.** Have a second
  person check the rule tree against the insurer's document before approving —
  the approval gate exists for exactly that review.
