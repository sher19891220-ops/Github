# DriverQual — Driver Qualification Platform

Evidence-based, company-specific driver qualification for trucking safety
departments. Implements `docs/master-implementation-prompt-v2.md`.

## Quick start

```bash
npm install
npm run dev            # http://localhost:3000
```

The application starts empty — no sample companies, applicants or guidelines. Add
a company, upload a guideline for a coverage, approve its interpreted criteria,
then add an applicant.

## Trying it out

Three ways to exercise the app, in increasing order of realism.

**1. Run the checks.** `npm run test:all` runs typecheck, 123 unit and
integration tests, a production build, and 51 Playwright tests at phone, tablet
and desktop widths. This is what proves the engine, not the screenshots.

**2. Run the built app.** `npm run build && npm run start`, then open
<http://localhost:3000>. It starts empty by design.

**3. Seed the acceptance scenario and click through it.** With the app running:

```bash
npm run demo
```

This creates three companies, an approved Auto Liability guideline for two of
them, a coverage 90 days from expiry, and the two acceptance-case drivers — all
through the HTTP API, so it goes through the same validation, evaluation and
audit path as a real user's clicks. Every date is relative to today, so the
scenario behaves the same whenever it is run.

It refuses to run against a non-local URL unless passed `--force`: the
specification forbids fictional drivers in a deployed system.

What to look at afterwards is printed when it finishes. The most informative
screen is **Phenias → Compare**: one driver and one set of documents produce
Qualified at Zone, Not Qualified at Xtrack and Manual Review at Acme, each
explained against that company's own guideline.

## Commands

| Command | What it does |
| --- | --- |
| `npm run typecheck` | TypeScript, no emit |
| `npm run test` | 118 unit + integration tests (vitest) |
| `npm run build` | Production build |
| `npm run test:ui` | 51 Playwright tests at phone, tablet and desktop widths |
| `npm run demo` | Seed the acceptance scenario into a running local instance |
| `npm run test:all` | All four, in order |

## Architecture

The decision logic is deterministic and lives entirely in `src/domain/`, with no
model in the path. Models transcribe documents; they never decide anything.

| Module | Responsibility |
| --- | --- |
| `domain/dates.ts` | Calendar-date arithmetic: completed months, lookback windows |
| `domain/types.ts` | Coverages, decisions, evidence shape, thresholds |
| `domain/classification.ts` | MVR description → event type and severity tier |
| `domain/evidence.ts` | Normalisation, effective dates, counting, blockers |
| `domain/guideline.ts` | Rule-tree schema, review gate |
| `domain/engine.ts` | Tri-state conditions, coverage decision, overall decision |
| `domain/guard.ts` | Numeric-claim guard, model-output validation |
| `db/` | libSQL schema, async repositories, append-only audit |
| `server/` | Settings and secrets, upload validation, extraction |
| `app/` | Next.js routes and screens |

### Invariants worth knowing

- **Dates never become instants.** Everything is `YYYY-MM-DD` arithmetic on integer triples, so no timezone can shift a record across a window boundary.
- **MVR windows anchor on the MVR order date; experience anchors on the evaluation date.** Two different anchors, deliberately.
- **One effective date per record** — conviction if present, else violation — used for classification, window membership and ordering alike.
- **Conditions are tri-state.** `indeterminate` is why missing evidence yields Manual Review and never Not Qualified.
- **Company isolation is structural.** The evaluator receives one guideline and throws if it belongs to a different company or coverage; it has no way to reach another's rules.
- **Unapproved interpretations cannot decide.** A guideline whose rule set is missing or unapproved returns Manual Review.
- **The engine decides; models only draft prose.** A drafted explanation that disagrees with the engine, cites an absent criterion, or fails the numeric guard is rejected.

## Configuration

Storage is libSQL. With no configuration the app uses a local file; point it at a
hosted [Turso](https://turso.tech) database and the same code path serves
production. See `DEPLOY.md` for free hosting.

| Variable | Purpose |
| --- | --- |
| `TURSO_DATABASE_URL` | `libsql://…` for hosted, or `file:…` for local (default `file:.data/driverqual.db`) |
| `TURSO_AUTH_TOKEN` | Required with a `libsql://` URL |
| `OPENAI_API_KEY` | Extraction; can also be set in Settings |
| `OPENAI_MODEL` | Extraction model (default `gpt-4.1-mini`) |
| `FMCSA_API_KEY` | USDOT lookup; can also be set in Settings |

Secrets set in Settings are stored server-side and returned only as a masked
hint. Without a key, extraction and USDOT lookup report that they are
unconfigured and offer manual entry — they never return placeholder data.

## Testing notes

Unit tests pin the acceptance cases from §5 of the specification, including the
Phenias record whose conviction date falls inside the lookback window while its
violation date falls outside — the case that distinguishes correct reasoning from
a coincidentally correct answer.

Playwright runs against a real production build with a real database, resetting
it in the web-server command (Playwright starts the server before `globalSetup`,
so a setup hook would unlink the file out from under a live connection).

Integration tests run against a throwaway libSQL file per test — libSQL has no
in-memory mode — so they exercise the same client and dialect as production.
