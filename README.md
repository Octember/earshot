# earshot

**[earshot.bot](https://earshot.bot)** · [![ci](https://github.com/Octember/earshot/actions/workflows/ci.yml/badge.svg)](https://github.com/Octember/earshot/actions/workflows/ci.yml) · [MIT](LICENSE)

A Slack-resident agent within earshot: a homebrew
[Claude Tag](https://www.anthropic.com/news/introducing-claude-tag). It sits in your channels,
takes delegated work by mention, tracks it in a durable task ledger (decoupled from threads),
executes asynchronously, and reports back — with per-channel identity isolation, distilled memory,
standing per-channel instructions, spend budgets, and an append-only audit trail.

```
you   @earshot scope BEV-4165 and hand it to the factory
bot   on it — scoping first so the handoff has a real brief
      ⚙ reading thread · checking linear ×3
      scoped and delegated: BEV-4165 now has the prior root cause, starting
      files, and acceptance criteria. i'll tail it and ping you on PR or escalation.
      ...
      factory got BEV-4165 to staging with PR #6840 attached.
```

## What makes it interesting

- **A thread is not a task.** Conversations delegate and steer work; the work itself lives in a
  ledger with a real state machine (open → active → waiting → done/failed/parked), durable timers,
  restart recovery, and a no-dangling-threads guarantee: every task terminally reports, even
  across crashes.
- **Ambient mode.** Opt-in per channel: it passively reads, calibrates to what each channel *is*
  (alert feed, bug intake, telemetry, chat), and speaks only when it has something — hard-capped
  posts per day, emoji reactions as the low-noise acknowledgment. Standing instructions
  ("in #alerts, dedupe against Linear and only ping me for judgment calls") are one line of YAML.
- **Memory that self-corrects.** Observed chatter is distilled into per-identity memory on a
  cadence; corrections retract stale facts. Identities never share memory — venue isolation is
  the ACL.
- **Harness-enforced safety, not prompt-enforced.** Tool grants, scope checks, action-class
  confirmation gates ("writes need a human yes"), spend budgets with a reserve — all enforced
  outside the model at one choke point, and audit-logged.
- **Mini-SQLite build ethos.** One process, one entrypoint, one `bun:sqlite` `.db` file, zero
  external services, near-zero dependencies. The ledger schema is the public contract —
  migration-versioned, invariants pushed into the schema (unique indexes, CHECKs, triggers).

The normative contract is **[SPEC.md](SPEC.md)** — RFC-2119 language; the test suite is its §18
conformance matrix. Read it before changing anything.

## Runtime

Turns run on **Codex via the [exe.dev](https://exe.dev) gateway** through `codex app-server`
sessions (the same integration pattern as [bunion](https://github.com/noahlt/bunion)), so usage
bills to a ChatGPT/Codex plan rather than metered API tokens. The SPEC's Turn Runner contract
(§11) is runtime-agnostic; this repo's implementation of it is codex-app-server-only. exe.dev is
the *auth gateway* the CLI routes through — not a host: earshot runs wherever you put it (a Mac, a
VM) and drives the already-authenticated `codex` CLI.

## Quickstart

Requirements: [Bun](https://bun.sh), the Codex CLI (logged in — `codex login status`), and a
Slack app in Socket Mode.

```sh
git clone https://github.com/Octember/earshot && cd earshot
bun install
cp deploy/policy.example.yaml policy.yaml   # identities, venues, grants, budgets
# .env: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_BOT_USER_ID

bun run src/main.ts doctor    # check codex login, Slack env vars, policy validity
bun run src/main.ts start     # run the daemon
bun run src/main.ts status    # open/running/waiting tasks + spend per identity (--json)
```

**[DEPLOY.md](DEPLOY.md)** is the full runbook: Slack app scopes, secrets, policy, launchd/systemd
units, backup/restore, rollback. Config lives in `.env` (secrets, gitignored) and `policy.yaml`
(operator-owned, hot-reloaded on edit); `EARSHOT_DB` / `EARSHOT_POLICY` / `EARSHOT_STATUS_PORT`
override paths.

## Dev

```sh
bun test              # full suite — the SPEC §18 conformance matrix
bun run typecheck
```

The build layers, inside out: `src/ledger/` (state machine, timers, memory, audit — the source of
truth, fully testable without Slack or Codex), `src/turn-runner/` (codex app-server client + the
§11 toolset), `src/policy/` (grants, budgets, the tool broker), `src/adapter/` (Slack via raw
Socket Mode — no SDK), `src/service.ts` (the supervisor that drives it all). Slack and Codex are
faked in tests; the adapter (§12) and turn runner (§11) contracts are the mock boundaries.

[ROADMAP.md](ROADMAP.md) tracks milestones (M0–M10 landed). [CLAUDE.md](CLAUDE.md) carries the
working rules for agent-assisted development on this codebase.

## License

[MIT](LICENSE)
