# earshot

**[earshot.bot](https://earshot.bot)** — a homebrew [Claude Tag](https://www.anthropic.com/news/introducing-claude-tag): a persistent agent
that lives in Slack channels, takes delegated work by mention, tracks it in a durable task ledger
(decoupled from threads), and reports back — with per-channel identity isolation, memory, budgets,
and an audit trail.

The normative contract is [SPEC.md](SPEC.md). Read it before changing anything; the test suite is
its §18 conformance matrix.

## Hard constraints

- **Runtime: Codex via the [exe.dev](https://exe.dev) gateway — NOT Claude.** Turns run through
  `codex app-server` sessions (same integration pattern as
  [bunion](https://github.com/noahlt/bunion)'s agent runner), so usage bills to the ChatGPT/Codex
  plan rather than metered API tokens. The SPEC's Turn Runner contract (§11) is runtime-agnostic;
  this repo's implementation of it is codex-app-server-only.
- **Mini-SQLite build ethos**: one process, one entrypoint, one `.db` file, zero external
  services. The entire durability layer (ledger, memory, timers, budgets, audit — SPEC §3.2 layer
  5) is a single embedded SQLite database via `bun:sqlite`. No Postgres, no Redis, no queue.
- **The ledger schema is the public contract** (like SQLite's file format): stable, documented,
  migration-versioned. Everything else may churn around it.

## Build order

1. **Ledger + state machine + timers** (`src/ledger/`) — the source of truth, most
   spec-constrained, fully testable without Slack or Codex.
2. **Turn runner** (`src/turns/`) — codex app-server client with the SPEC §11 toolset; test
   against a mocked runtime first.
3. **Router + scheduler** (`src/router/`) — event classification, turn admission, dispatch.
4. **Slack adapter** (`src/adapter/`) — last; SPEC §12 is thin enough to fake in tests until the
   core is proven.

Policy (identities, venue bindings, grants, budgets — SPEC §16) lives in an operator-owned YAML
file, not the database.

## Dev

```sh
bun install
bun test
bun run typecheck
```

## Running it

`earshot` is a supervised daemon: `earshot start` connects to Slack (Socket Mode), drives tasks via Codex,
and survives restarts (restart recovery on boot). See **[DEPLOY.md](DEPLOY.md)** for the full
runbook (Slack app setup, secrets, policy, launchd/systemd units, backup/restore).

```sh
earshot doctor    # check codex login, Slack env vars, policy validity
earshot start     # run the daemon
earshot status    # snapshot: open/running/waiting tasks + spend per identity (--json for machine)
```

Config: `.env` (Slack tokens, gitignored), `policy.yaml` (identities/venues/grants/budgets —
`deploy/policy.example.yaml` is a starting point), `EARSHOT_DB`/`EARSHOT_POLICY`/`EARSHOT_STATUS_PORT` env.

exe.dev is the Codex *auth gateway* the CLI routes through — not a host for earshot. earshot runs wherever
you put it (your Mac, a VM) and drives the already-authenticated `codex` CLI.

## Status

All milestones (M0–M10) are landed — see [ROADMAP.md](ROADMAP.md). The behavioral system (SPEC
§18 conformance) plus a deployable long-running service, verified with a live Slack round-trip and
a live daemon boot.
