# Tool capability lines in the turn prompt

**Date:** 2026-07-12
**Status:** approved-pending-review
**Motivating incident:** 2026-07-12 #bug-reports — the live bot, with no integration tools
granted, hand-curled the Linear GraphQL API in one turn (reading `LINEAR_API_KEY` out of the
daemon's `.env` from the shell, bypassing the broker's outward-action gate) and declared "this
workspace doesn't have Linear write access" in the next. Capability awareness is currently
buried in tool schemas and rediscovered nondeterministically per turn.

## Goal

Every turn's injected prompt tells the model what tools it has, in one short line per tool, so
capability claims and tool choice are grounded in the actual toolset instead of per-turn shell
archaeology. The list is **derived from the turn's real toolset** — it can never drift from
what is callable.

## Design

### New prompt slot

`TurnPrompt` (src/turn-runner/context.ts) gains one slot:

```ts
// one line per tool actually exposed to this turn — derived from the built toolset,
// never hand-authored (fresh contexts only; a resumed codex thread already knows)
toolbox?: { name: string; blurb: string }[];
```

`renderTurnPrompt` renders it (formatting lives there and nowhere else):

```
Your tools this turn:
- linear_graphql: Execute a single raw GraphQL query or mutation against Linear (issues, projects, comments, teams, workflow states).
- reply: Post a message to a venue/thread you are permitted to post in.
- …
If a tool isn't listed, you don't have it this turn; say so plainly rather than working around it.
```

The trailing line is room-safe by design (per the instructions-leak rule): if parroted into
Slack it reads as a normal statement of limits, not leaked machinery. It exists to close both
failure modes from the incident — claiming an ability is missing when the tool is listed, and
shell-working-around an ability that genuinely isn't.

### Blurb derivation

A small pure helper in context.ts:

```ts
export function toolboxFromTools(tools: DynamicTool[]): { name: string; blurb: string }[]
```

`blurb` is the first sentence of `spec.description` (text up to the first `.` followed by
whitespace/end, whole description if no sentence break), truncated to 160 chars. No new
metadata field on tools: descriptions already exist on every `DynamicTool` and are written to
be model-facing; a parallel hand-authored summary would be a second string to keep in sync,
which is the drift failure mode this feature exists to kill. First-sentence extraction is flat
text plumbing, not semantic sniffing.

### Wiring

Builders (service.ts) already call `buildToolset(...)` for every turn kind; they call it
**before** `renderTurnPrompt` and pass `toolbox: toolboxFromTools(tools)` for fresh contexts
(same convention as the `speaker` slot — resumed codex threads already carry the list; the
tool schemas are re-registered with the session regardless, so a stale resumed thread is
degraded, not wrong). This includes interactive, ambient, distillation, and execution-step
turns; each kind's list automatically reflects its reduced toolset because it is derived from
the same array handed to `sessionFactory`.

Scope decision (operator call, 2026-07-12): **all tools in the turn's toolset**, built-ins
included, not just integrations.

### SPEC change

SPEC §11 "Construct turn context:" gains one clause: the context MUST include a short
capability line for each tool exposed to the turn, derived from the tool's registered
description. §18 gains a matrix row: per turn kind, the prompt's tool list and the built
toolset agree exactly (ambient shows no task/confirm/scheduling/external-mutation tools;
distillation shows no posting tools; a non-granted external tool never appears).

### Tests (TDD order)

1. `toolboxFromTools` — first-sentence extraction, no-period description, truncation.
2. `renderTurnPrompt` — slot renders as specified; absent slot renders nothing.
3. §18 row — build toolsets for each turn kind against a catalog with granted and ungranted
   tools; assert prompt list ≡ toolset names, and the ungranted tool is absent.

## Out of scope (tracked separately, both live-deployment issues, not this repo)

- Live `policy.yaml` has `grants: []` — Linear/db_read/ops_read are wired but never granted.
  Fix in `bevelina-deploy` (grant `linear_graphql`), then restart.
- Credential isolation is defeated by the sandbox: `danger-full-access` + a readable
  `~/earshot/.env` means the model can bypass ungranted tools and the confirmation gate with
  curl. Needs its own design (key placement or sandbox policy).
