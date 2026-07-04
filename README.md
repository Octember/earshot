# earshot

Earshot puts a persistent agent within earshot of your team — it lives in your Slack channels,
takes delegated work by mention, executes it asynchronously, and reports back, so the channel
manages outcomes instead of babysitting an agent.

```
you   @earshot scope BEV-4165 and hand it to the factory
bot   on it — scoping first so the handoff has a real brief
      ⚙ reading thread · checking linear ×3
      scoped and delegated: BEV-4165 now has the prior root cause, starting
      files, and acceptance criteria. i'll tail it and only ping you on PR,
      escalation, done, or stuck.
      ⋮
      factory got BEV-4165 to staging with PR #6840 attached.
```

Between mentions it listens, ambiently: it learns what each channel *is* (an alert feed, a bug
intake, a telemetry stream), follows standing instructions ("dedupe alerts against Linear, only
ping me for judgment calls"), distills what it overhears into durable memory, and acknowledges
with an emoji instead of a message when silence is the better contribution.

A homebrew [Claude Tag](https://www.anthropic.com/news/introducing-claude-tag). The load-bearing
idea: **a thread is not a task.** Conversation delegates and steers; the work itself lives in a
durable ledger — a real state machine with timers, restart recovery, budgets, an append-only
audit trail, and a no-dangling-threads guarantee that every task terminally reports, even across
crashes. Safety is harness-enforced, not prompt-enforced: tool grants, confirmation gates for
consequential actions, and spend caps sit outside the model at one choke point.

> [!WARNING]
> Earshot is a single-operator ("homebrew") build for trusted workspaces. Venue membership is the
> ACL; there is no multi-tenant control plane.

## Running earshot

### Requirements

- [Bun](https://bun.sh) — the runtime; storage is a single `bun:sqlite` file, zero external services.
- The Codex CLI, logged in via the [exe.dev](https://exe.dev) gateway (`codex login status`) —
  turns bill to a ChatGPT/Codex plan, not metered API tokens.
- A Slack app in Socket Mode ([DEPLOY.md](DEPLOY.md) has the scopes).

### Option 1. Make your own

The normative contract is [SPEC.md](SPEC.md) — RFC-2119 language, runtime- and platform-agnostic
behind its Turn Runner (§11) and Surface Adapter (§12) contracts. Tell your favorite coding agent:

> Implement earshot according to the following spec:
> https://github.com/Octember/earshot/blob/main/SPEC.md

### Option 2. Use this reference implementation

Bun + TypeScript, Slack over raw Socket Mode, Codex as the agent runtime:

```sh
git clone https://github.com/Octember/earshot && cd earshot
bun install
cp deploy/policy.example.yaml policy.yaml   # identities, venues, grants, budgets
# .env: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_BOT_USER_ID

bun run src/main.ts doctor    # codex login, Slack env, policy validity
bun run src/main.ts start     # run the daemon
```

[DEPLOY.md](DEPLOY.md) is the full runbook — Slack app setup, secrets, policy, launchd/systemd
units, backup and rollback. `policy.yaml` is the operator's contract (identities, standing
channel instructions, tool grants, budgets) and hot-reloads on edit.

## Development

```sh
bun test              # the SPEC §18 conformance matrix
bun run typecheck
```

Tests fake Slack and Codex at the SPEC's contract boundaries; the ledger is fully testable
without either. House rules in [CONTRIBUTING.md](CONTRIBUTING.md); milestones in
[ROADMAP.md](ROADMAP.md); working rules for agent-assisted development in [CLAUDE.md](CLAUDE.md).

---

## License

[MIT](LICENSE)
