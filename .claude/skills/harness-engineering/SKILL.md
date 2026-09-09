# Harness Engineering

Multi-agent orchestration patterns for building complex systems fast. Based on the Fable-orchestrator + Opus-workers pattern.

## Triggers
- /harness
- /harness:plan
- /harness:workflow
- "set up multi-agent workflow"
- "orchestrate this with agents"
- "use the harness pattern"
- "build this with parallel agents"

## Core Pattern

```
Fable 5.1 (Orchestrator) — Terminal 1
├── Does NOT write code
├── Sets /goal with done criteria
├── Breaks task into parallel slices
└── Reviews reports+diffs, loops until done

Opus/Sonnet (Workers) — Terminals 2–N
├── Own terminal, own context
├── Each owns one slice (UI / API / DB / Tests)
└── Reports diffs back, not full files

Hooks (Quality Gate — after every edit)
├── typecheck → catches syntax errors before orchestrator sees them
├── tests → no broken code reaches review
└── ruff/lint → style enforced automatically
```

## When to use

Use this pattern when a task is:
- Larger than ~3 files changed
- Has independent parallel workstreams (frontend + backend + tests)
- Benefits from specialization (one agent per domain)

Do NOT use for: single file edits, bug fixes, small features — direct edit is faster.

## Workflow commands

### /harness:plan
Break a goal into orchestrator-ready agent assignments.

Input: Goal description
Output:
- /goal statement with measurable done criteria
- List of agent assignments (Agent N: what they own, what done looks like)
- Hook configuration needed
- Estimated token cost vs. single-agent approach

### /harness:workflow
Write a Workflow tool script for the task.

Follows the pipeline pattern:
```js
export const meta = { name, description, phases: [{title: 'Build'}, {title: 'Verify'}] }
const AGENTS = [{key: 'ui', prompt: '...'}, {key: 'api', prompt: '...'}, {key: 'tests', prompt: '...'}]
const results = await pipeline(AGENTS, a => agent(a.prompt, {phase: 'Build', schema: SCHEMA}),
  r => agent(`Verify: ${r.summary}`, {phase: 'Verify', schema: VERDICT}))
```

## TMS-specific agent splits

When building TMS, use:
- Agent 1: Supabase schema + migrations
- Agent 2: FastAPI endpoints + auth
- Agent 3: React dispatcher dashboard
- Agent 4: Driver mobile API
- Agent 5: Integration layer (Plaid, QuickBooks, FMCSA API)
- Agent 6: Tests + CI

## Token economics

| Approach | Tokens | Time |
|----------|--------|------|
| Single Fable doing everything | 500K+ | Slow, serial |
| Fable orchestrates 3 Opus workers | ~120K total | 3x faster |
| Hooks catching errors before Fable review | Saves ~40% review tokens | — |

Rule: Expensive tokens on thinking, cheap tokens on code.
