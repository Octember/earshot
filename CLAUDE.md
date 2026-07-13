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
   queues, ORMs, or workers. If a design needs another service, the design is wrong.
3. **The ledger schema (`src/ledger/schema.sql`) is the public contract.** Migration-versioned;
   never edit v1 semantics in place once real data exists — add a migration. Push invariants into
   the schema (unique indexes, CHECKs, triggers) rather than application code where possible;
   that pattern is already established.
4. **No dangling threads, but the harness never speaks** (SPEC §6.1): every task must terminally
   report — into the ledger (`terminal_report`, audit). Nothing mechanical is ever posted to
   Slack: no ledger/scheduler/timer-originated posts, no echoed reports, no canned nudges or
   notices. Everything the room hears is the model's own reply/react on its own turn (sole
   carve-out: the addressed-turn failure fallback in §14.2, where the model died before it could
   answer someone who addressed it). When implementing any failure path, ask "what lands in the
   ledger, and what is the model instructed to say?" — never add a harness post.

## Working rules

- Work milestone-by-milestone from `ROADMAP.md`. One milestone per session unless told otherwise;
  check off items and update "Status" there as you land them.
- TDD against the SPEC §18 test matrix: each test names the SPEC section it enforces (see
  `test/ledger.test.ts` for the style). A milestone is done when its §18 rows pass.
- Ledger transitions are transactions (SPEC §6.1 "serialized per task") — every state change goes
  through one transition function that writes tasks + audit atomically. No scattered UPDATEs.
- Slack and Codex are faked in tests until their milestones; the adapter (SPEC §12) and turn
  runner (SPEC §11) contracts are the mock boundaries.
- Keep dependencies near zero. Bun built-ins first; justify anything added in the commit message.
- Timestamps: ISO-8601 UTC strings everywhere, injected via a clock parameter — never
  `Date.now()` inside ledger logic (untestable).

## Commands

```sh
bun run check         # typecheck + lint + full suite (run before committing)
bun test              # full suite
bun test test/foo.test.ts
bun run typecheck     # tsgo --noEmit (typescript-go)
bun run lint          # oxlint
```
