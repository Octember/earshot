# earshot — instructions for Claude Code sessions

You are implementing `earshot`, a homebrew Claude Tag (Slack-resident agent with a durable task
ledger). **SPEC.md is the normative contract** — RFC-2119 language, already adversarially
reviewed. When code and SPEC disagree, the SPEC wins; if the SPEC is genuinely wrong or
ambiguous, stop and surface it — do not silently improvise.

## Non-negotiables

1. **The product's agent runtime is Codex via the exe.dev gateway — never the Claude API.**
   You (Sonnet) are the implementer; the thing you are building drives `codex app-server`
   sessions. Do not add `@anthropic-ai/*` deps or Anthropic API calls to product code.
   Reference implementation for the codex app-server client:
   [bunion](https://github.com/noahlt/bunion) (bunion drives codex the same way).
2. **One process, one `bun:sqlite` .db file, zero external services.** No Postgres, Redis,
   queues, or workers. Drizzle is allowed only as the typed query layer over `bun:sqlite`
   (`src/ledger/db.ts`); do not add another database or ORM. If a design needs another
   service, the design is wrong.
3. **The ledger schema (`src/ledger/schema.ts`, drizzle) is pinned.** No migrations: a DDL
   change is stop, `.backup`, hand-alter the live file, bump `SCHEMA_VERSION`, deploy. Push
   row-shape invariants into CHECK constraints; the state machine lives in `transition()`.
4. **No dangling threads, but the harness never speaks** (SPEC §1, §7.2): every task must finish
   with a report on its row. Nothing mechanical is ever posted to Slack: no ledger/scheduler/
   timer-originated posts, no echoed reports, no canned nudges or notices. Everything the room
   hears is the model's own reply/react on its own turn (sole carve-out: the addressed-wake
   failure fallback in SPEC §7.2). When implementing any failure path, ask "what lands in the
   ledger, and what is the model instructed to say?" — never add a harness post.
5. **Slack is the message store; the workspace is the memory.** Never reintroduce a copy of
   messages, a memory table, a ref table, or a second description of the tools. Persist only what
   nothing else can hold.

## Working rules

- **SPEC.md is the contract.** Behavior changes start as SPEC changes.
- Every task state change goes through `transition()`. No scattered UPDATEs.
- Before calling anything essential, name the second reader or writer that needs it; otherwise
  delete it or derive it. Justify a cut by the second shape that disappeared, not by line count.
- Keep dependencies near zero. Bun built-ins first; justify anything added in the commit message.
- Timestamps: ISO-8601 UTC strings everywhere, from `now()` in `src/ledger/clock.ts`.

## Commands

Every commit, merge, and deploy runs as one `&&` chain gated on `bun run check`.

```sh
bun run check         # typecheck + lint + fmt:check (run before committing)
bun run typecheck     # tsgo --noEmit (typescript-go)
bun run lint          # oxlint
bun run fmt           # oxfmt (write)
bun run fmt:check     # oxfmt --check
```
