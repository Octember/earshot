# earshot

A persistent agent within earshot of your team. It lives in your Slack channels, takes delegated
work by mention, executes it asynchronously, and reports back — so the channel manages outcomes
instead of babysitting an agent.

```
you   @earshot that parentNode crash is back — scope it and hand it off
bot   on it — scoping first so the handoff has a real brief
      ⚙ reading thread · checking linear ×3
      scoped and delegated: ENG-165 now carries the prior root cause,
      starting files, and acceptance criteria. i'll tail it and only ping
      you on PR, escalation, done, or stuck.
      ⋮
      ENG-165 hit staging with PR #840 attached.
```

Between mentions it listens: learns what each channel *is* (alert feed, bug intake, telemetry),
follows standing instructions ("dedupe alerts against Linear, only ping me for judgment calls"),
distills what it overhears into memory, and reacts with an emoji when silence beats a message.

The load-bearing idea — **a thread is not a task**. Conversation delegates and steers; work lives
in a durable ledger with a real state machine, timers, restart recovery, and a guarantee that
every task terminally reports. Safety is harness-enforced, not prompt-enforced: tool grants,
confirmation gates, and spend caps sit outside the model. One process, one SQLite file, zero
external services. A homebrew [Claude Tag](https://www.anthropic.com/news/introducing-claude-tag).

> [!WARNING]
> Earshot is a single-operator ("homebrew") build for trusted workspaces. Venue membership is the
> ACL; there is no multi-tenant control plane.

## Running earshot

Requirements: [Bun](https://bun.sh) · the Codex CLI logged in via [exe.dev](https://exe.dev)
(turns bill to a ChatGPT/Codex plan, not API tokens) · a Slack app in Socket Mode.

### Option 1. Make your own

The contract is [SPEC.md](SPEC.md) — RFC-2119, runtime- and platform-agnostic. Tell your favorite
coding agent:

> Implement earshot according to the following spec:
> https://github.com/Octember/earshot/blob/main/SPEC.md

### Option 2. Use this reference implementation

```sh
git clone https://github.com/Octember/earshot && cd earshot
bun install
cp deploy/policy.example.yaml policy.yaml   # identities, channels, grants, budgets
# .env: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_BOT_USER_ID

bun run src/main.ts doctor
bun run src/main.ts start
```

Full runbook in [DEPLOY.md](DEPLOY.md). `policy.yaml` is the operator's contract — identities,
standing channel instructions, tool grants, budgets — and hot-reloads on edit.

## Development

```sh
bun test              # the SPEC §18 conformance matrix
bun run typecheck
```

Slack and Codex are faked at the SPEC's contract boundaries; the ledger tests without either.
House rules: [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

[MIT](LICENSE)
