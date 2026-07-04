# earshot

A homebrew [Claude Tag](https://www.anthropic.com/news/introducing-claude-tag).

> Bro is literally rebuilding OpenClaw for no reason

It sits in your Slack channels and mostly stays quiet. Mention it and it takes real work:
scoping, filing, delegating, tailing. Between mentions it listens, and when the prod alert fires
at 2am it has already read the thread, checked the tracker, and decided whether to wake you.

```
you   @earshot that parentNode crash is back, scope it and hand it off
bot   on it, scoping first so the handoff has a real brief
      ⚙ reading thread · checking linear ×3
      scoped and delegated: ENG-165 now carries the prior root cause,
      starting files, and acceptance criteria. i'll tail it and only ping
      you on PR, escalation, done, or stuck.
      ⋮
      ENG-165 hit staging with PR #840 attached.
```

**Every task reports back.** A thread is not a task: work lives in a durable ledger with a state
machine, timers, and restart recovery. Kill the process mid-task and it still tells the channel
how it ended.

**Silence is a feature.** It learns what each channel *is* and calibrates; standing rules are one
line of YAML. Posts are hard-capped per day, and an emoji is the preferred acknowledgment.

**The model doesn't hold the keys.** Grants, confirmation gates, spend budgets, append-only
audit, all enforced by the harness. Prompts shape behavior; they don't guard it.

One process, one `bun:sqlite` file, near-zero dependencies. Readable in an afternoon.

> [!WARNING]
> Single-operator build for trusted workspaces. Venue membership is the ACL.

## Run it

[Bun](https://bun.sh) + a Slack app in Socket Mode + the Codex CLI logged in via
[exe.dev](https://exe.dev) (bills to a ChatGPT plan, not API tokens).

```sh
git clone https://github.com/Octember/earshot && cd earshot
bun install
cp deploy/policy.example.yaml policy.yaml
# .env: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_BOT_USER_ID

bun run src/main.ts doctor
bun run src/main.ts start
```

Runbook: [DEPLOY.md](DEPLOY.md). Or build your own from the spec: the behavior is fully defined
in [SPEC.md](SPEC.md) (RFC-2119, runtime- and platform-agnostic); `bun test` is its conformance
matrix.

## License

[MIT](LICENSE)
