# tag — instructions for Claude Code sessions

You are implementing `tag`, a homebrew Claude Tag (Slack-resident agent with a durable task
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
4. **No dangling threads** (SPEC §6.1): every task must terminally report. When implementing any
   failure path, ask "what gets posted to the home anchor?" — silence is a spec violation.

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
bun test              # full suite
bun test test/foo.test.ts
bun run typecheck     # tsc --noEmit
```
