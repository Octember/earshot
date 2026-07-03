# Roadmap

Milestones are session-sized. Each lists its SPEC anchors and a done-when. Update Status as you
land work; keep this file truthful — it is the handoff between sessions.

**Status: M0 done (schema v1 + smoke tests). Next: M1.**

## M0 — Ledger schema ✅

Schema v1, WAL, dedup index, one-live-execution index, append-only audit triggers, smoke tests.

## M1 — Task state machine (SPEC §6.1, §6.4)

- [ ] `src/ledger/tasks.ts`: `createTask`, `transition(taskId, to, cause)` — single choke point,
      transaction per transition, audit row per transition, illegal transitions throw.
- [ ] Steering: append + consume-at-turn-boundary; `task_steer`/`task_confirm`/`task_cancel`/
      pause/resume semantics (§6.4), steer-on-terminal returns the visible-reply signal (§6.1).
- [ ] `pending_confirmation` lifecycle: request → resolve via confirm → expire with consuming
      execution (§10.2).
- [ ] Standing tasks: recurrence re-arm by harness, failure carve-out (§6.5).
- Done when: §18.2 "Ledger" rows all have passing tests, including
  waiting(human)→nudge→parked→revived and cancel-from-every-non-terminal-state.

## M2 — Timers + scheduler skeleton (SPEC §13, §6.2)

- [ ] Durable timers table → firing loop; idempotent handlers; overdue-on-restart fires in
      due-time order.
- [ ] Dispatch: runnable = open ∪ (waiting(timer) ∧ wake_at passed); ordered by `opened_at`;
      per-identity + global concurrency caps; budget headroom check stub.
- [ ] Restart recovery (§14.2): orphaned running executions → interrupted, task → open;
      consecutive-interruption bound.
- Done when: §18.2 "Durability and recovery" rows pass with kill/restart simulated in tests.

## M3 — Policy + budgets (SPEC §16, §10)

- [ ] YAML policy load + startup validation (§16.3); reload keeps last-known-good.
- [ ] Grant allowlists + scope narrowing enforced at the (mocked) tool broker; action-class
      confirmation gate; guest eligibility.
- [ ] Spend metering per turn → identity/global/per-task caps, calendar month in budget.timezone,
      reserve carve-out (§10.3).
- Done when: §18.2 "Safety" rows pass, including the injection-resistance and watchdog tests.

## M4 — Turn runner on codex app-server (SPEC §11)

- [ ] Codex app-server client (steal bunion's pattern); envelope enforcement (time + token);
      per-kind toolsets; posting-scope rule.
- [ ] Ledger/memory/reply tools exposed to the session as client-side tools; effects recorded on
      the turn row.
- [ ] Execution loop (§17.4): steering consumption at turn boundaries, max_turns yield,
      stall timeout kill.
- Done when: a scripted fake app-server passes the turn-contract tests; then one real codex
  smoke run end-to-end against a scratch task.

## M5 — Memory (SPEC §8)

- [ ] memory_write/retract/query tools; correction takes effect within the handling turn;
      inspection returns actual items; identity scoping enforced by query layer.
- [ ] Distillation turn kind on its timer; staleness decay.
- Done when: §18.2 "Isolation and memory" rows pass.

## M6 — Slack adapter + router (SPEC §12, §5, §17.1)

- [ ] Socket-mode ingest → normalized events, dedup keys, thread-participation tracking, bot/self
      filtering (§10.5), unbound-venue notification.
- [ ] Interactive turn admission: per-anchor serialization, batching, ack deadline.
- [ ] Outbound post/react with terminal-report retry.
- Done when: §18.2 "Conversation and turns" rows pass against a fake surface, then the live
  Slack round-trip (§18.2 Real Integration) works in a private test channel.

## M7 — Ambient + polish (SPEC §9, §15)

- [ ] Ambient tick, speak-only toolset, daily cap, dismissal-to-memory.
- [ ] Audit query tool; operator status snapshot (optional).
- Done when: §18.2 "Ambient" rows pass; acceptance scenarios §18.1 walked end-to-end.
