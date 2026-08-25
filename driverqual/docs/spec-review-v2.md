# Review of Master Implementation Prompt v2.0

Specification v2.0 is a large step up from v1. Most of what this document
records is not error but *newly specified behaviour* — the experience-band
table, the threshold matrix, PSP handling, CDL date provenance and the provider
adapter are all genuine additions that close real gaps.

What follows is what had to be decided before v2.0 could be implemented: three
internal contradictions, and the resolutions chosen. Everything here is
implemented and covered by tests.

---

## Contradictions resolved

### V1. §4.3 and §4.4 give different instructions for choosing a branch

§4.3 says to evaluate **all** alternative paths and apply whichever the
applicant satisfies, never choosing a stricter branch to reject them. §4.4 says
to select the branch **deterministically from completed experience months**.

Read carelessly these conflict: one says try everything, the other says pick one
up front.

**Resolution — they agree, and the agreement is the important part.** The
experience bands in §4.4 (24+, 12–23, under 12) are *mutually exclusive*, so
selecting by months is not narrowing the search; it is recognising that only one
branch was ever available. A 17-month driver is a one-year driver, not a
two-year driver who fell short.

The implementation makes this explicit rather than implicit. An eligibility path
may carry `appliesToExperienceBand`. When any path is banded, the driver's band
is computed first and non-matching branches are reported as **not applicable**,
with the reason, rather than as **failed**. Unbanded guidelines keep v1's
try-every-path behaviour untouched.

This distinction is what §5.5 is really testing. Without it, a 17-month driver
with two violations gets an explanation saying they failed a two-year
requirement — technically true, actively misleading, and exactly the reasoning
error the specification is trying to eliminate.

### V2. §4.4 and §10 disagree on whether "Qualified with Condition" is a status

§4.4 says to return "Qualified or Qualified with Condition according to the
configured status model". §10's JSON schema then defines `decision` as
`"Qualified | Not Qualified | Manual Review"` — no fourth value.

**Resolution: the decision stays `Qualified`; conditions are a separate field.**
`underwriting_conditions` carries them, and the interface displays them
prominently beside the decision.

This follows §10's schema, which is the more specific of the two, and it is also
the safer reading: a distinct status invites downstream code to treat it as
"not really qualified", which is precisely what §4.4 warns against when it says
the deductible increase "is an underwriting condition, not an automatic driver
rejection". A driver who satisfies the one-year criteria is qualified. The
placement carries a term.

If you want the distinct label on screen, it is a display change over the same
data — no engine change and no schema change.

### V3. §4.1's precedence rule is unimplementable as stated

§4.1 gives a three-step precedence but describes the inputs only as "every
possible CDL issue date" with a source and label. It does not say what happens
when two documents both claim to be original, nor which of "explicit original on
another authoritative document" outranks which.

**Resolution.** Candidates are ranked CDL > MVR > PSP > Other among those
explicitly marked original; ties break to the earliest date, on the reasoning
that two documents both claiming "original" and disagreeing means the later one
is describing a re-issue.

Critically, **a date that is not explicitly labelled original is never used at
all** — not even when it is the only date present. "Earliest wins" was rejected
as a fallback: an early date on an unlabelled field is no more trustworthy than
a late one, and guessing here silently changes a driver's credited experience by
years. No labelled original means Manual Review.

---

## Ambiguities that needed a decision

### V4. Where the deductible condition attaches

§4.4 puts the deductible increase in the 1-year row of the table, but a rule
tree has no rows. It is implemented as `underwritingConditions` on the
**eligibility path**, so it attaches only when that path is the one satisfied —
not when the guideline merely contains it.

### V5. What "never count PSP inspections as moving violations" means for other categories

§6.1 forbids counting inspections as moving violations, and says nothing about
accidents or administrative records. Implemented as: an inspection is excluded
from **every** violation category. A roadside inspection is a record that an
inspection occurred, not a finding against the driver, and the reasoning that
keeps it out of the violation count keeps it out of the others too.

### V6. Which document wins when the same incident appears on MVR and PSP

§6.1 requires deduplication but does not say which copy survives. The **MVR copy
is kept**, because it is the conviction record; the PSP copy is reported as a
duplicate rather than dropped silently, so a reviewer can see both documents
carried it.

Matching is on effective date plus a normalised description (case, punctuation
and spacing removed), since the two documents word the same offence differently.

### V7. "Under 1 year — not eligible under this guideline"

§4.4 says drivers under twelve months are "not eligible under this guideline
unless another explicit path exists". Taken literally that reads as Not
Qualified.

Implemented as **Manual Review**. A guideline that defines no branch covering a
driver has not rejected them — it does not address them. Returning Not Qualified
would assert the guideline said something it never said, and §2.4 is explicit
that a rejection requires evidence conflicting with an explicit requirement.

---

## What v2.0 got right that is worth keeping

Three additions close real holes in v1, and are worth naming because they are
the kind of thing usually discovered only after a bad decision reaches a driver:

- **§4.4's threshold examples.** Spelling out that "1 minor with a maximum of 3
  passes" and "3 with a maximum of 3 passes" removes the inclusive/exclusive
  ambiguity that turns a compliant driver into a rejected one on an off-by-one.
- **§5.6's major-classification safeguard.** Requiring a major classification to
  record the record text, the matched category *and* the guideline wording
  authorising it is the difference between an auditable decision and a
  plausible-sounding one. It also correctly identifies that "fail to have
  vehicle under control" is the ambiguous case.
- **§4.1's provenance requirement.** Recognising that an MVR shows a state
  issuance date which must not overwrite the CDL's original is a specific,
  costly failure mode that a generic "extract the issue date" instruction walks
  straight into.

---

## One thing v2.0 still does not settle

§10 requires the validator to "independently recompute … and overall Auto
Liability status", and §18 says never to rely on an unconstrained prompt for the
final decision. Both are implemented. But v2.0 never states plainly **who
decides** — it describes validation of model output rather than saying the model
does not decide at all.

The implementation takes the stronger position: the provider contract has no
method capable of returning a decision. Providers transcribe documents and draft
rule trees; the decision is computed in `domain/engine.ts` from the resulting
evidence, and nothing in the vendor layer can reach it. A test walks the source
and fails if a vendor name appears in the domain, database or interface layers,
so the portability requirement in §11 is enforced rather than intended.

Recommended wording for a future revision: *"AI providers extract and interpret
documents. They do not decide. The qualification decision is computed in
application code from normalised evidence, and no provider output is capable of
expressing a decision."*
