# Tool registries, read/write split, and capability lines in the turn prompt

**Date:** 2026-07-12 (rev 5 — registries carry structured example calls, filtered to the turn's toolset)
**Status:** approved-pending-review
**Motivating incident:** 2026-07-12 #bug-reports — the live bot, with no integration tools
granted, hand-curled the Linear GraphQL API in one turn (reading `LINEAR_API_KEY` out of the
daemon's `.env` from the shell, bypassing the broker's outward-action gate) and declared "this
workspace doesn't have Linear write access" in the next. Capability awareness is currently
buried in tool schemas and rediscovered nondeterministically per turn.

## Goal

1. The tool catalog is a list of **registries** — one per integration, each owning an **array
   of tools** (`linear` → `linear_read`, `linear_write`), a hand-authored **`skill`** (rich,
   multi-line, deliberately a prompt-injection surface: what the integration is for, when to
   reach for which tool, the conventions that keep it honest — in room-safe capability
   language, never transport mechanics), and structured **example calls** (which carry the
   mechanics by demonstration). Integration-shaped knowledge attaches to the registry, never
   duplicated across the tools in it. Tools keep only their terse schema `description`.
   Nothing is derived by splitting description strings.
2. Integration tools split by grain: **read tools** reject writes at the tool boundary and are
   never consequential; **write tools** are always `outward` (broker confirmation gate).
   Grants name the split tools, so an identity can hold `linear_read` without `linear_write`.
3. Every fresh turn's injected prompt lists its capabilities, grouped by registry, derived
   from the turn's **actual built toolset** — it can never drift from what is callable, and a
   read-only grant renders as read-only.

## Design

### Registry shape — the skill lives on the group, ToolSpec stays clean

```ts
// A worked call: the single highest-leverage thing to inject for correct tool use
// (GraphQL especially — the model composes exact documents; one worked mutation beats
// paragraphs of prose). STRUCTURED, not baked into the skill string, for one hard reason:
// the renderer filters examples to the turn's exposed tools, so a read-only grant never
// sees a mutation example.
interface ToolExample {
  when: string;    // "file a bug ticket once you have the team and state ids"
  tool: string;    // "linear_write" — must name a tool in this registry
  args: unknown;   // the literal arguments object, JSON-rendered verbatim
  result?: string; // optional trimmed sample response, teaches the failure/success shape
}

interface ToolRegistry {
  name: string;                    // "linear", "github", "notion", "ops", "db"
  // The group's manual, injected into the turn prompt when any of its tools are exposed.
  // Multi-line, model-facing, ROOM-SAFE: what the group is for, when to reach for which
  // tool, the conventions that keep it honest. Never transport mechanics — those live in
  // inputSchema/description (contract) and examples (demonstration); prompt prose gets
  // parroted into Slack. Integration-shaped knowledge lives HERE exactly once.
  skill?: string;
  examples?: ToolExample[];        // ordered — a lookup-then-mutate workflow reads in sequence
  tools: Record<string, ToolSpec>; // "linear_read", "linear_write", …
}
export const INTEGRATION_REGISTRIES: ToolRegistry[]
```

`ToolSpec` (src/policy/broker.ts) is untouched: `description` stays the terse schema-level
one-liner codex sees on the tool itself. The proof this grain is right came from drafting the
per-tool version: the Linear conventions had to be written into both `linear_read` and
`linear_write`, and deployment conventions would have been pasted onto both grants.

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

Built-ins group into registries the same way: `tasks` (task_create/steer/cancel/confirm/query),
`memory` (memory_write/retract/tier, search), `posting` (reply, react, checklist),
`scheduling` (set_wake), `outcome` (task_complete/task_fail/task_ask), `audit` (audit_query
when granted). Each group can carry a `skill` when it earns one; tools render as
`name: description` verbatim either way. Nothing structural distinguishes a built-in group
from an integration group in the prompt.

### Prompt slot

`TurnPrompt` (src/turn-runner/context.ts) gains:

```ts
// capabilities grouped by registry, derived from the built toolset — fresh contexts only
// (same convention as `speaker`; a resumed codex thread already knows)
toolbox?: {
  registry: string;
  skill?: string;
  tools: { name: string; description: string }[];
  examples?: ToolExample[]; // already filtered to the exposed tools
}[];
```

Builders call `buildToolset(...)` before `renderTurnPrompt` and derive the slot from the
returned `DynamicTool[]` intersected with the registries — a registry entry appears only with
the tools this turn actually has, and only the examples whose `tool` is exposed. Ambient's
reduced set and partial grants render truthfully: only `linear_read` granted → only the
`linear_read` line and read examples show, under the full linear skill.

`renderTurnPrompt` renders (formatting lives there and nowhere else) — the skill as a block
under the group heading, one line per exposed tool, then worked examples with their args as
canonical JSON:

```
Your tools this turn:

## linear
Your window into the team's tickets: look them up, file them, update them. Before you change
anything, look up the real ids you need first; names and keys are how people talk, ids are
what changes stick to. Tickets go by identifiers like "ACME-4128". A change that matters will
wait for a go-ahead before it lands. Check whether a ticket already covers something before
filing a new one.
- linear_read: Look up tickets, projects, comments, teams, and workflow states.
- linear_write: File or update a ticket.

For example — find the team and its workflow states:
linear_read {"query":"query { teams(filter:{key:{eq:\"ACME\"}}) { nodes { id key states { nodes { id name type } } } } }"}
…then file the ticket:
linear_write {"query":"mutation($input: IssueCreateInput!) { issueCreate(input:$input) { success issue { identifier url } } }","variables":{"input":{"teamId":"…","stateId":"…","title":"…","description":"…"}}}

## posting
- reply: Post a message to a venue/thread you are permitted to post in.
…

If a tool isn't listed, you don't have it this turn; say so plainly rather than working around it.
```

**Authoring rule (normative for every skill and description):** prompt text gets parroted —
whatever vocabulary the skill uses is vocabulary the model will use in the room. So skills
are written in room-safe capability language (what it's for, when to reach for it, the
conventions that keep it honest), never transport mechanics. Mechanics have two homes
already: the tool's `inputSchema`/`description` (the contract) and the worked examples
(demonstration). If a sentence in a skill explains how the call is encoded, it's a copy of
one of those and it will end up verbatim in Slack; cut it.

The trailing line is room-safe by design (per the instructions-leak rule) and closes both
incident failure modes: claiming a listed ability is missing, and shell-working-around an
ability that genuinely isn't.

### Out of this spec: deployment skills

Catalog skills document the *API* (generic: GraphQL grain, id lookups, error shapes).
Workspace conventions ("team key is BEV", "file bugs into Bevyl / Triage Bug Reports") belong
to the *deployment*, at the same registry grain — plausibly a per-registry skill in
policy.yaml, owned by bevelina-deploy. Deliberately decoupled: separate design, separate
change, after this lands.

### SPEC changes

- §11 "Construct turn context:" gains a clause: the context MUST include the turn's exposed
  tools grouped by registry — each registry's skill text (when authored), each exposed tool's
  name and description, and the registry's example calls filtered to the exposed tools.
- §10.1/§10.2 unchanged in semantics; the split tools make "external-mutation tools" concrete
  (`*_write` are exactly the ambient-denied external mutations).
- §18 gains rows: (a) read tools reject write operations at the boundary; (b) write tools are
  always confirmation-gated for non-preauthorized turns; (c) per turn kind, the prompt's
  toolbox and the built toolset agree exactly; (d) a partially granted registry renders only
  its granted tools.

### Tests (TDD order, per §18 rows)

1. Registry derivations — flattened catalog and names match the registry array; no orphans;
   every example's `tool` names a tool in its own registry (catches typos at test time, not
   in production prompts).
2. Grain boundaries — `linear_read` given a mutation fails friendly; `linear_write` given a
   read fails friendly; same for github/notion pairs.
3. Broker — `*_write` classified outward statically; read tools never.
4. Prompt — toolbox renders grouped as specified (skill block when authored, tool lines,
   then examples with args as canonical JSON); absent slot renders nothing; toolbox ≡ built
   toolset per turn kind; a partially granted registry shows only its granted tools and
   only their examples (a read-only grant never renders a mutation example); a registry
   with no exposed tools contributes nothing — skill and examples included.

## Out of scope (tracked separately, both live-deployment issues, not this repo)

- Live `policy.yaml` has `grants: []` — after this lands, grant `linear_read` +
  `linear_write` in `bevelina-deploy` and restart.
- Credential isolation is defeated by the sandbox: `danger-full-access` + a readable
  `~/earshot/.env` means the model can bypass ungranted tools and the confirmation gate with
  curl. Needs its own design (key placement or sandbox policy).
