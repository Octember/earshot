# Contributing

Small project, strong opinions. The three rules that keep it coherent:

1. **SPEC.md is the contract.** RFC-2119 language, adversarially reviewed. Behavior changes start
   as SPEC changes; if code and SPEC disagree, the SPEC wins. Tests name the SPEC section they
   enforce (see `test/ledger.test.ts` for the style) — a change is done when its §18 rows pass.
2. **Zero-ish dependencies.** Bun built-ins first; justify anything added in the PR description.
   One process, one SQLite file, no external services — if a design needs another service, the
   design is wrong.
3. **Invariants live in the schema.** Push guarantees into unique indexes, CHECKs, and triggers
   rather than application code. The ledger schema is migration-versioned: never edit shipped
   semantics in place — add a migration (see `src/ledger/db.ts`).

Practicalities:

```sh
bun install
bun test              # full suite must be green
bun run typecheck     # tsc --noEmit, zero errors
```

- Ledger state changes go through `transition()` — one transaction writing tasks + audit
  atomically. No scattered UPDATEs.
- Timestamps are ISO-8601 UTC strings injected via a clock parameter — never `Date.now()` inside
  ledger logic (untestable).
- Slack and Codex are faked in tests (`test/fakes/`); the adapter (SPEC §12) and turn runner
  (SPEC §11) contracts are the mock boundaries. Don't add tests that need live credentials.
