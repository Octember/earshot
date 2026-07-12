# Tool registries, read/write split, and capability lines in the turn prompt

**Date:** 2026-07-12 (rev 3 — `usage` is rich multi-line text on ToolSpec itself, no wrapper type)
**Status:** approved-pending-review
**Motivating incident:** 2026-07-12 #bug-reports — the live bot, with no integration tools
granted, hand-curled the Linear GraphQL API in one turn (reading `LINEAR_API_KEY` out of the
daemon's `.env` from the shell, bypassing the broker's outward-action gate) and declared "this
workspace doesn't have Linear write access" in the next. Capability awareness is currently
buried in tool schemas and rediscovered nondeterministically per turn.

## Goal

1. The tool catalog is a list of **registries** — one per integration, each owning an **array
   of tools** (`linear` → `linear_read`, `linear_write`). Each tool carries hand-authored
   **`usage`** text at its registration site: rich, multi-line, deliberately a prompt-injection
   surface for everything the model should know before calling it — API quirks, id-lookup
   conventions, failure shapes, when to prefer a sibling tool. Nothing is derived by splitting
   description strings.
2. Integration tools split by grain: **read tools** reject writes at the tool boundary and are
   never consequential; **write tools** are always `outward` (broker confirmation gate).
   Grants name the split tools, so an identity can hold `linear_read` without `linear_write`.
3. Every fresh turn's injected prompt lists its capabilities, grouped by registry, derived
   from the turn's **actual built toolset** — it can never drift from what is callable, and a
   read-only grant renders as read-only.

## Design

### `usage` lives on ToolSpec — no wrapper type

`ToolSpec` (src/policy/broker.ts) gains one field, next to `description`/`inputSchema`:

```ts
// Rich model-facing usage text injected into the turn prompt (multi-line welcome): API
// quirks, id-lookup conventions, failure shapes, when to use a sibling tool instead.
// `description` stays the terse schema-level one-liner; this is the manual.
usage?: string;
```

The registry is just grouping — its tools are plain `ToolSpec`s:

```ts
interface ToolRegistry {
  name: string;                    // "linear", "github", "notion", "ops", "db"
  tools: Record<string, ToolSpec>; // "linear_read", "linear_write", …
}
export const INTEGRATION_REGISTRIES: ToolRegistry[]
```

Everything else derives from this one array (no parallel constants):

- `integrationCatalog(): ToolCatalog` — flattened `Record<toolName, ToolSpec>` for the broker.
- `INTEGRATION_TOOL_NAMES` — flattened names; main.ts's `KNOWN_TOOLS` keeps deriving from it.
- The prompt's registry grouping (below).

### Read/write split

The kit stays untouched — it is policy-agnostic by contract and already exports the
classifiers (`isLinearMutation`, `isGithubWrite`, `isNotionReadPath`) precisely so hosts can
gate by grain. earshot wraps each kit transport into two tools:

| Registry | Tool           | Boundary contract                                             | Action class |
|----------|----------------|---------------------------------------------------------------|--------------|
| linear   | `linear_read`  | rejects mutation documents (friendly error naming `linear_write`) | none     |
| linear   | `linear_write` | accepts only mutation documents (reads → use `linear_read`)   | `outward`    |
| github   | `github_read`  | rejects write methods                                         | none         |
| github   | `github_write` | accepts only write methods                                    | `outward`    |
| notion   | `notion_read`  | rejects non-read paths                                        | none         |
| notion   | `notion_write` | accepts only write paths                                      | `outward`    |
| ops      | `ops_read`     | as today (read-only by endpoint allowlist)                    | none         |
| db       | `db_read`      | as today (read-only by database role)                         | none         |

The grain check is the tool's own boundary (rejects with a friendly error), not just policy
classification — so a write can never ride through a read grant, and the `actionClasses`
function becomes static per tool instead of sniffing arguments per call.

Grant migration: none needed — the live deployment's `grants` is empty; the old names
(`linear_graphql`, `github_api`, `notion_api`) simply cease to exist in `KNOWN_TOOLS`, so a
stale policy file fails validation loudly at load, not silently at call time.

### Built-ins

Built-ins group the same way for rendering: `tasks` (task_create/steer/cancel/confirm/query),
`memory` (memory_write/retract/tier, search), `posting` (reply, react, checklist),
`scheduling` (set_wake), `outcome` (task_complete/task_fail/task_ask), `audit` (audit_query
when granted). Their prompt text is their existing `description` verbatim — one selection
rule for every tool, no extraction: **a tool's prompt entry is its `usage` when authored,
else its `description`**. A built-in that later earns a manual just gets a `usage` string
where it's defined; nothing structural changes.

### Prompt slot

`TurnPrompt` (src/turn-runner/context.ts) gains:

```ts
// capabilities grouped by registry, derived from the built toolset — fresh contexts only
// (same convention as `speaker`; a resumed codex thread already knows)
toolbox?: { registry: string; tools: { name: string; text: string }[] }[];
```

Builders call `buildToolset(...)` before `renderTurnPrompt` and derive the slot from the
returned `DynamicTool[]` intersected with the registries — a registry entry appears only with
the tools this turn actually has, so ambient's reduced set and partial grants render
truthfully (only `linear_read` granted → only the `linear_read` entry shows).

`renderTurnPrompt` renders (formatting lives there and nowhere else) — multi-line `usage`
renders as a block under the tool name:

```
Your tools this turn:

## linear
### linear_read
Look up Linear issues, projects, comments, teams, workflow states (GraphQL reads only).
Look up the ids you need (team by key, state by name) before asking for a mutation via
linear_write. Issue identifiers look like "BEV-4128". A top-level `errors` array means the
query failed even though the call "succeeded".
### linear_write
Create or update Linear issues (GraphQL mutations only; reads belong to linear_read). This is
a consequential action: expect to be asked to confirm before it runs. …

## posting
### reply
Post a message to a venue/thread you are permitted to post in.
…

If a tool isn't listed, you don't have it this turn; say so plainly rather than working around it.
```

The trailing line is room-safe by design (per the instructions-leak rule) and closes both
incident failure modes: claiming a listed ability is missing, and shell-working-around an
ability that genuinely isn't.

### Deployment quirks ride the grant (follow-on, same mechanism)

`usage` in catalog.ts documents the *API* (generic: GraphQL grain, id lookups, error shapes).
Workspace conventions ("team key is BEV", "file bugs into Bevyl / Triage Bug Reports",
"dedupe against the last week of #bug-reports first") belong to the *deployment*. The natural
carrier already exists: the identity's grant in policy.yaml gains an optional `usage` string,
appended after the catalog text for that tool. bevelina-deploy then owns Bevyl's Linear
conventions the same way it owns policy today — no earshot fork, no workspace doc for the
model to fail to find. This is a small additive policy-schema change; it ships with this
design but can land as its own commit.

### SPEC changes

- §11 "Construct turn context:" gains a clause: the context MUST include, for each tool
  exposed to the turn, the tool's registered usage text (falling back to its description),
  grouped by the tool's registry.
- §10.1/§10.2 unchanged in semantics; the split tools make "external-mutation tools" concrete
  (`*_write` are exactly the ambient-denied external mutations).
- §18 gains rows: (a) read tools reject write operations at the boundary; (b) write tools are
  always confirmation-gated for non-preauthorized turns; (c) per turn kind, the prompt's
  toolbox and the built toolset agree exactly; (d) a partially granted registry renders only
  its granted tools.

### Tests (TDD order, per §18 rows)

1. Registry derivations — flattened catalog and names match the registry array; no orphans.
2. Grain boundaries — `linear_read` given a mutation fails friendly; `linear_write` given a
   read fails friendly; same for github/notion pairs.
3. Broker — `*_write` classified outward statically; read tools never.
4. Prompt — toolbox renders grouped as specified (`usage` block when authored, `description`
   otherwise); absent slot renders nothing; toolbox ≡ built toolset per turn kind; partial
   grant renders read-only.
5. Grant usage — a grant's `usage` string appends after the catalog text for that tool only.

## Out of scope (tracked separately, both live-deployment issues, not this repo)

- Live `policy.yaml` has `grants: []` — after this lands, grant `linear_read` +
  `linear_write` in `bevelina-deploy` and restart.
- Credential isolation is defeated by the sandbox: `danger-full-access` + a readable
  `~/earshot/.env` means the model can bypass ungranted tools and the confirmation gate with
  curl. Needs its own design (key placement or sandbox policy).
