# earshot

The code is the spec; `src/scheduler.ts` reads top to bottom as what the process does.

- Codex via the exe.dev gateway, never the Claude API.
- One process, one SQLite file, no other services. Drizzle is the query layer; schema changes are `bunx drizzle-kit generate`, never hand-written SQL.
- The harness never posts to Slack. The room hears only the model's own replies and reactions.
- Slack is the message store, the workspace is the memory. The ledger holds only what nothing else can: tasks, pending conversations, muted threads.
- Every task state change goes through `transition()`.
- Before keeping anything, name its second reader or writer; otherwise delete or derive it.

Every commit, merge, and deploy is one `&&` chain gated on `bun run check`.
