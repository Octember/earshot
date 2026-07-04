# earshot

A persistent agent that sits in your Slack channels and mostly stays quiet. Mention it and it
takes real work: scoping, filing, delegating, tailing. Between mentions it listens, and when the
prod alert fires at 2am it has already read the thread, checked the tracker, and decided whether
you need to be woken up.

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

Three things it takes seriously:

**Every task reports back.** A thread is not a task: conversation delegates and steers, but the
work lives in a durable ledger with a real state machine, timers, and restart recovery. Kill the
process mid-task and the task survives, resumes, and still tells the channel how it ended. "No
dangling threads" is an invariant, not an aspiration.

**Silence is a feature.** It learns what each channel *is* (alert feed, bug intake, telemetry
stream) and calibrates. Standing rules are one line of YAML: "dedupe alerts against Linear, only
ping me for judgment calls." Unprompted posts are hard-capped per day, an emoji reaction is the
preferred acknowledgment, and most ambient checks correctly end in nothing at all.

**The model doesn't hold the keys.** Tool grants, confirmation gates on consequential actions,
spend budgets with a reserve, an append-only audit log. All of it enforced by the harness at one
choke point. Prompts shape behavior; they don't guard it.

The whole thing is one process, one `bun:sqlite` file, and near-zero dependencies. You can read
it in an afternoon. A homebrew
[Claude Tag](https://www.anthropic.com/news/introducing-claude-tag).

> [!WARNING]
> Earshot is a single-operator build for trusted workspaces. Venue membership is the ACL; there
> is no multi-tenant control plane.

## Run it

You need [Bun](https://bun.sh), a Slack app in Socket Mode, and the Codex CLI logged in via
[exe.dev](https://exe.dev), so turns bill to a ChatGPT plan instead of metered API tokens.

```sh
git clone https://github.com/Octember/earshot && cd earshot
bun install
cp deploy/policy.example.yaml policy.yaml   # identities, channels, grants, budgets
# .env: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_BOT_USER_ID

bun run src/main.ts doctor
bun run src/main.ts start
```

[DEPLOY.md](DEPLOY.md) is the full runbook. `policy.yaml` is the operator's contract and
hot-reloads on edit.

## Or build your own

The behavior is fully specified in [SPEC.md](SPEC.md): RFC-2119 language, agnostic to runtime and
chat platform. This repo is one reference implementation of it. Point your coding agent at the
spec and make another:

> Implement earshot according to the following spec:
> https://github.com/Octember/earshot/blob/main/SPEC.md

## Development

```sh
bun test              # the SPEC §18 conformance matrix
bun run typecheck
```

Slack and Codex are faked at the SPEC's contract boundaries; the ledger tests without either.
House rules in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
