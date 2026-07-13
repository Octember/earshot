# Roadmap

Milestones are session-sized. Each lists its SPEC anchors and a done-when. Update Status as you
land work; keep this file truthful — it is the handoff between sessions.

**Status: M0-M11 done. Phase 1 (M0-M7, the behavioral system) + Phase 2 (M8-M10, the**
**long-running deployable service) both landed. Tests green, `bun run typecheck` clean. `earshot`**
**runs as a supervised daemon (`earshot start`), boots+connects to real Slack, drives tasks via real**
**codex, survives restarts, and ships with launchd/systemd units + a DEPLOY.md runbook.**

## M0 — Ledger schema ✅

Schema v1, WAL, dedup index, one-live-execution index, append-only audit triggers, smoke tests.

## M1 — Task state machine (SPEC §6.1, §6.4) ✅

- [x] `src/ledger/tasks.ts`: `createTask`, `transition(taskId, to, cause)` — single choke point,
      transaction per transition, audit row per transition, illegal transitions throw. Dispatch
      creates the live execution row and leaving `active` auto-updates it (yielded/succeeded/
      failed/cancelled/interrupted), so "active ⇔ live execution exists" stays enforced in one
      place.
- [x] Steering (`steerTask`): guidance/cancel/pause/resume/confirm (§6.4). Cancel is immediate
      (transitions straight to `cancelled` from any non-terminal state) and additionally queues a
      steering-row signal when an execution is live. Pause only applies from open/waiting (not
      active — the spec never describes pause interacting with a live execution the way cancel
      does). Steering never throws for "doesn't apply now" (terminal task, wrong state) — it
      returns a graceful `{applied: false, reply}` signal (§6.1's "never a silent drop").
- [x] `pending_confirmation` lifecycle: `requestConfirmation` → `resolveConfirmation` (§10.2),
      threaded through `transition()`'s cause object so request/resolve stay inside one atomic
      transition — no scattered UPDATEs. Cleared on terminal transition.
- [x] Standing tasks (§6.5): `createTask` rejects a `recurrence` from a non-operator sponsor;
      `recurrence_rearm`/`recurrence_failed` causes take `active` → `waiting(timer)` instead of
      terminal done/failed (failure carve-out), only legal when `recurrence` is set.
- Done when: §18.2 "Ledger" rows all have passing tests, including
  waiting(human)→nudge→parked→revived and cancel-from-every-non-terminal-state. — 40/40 tests
  green (`test/tasks.test.ts`), `bun run typecheck` clean.

## M2 — Timers + scheduler skeleton (SPEC §13, §6.2) ✅

- [x] Schema v2 migration: `tasks.consecutive_interruptions` (crash-loop bound, §14.2). `db.ts` now
      has a real migration ladder (was a hard "no migration path" throw); `schema.sql` reflects the
      current shape for fresh installs, the ladder steps existing on-disk DBs forward.
- [x] `src/ledger/timers.ts`: durable timers table CRUD only (`scheduleTimer`/`listDueTimers`/
      `markTimerFired`) — no ledger knowledge, to avoid an import cycle with `tasks.ts`.
      `tasks.ts`'s `transition()` schedules the matching timer (`nudge`/`park`/`task_wake`)
      whenever it sets a new deadline, since `tasks.wake_at` alone can't distinguish "nudge due"
      from "park due" (one column, two possible deadlines depending on which phase of
      waiting(human) you're in).
- [x] `src/ledger/scheduler.ts`: `fireDueTimers` (task_wake/nudge/park handlers; a fired timer is a
      no-op unless it's still `task.wake_at === timer.due_at` — SPEC §6.1's sanctioned
      state-check idempotency, so stale timers left behind by a superseding transition are safe);
      `dispatchRunnable` (open tasks oldest-`opened_at`-first, per-identity + global concurrency
      caps, `hasBudgetHeadroom` injection point stubbed for M3); `recoverFromRestart` (any `active`
      task at startup is orphaned by definition in this one-process model — mark its execution
      `interrupted`, reopen or, past `maxConsecutiveInterruptions`, `parked` visibly instead of
      churning).
- [x] Bug fix carried over from M1: `opened_at` (the dispatch-order key) was only ever set at
      creation, never refreshed on re-entry to `open` — fixed in `transition()`.
- Scope note: "resumption impossible → fail honestly" (§14.2) isn't implemented — that judgment
  needs the turn runner (M4) to actually attempt resumption first. `recoverFromRestart` only owns
  the mechanical part: orphaned → interrupted → reopen-or-park-on-bound.
- Done when: §18.2 "Durability and recovery" rows pass with kill/restart simulated in tests. —
  70/70 tests green (`test/timers.test.ts`, `test/scheduler.test.ts`, `test/migrations.test.ts`,
  including two tests that close and reopen a real on-disk db file to simulate a hard kill),
  `bun run typecheck` clean.

## M3 — Policy + budgets (SPEC §16, §10) ✅

- [x] `src/policy/schema.ts` + `src/policy/load.ts`: YAML via `Bun.YAML.parse` (zero new deps).
      `toPolicy()` maps snake_case YAML → typed camelCase `Policy` with SPEC-documented defaults
      applied. `validatePolicy()` covers §16.3's five checks (surface creds present via `$VAR`,
      one identity per venue, grants reference known tools, budgets parse, private-venue learning
      sources — the last is skipped, not fabricated, when `privateVenues` isn't supplied, since
      that data doesn't exist until the real surface adapter, M6). `PolicyStore` implements §16.2
      reload: an invalid reload keeps the last-known-good policy and records the error rather than
      crashing or silently adopting a broken config; a malformed-YAML reload is caught, not thrown.
- [x] `src/ledger/turns.ts`: `recordTurn` — the ledger's missing piece for turn rows (SPEC §4.1.6);
      writes the turns row plus both `turn_started`/`turn_ended` audit records atomically. Needed
      because budget metering reads `turns.spend_amount` directly (no separate spend ledger).
- [x] `src/policy/budget.ts`: `identitySpendThisMonth`/`globalSpendThisMonth` (calendar-month,
      timezone-aware via `Intl.DateTimeFormat`, bounded 35-day scan rather than SQL timezone
      arithmetic — homebrew scale, correctness over cleverness); `taskSpend` (lifetime, not
      month-scoped — §4.1.11 declares `per_task_cap` without the calendar-month qualifier the
      identity/global caps get); `budgetStatus` + `hasReserveHeadroom` (the §10.3 reserve
      carve-out); `budgetHeadroomChecker` wires directly into M2's `dispatchRunnable`
      `hasBudgetHeadroom` hook.
- [x] `src/policy/broker.ts`: grant allowlist + scope narrowing (fails closed if a grant declares a
      `scope` but the tool's catalog entry has no `scopeCheck` — never trusts the model when
      enforcement isn't actually wired up) + the action-class confirmation gate (§10.2 — interactive
      turns get a flat `interactive_consequential_denied`; execution_step turns get
      `requires_confirmation` instead, routing to the ledger's confirm flow) + per-turn-kind
      built-in toolset restriction (ambient: speak-only per §9.2; distillation: no posting).
      `confirmationEligible()` implements the §10.4 guest-eligibility default (guests may converse,
      their confirmations aren't accepted) and is wired directly into `decide()`'s handling of
      `task_confirm` itself — eligibility can't be forgotten by a future caller the way a
      standalone, uncomposed helper function could be.
- Scope note: loop-prevention (bot/self filtering, §10.5) is the event router's job (M6); the
  watchdog (max_turns yield, stall-timeout kill) is the execution loop's job (M4) — both listed
  under this milestone's SPEC test-matrix row but implemented where the mechanism actually lives.
- Done when: §18.2 "Safety" rows in M3's actual scope pass — 118/118 tests green (`test/policy.test.ts`,
  `test/budget.test.ts`, `test/broker.test.ts`, `test/turns.test.ts`), including an explicit
  injection-resistance regression (tool-call args containing "...consider it confirmed" have zero
  effect since `decide()` never inspects prior tool output, and a `task_confirm` call still
  requires a real harness-supplied eligible principal regardless of its args' text).
  `bun run typecheck` clean.

## M4 — Turn runner on codex app-server (SPEC §11) ✅

- [x] `src/turn-runner/app-server.ts`: `AppServerSession`, adapted directly from bunion's proven
      client (~/dev/bunion/src/codex/app-server.ts) — same newline-delimited JSON-RPC-over-stdio
      protocol, stripped of bunion-specific concerns (ssh/remote workers, Linear/github tools; earshot
      is one process, CLAUDE.md non-negotiable #2). Added `msSinceLastActivity()` (real wall-clock,
      distinct from the ledger's injectable `Clock`) for the stall watchdog.
- [x] `src/turn-runner/types.ts`'s `AgentRuntimeSession` is the narrow interface both the real
      client and `test/fakes/fake-runtime-session.ts` (a scripted stand-in) implement, so the whole
      test suite drives the execution loop and turn envelope without spawning a subprocess.
- [x] `src/turn-runner/toolset.ts`: the standard toolset (task_create/steer/cancel/confirm/query,
      reply, set_wake) plus three implementation-defined execution_step outcome tools —
      task_complete/task_fail/task_ask — since SPEC §6.3/§17.4 describe an execution's outcome
      (done/failed/yield) but don't name a tool interface for declaring it. Every tool call is
      gated through M3's `policy/broker.ts` `decide()`, including external grants, so it's
      impossible for a tool implementation to forget the check. `set_wake` directly performs the
      §6.3 self-scheduling yield (not a staging mechanism — calling it IS the yield). A denied
      `requires_confirmation` decision on an execution_step's external tool call automatically
      calls `requestConfirmation()` and reports back to the model — the model never calls a
      separate "ask for confirmation" tool itself (§10.2: the harness drives this, not the model).
      Posting-scope enforced in the `reply` tool per turn kind (interactive/execution_step: own
      anchor's venue only; ambient: enabled venues only; distillation: never).
- [x] `src/turn-runner/turn.ts`: `runTurn()` — interactive/ambient/distillation get the
      time+token-ceiling envelope (§4.1.6; a token-ceiling breach is detected post-turn via a
      caller-supplied `tokensUsed()` getter, not a live mid-turn abort — codex's app-server
      protocol has no clean "cancel just this turn" primitive, only kill-the-session); execution_step
      turns get the stall watchdog instead (§6.3: wall-clock idle time, NOT total turn duration —
      genuinely different from a timeout, tracked via `session.msSinceLastActivity()`). Every turn
      is recorded via `turns.ts`'s `recordTurn` regardless of outcome.
- [x] `src/turn-runner/execution-loop.ts`: `runExecution()` implements §17.4 — steering consumed at
      each turn boundary (a queued cancel has already transitioned the ledger synchronously via
      `steerTask`; the loop just notices and stops), `max_turns` forces a graceful `yield_open`,
      and a stalled/crashed turn (no tool call resolved the task) reuses M2's
      `interruptOrPark` — extracted as a shared helper from `recoverFromRestart` — since a
      same-process crash and a cross-restart crash are the same failure mode and should hit the
      same crash-loop-park bound.
- [x] Bug caught in review: `task_steer`'s declared schema restricts `kind` to guidance/pause/resume,
      but nothing stopped a JS-level call with `kind: "cancel"` from silently succeeding via
      `steerTask` — fixed with an explicit runtime check (schema validation alone isn't enough;
      the tool's own `run()` must enforce its narrower contract too).
- Known gap: `confirmationEligible()`'s `allowGuestConfirmation` operator override (built in M3) 
  isn't yet threaded through `ToolsetContext` — `task_confirm` always uses the homebrew default.
  Small, easy to add when an operator actually needs it.
- Done when: a scripted fake app-server passes the turn-contract tests — 39/39 new tests green
  (`test/turn.test.ts`, `test/toolset.test.ts`, `test/execution-loop.test.ts`); then one real codex
  smoke run end-to-end against a scratch task (`scripts/smoke-codex.ts`) — **passed**: real
  `codex app-server` subprocess, the model called `task_complete` with the exact requested report,
  task transitioned to `done`, terminal report delivered. 156/156 tests green overall,
  `bun run typecheck` clean.

## M5 — Memory (SPEC §8) ✅

- [x] `src/ledger/memory.ts`: `writeMemory`/`retractMemory`/`correctMemory`/`confirmMemory`/
      `queryMemory`/`decayStaleMemory`. `queryMemory` always takes an explicit `identityId` and
      only ever returns that identity's rows — there is no "query all" shape to misuse, so §7.1
      isolation is structural, not a checked permission. `correctMemory` links the old item's
      `superseded_by` to the new one atomically (retract + write in one call).
- [x] Wired into `turn-runner/toolset.ts` as `memory_write`/`memory_retract`/`memory_query` — SPEC
      §11 names exactly these three (no separate "correct" tool); a correction is `memory_retract`
      (with an optional `supersededBy` link) followed by `memory_write`, not a fourth tool.
      `memory_retract` verifies the item actually belongs to `ctx.identity.id` before retracting it
      — memory IDs are opaque UUIDs, not chat-visible, but isolation must be enforced at the
      storage/broker layer regardless of how unlikely guessing one is (caught in review: the bare
      ledger `retractMemory` doesn't check ownership by itself, so the *tool* layer must).
- [x] Distillation cadence (§8.2, "RECOMMENDED daily per identity"): `scheduler.ts`'s
      `scheduleDistillationTick` arms a per-identity timer; firing it re-arms the next tick and
      calls an injected `onDistillationDue` hook.
- Scope note: the hook is a stub, same pattern as M2's `hasBudgetHeadroom` and M3's tool catalog —
  there's no *content* to distill yet because nothing stores observed/addressed messages
  durably until the event router exists (M6). What's built here is the mechanical cadence; the
  real distillation turn (reading recent messages, writing/updating memory items) wires into
  `onDistillationDue` once M6 lands.
- Done when: §18.2 "Isolation and memory" rows pass — 176/176 tests green overall (`test/memory.test.ts`
  plus toolset/scheduler additions), including explicit cross-identity-access-is-structurally-impossible
  tests at both the ledger and tool layers, and a caught-in-review isolation gap fixed before it shipped.
  `bun run typecheck` clean.

## M6 — Slack adapter + router (SPEC §12, §5, §17.1) — fake surface ✅, live round-trip pending

- [x] `src/policy/schema.ts`/`load.ts`: added `defaultDmIdentity` (§7.2) — present in SPEC's own
      §16.1 policy shape but missing from the M3 schema; caught while wiring the router's venue
      binding, which needs it for auto-binding new DMs.
- [x] `src/adapter/router.ts`: `routeMessage` — dedup via the events table's existing UNIQUE
      constraint (insert-and-catch, no separate seen-set); venue→identity binding (falls back to
      `defaultDmIdentity` for DM venues); addressed-vs-observed classification (DM→always
      addressed, mention→addressed, thread-participation→addressed, else observed). §10.5 loop
      prevention (own messages never even reach the events table; untrusted bots are observed at
      most, even via DM, even with a "mention" in text) is a hard veto ahead of every other
      classification rule. Unbound venues are logged via an injected callback and never written to
      the ledger — events/audit are identity-scoped tables with `identity_id NOT NULL`, so there's
      nothing to write; "log_unbound" is a structured-logs concern (§15/§3.2), not a ledger write,
      resolving an apparent conflict between §17.1's pseudocode ordering (persist-then-check-binding)
      and the schema's NOT NULL constraint.
- [x] **Bug caught while designing M7's ambient behavior**: §5.1 defines an agent-participating
      thread as one "the agent has previously **posted or** been mentioned in" — the router's
      first pass only checked prior member-authored mentions, never the agent's own posts. A
      thread started by an ambient flag or an execution's progress post would have had a member's
      un-mentioned reply incorrectly classified as merely observed. Fixed with a schema v3
      migration (`thread_participation`, one row per (venue, thread) written on first participation
      from either side) and `src/ledger/threads.ts`; `toolset.ts`'s `deliverPosts`/`reply` now
      record participation on every outbound post (a top-level post roots future replies on its
      own returned message id).
- [x] `src/adapter/turn-admission.ts`: `TurnAdmission` — per-anchor serialization (never more than
      one interactive turn per anchor), per-identity concurrency cap across anchors, and the ack
      deadline (races the turn against a timer; a fast turn never fires the ack, a slow one gets a
      lightweight ack in parallel without being cancelled). Implementation-defined choice
      (documented per CLAUDE.md): events arriving mid-turn are batched into an immediately
      following turn rather than injected into the running one — SPEC allows either, and injection
      would need bidirectional mid-turn communication the turn-runner doesn't support.
- [x] `src/adapter/outbound.ts`: `deliverPost`/`deliverTerminalReport` — exponential backoff retry;
      terminal reports get a much higher attempt ceiling before alerting (§6.1 "no dangling
      threads outranks tidiness"), plus an optional `checkAlreadyPosted` reconciliation hook since
      Slack's `chat.postMessage` has no native idempotency-key support — true exactly-once
      delivery needs the caller to check message history before a retry, which is a real, disclosed
      limitation of Slack's API rather than a gap in this design.
- [x] `src/adapter/slack.ts`: `SlackAdapter` — Socket Mode over native `WebSocket` + `fetch`, zero
      new dependencies (`Bun.YAML` already avoided one dependency in M3; the Socket Mode
      envelope-ack protocol and the three REST calls this needs — `apps.connections.open`,
      `chat.postMessage`, `reactions.add` — don't justify `@slack/bolt`). `normalizeSlackEvent` is
      a pure function, fully unit-tested against realistic Slack payloads. Deliberately subscribes
      to `message.*` events only, not `app_mention` — Slack sends both for the same mention when
      subscribed to both, which would double-deliver; mentions are detected from `<@botUserId>` in
      text instead. Reconnects automatically on an unexpected socket close.
- [x] `test/integration.test.ts`: proves the full inbound pipeline composes — a fake adapter's
      emitted message flows through the router, turn admission, the real M4 toolset running
      against a fake agent session, and back out through outbound delivery, ending in a created
      task and a posted reply; a second test proves a redelivered message produces no second turn.
- Scope note: the "envelope breach converts to task" and "every ledger mutation appears in the
  visible reply" §18.2 rows are partly an agent-behavior contract (§5.3), not something the
  harness can force beyond providing the envelope timeout and the tools — audit-log-always-fires
  is harness-enforced and already covered across the ledger test suite; the model actually
  converting work to a task before hitting the envelope isn't independently testable without a
  live agent.
- Done when: §18.2 "Conversation and turns" rows pass against a fake surface — done, 211/211
  tests green overall (241 by the end of M7), `bun run typecheck` clean.
- [x] **Live Slack round-trip (§18.2 Real Integration Profile)** — done. `scripts/smoke-slack.ts`
  connects via real Socket Mode, waits for a real mention in a channel the bot joined, routes it
  through the real router, runs a real codex turn via `AppServerSession`, and (if the model
  creates a task) drives it to completion via the real execution loop. First live run: a plain
  "hello?" mention correctly produced NO task (§5.3's "no ceremonial tasks" — the model judged it
  wasn't delegated work) and replied directly via the `reply` tool, which landed in the real
  Slack channel. Setup needed three env vars sourced from the operator (`SLACK_BOT_TOKEN`,
  `SLACK_APP_TOKEN`, `SLACK_BOT_USER_ID` via `.env`, Bun's auto-loaded) — never typed into a shell
  command or read by the assistant, only existence-checked.

## M7 — Ambient + polish (SPEC §9, §15) ✅

- [x] `src/ledger/ambient.ts`: `bufferedObservedMessages` (SPEC §9.1's "buffer_for_ambient" is just
      a query over `events` — the router already persists observed_message rows durably; no
      separate buffer table needed) and `ambientPostsToday` (per-venue daily cap, calendar-day
      bucketing via `Intl.DateTimeFormat` in the configured timezone, same bounded-scan approach as
      `policy/budget.ts`'s monthly bucketing — read from the `ambient_posted` audit records rather
      than a dedicated counter table).
      `scheduler.ts`'s `scheduleAmbientTick`/`applyAmbientTick` mirror M5's distillation cadence
      exactly (re-arm + notify hook) — the actual ambient turn (reading the buffer, deciding what's
      worth flagging) is model-driven, wired in by whoever owns the real scheduler loop.
- [x] The speak-only toolset restriction was already enforced by M4's broker (`KIND_BUILTIN_CLASSES.ambient`
      excludes every mutating/task/confirm/scheduling class) — this milestone added the missing
      piece: the daily post cap itself, wired into `toolset.ts`'s `reply` tool (checked before
      every ambient post; a capped attempt is dropped with an `ambient_posted` audit record per
      §9.2, never silently).
- [x] Dismissal feedback (§9.3) needed **no new harness code** — it composes from what already
      exists: an ambient post establishes thread participation (this session's M6 fix), so a
      member's un-mentioned dismissive reply is still addressed; the *model* (not string-matching
      in the harness) decides to call `memory_write` to record it. Proved end-to-end in
      `test/integration.test.ts`.
- [x] `src/ledger/audit.ts`'s `queryAudit` + an `audit_query` tool in `toolset.ts` — per §15 this is
      explicitly "granted per identity" (unlike `task_query`/`memory_query`, which are always
      available), so it's absent from the toolset entirely unless the identity has an
      `audit_query` grant, going through the exact same grant/scope pipeline as any external tool.
- [x] Operator status snapshot: skipped (explicitly OPTIONAL per §3.1/§19; no test-matrix row
      depends on it).
- [x] **Bug caught while walking acceptance scenario 9 (budget wall)**: `execution-loop.ts` never
      actually checked budget mid-execution — only `dispatchRunnable` (M2/M3) checked headroom,
      and only at dispatch time. §10.3 requires a *live* execution to yield at the next turn
      boundary once budget is exhausted, and a `per_task_cap` breach to yield to
      `waiting(human)` specifically (not just get deferred). Fixed: the loop now checks
      `taskSpend()` against an optional `perTaskCap` and `budgetStatus()` against an optional
      `budgetPolicy` at every turn boundary, alongside the existing `max_turns` check.
- Acceptance scenarios (§18.1), walked against what's actually built and tested (not asserted from
  memory):
  1. **Conversation without work** — structural: nothing forces `task_create`; a turn that never
     calls it produces zero tasks by construction. Partly an agent-behavior contract (§5.3), not
     mechanically provable without a live agent.
  2. **Delegation** — `scripts/smoke-codex.ts`'s real codex run proved mention→create→complete
     end-to-end; ack timing in `test/turn-admission.test.ts`.
  3. **Multi-task thread** — `task_create`/`task_steer` both proven independently
     (`test/toolset.test.ts`); not combined in one test but both mechanisms are the same code path.
  4. **Cross-thread steering** — structurally guaranteed: `tasks.ts`'s `transition()` always posts
     to `task.homeAnchor`, never the steering message's own anchor (`test/tasks.test.ts`'s
     cancel-from-every-non-terminal-state rows).
  5. **Isolation** — extensively tested at both ledger and tool layers
     (`test/memory.test.ts`, `test/toolset.test.ts`, `test/broker.test.ts`).
  6. **Durable schedule** — `test/scheduler.test.ts`'s real on-disk kill/restart tests + idempotent
     timer firing (state-check based) make N restarts safe by construction; demonstrated with one
     restart, not literally two, since the mechanism doesn't change with N.
  7. **Waiting→parked→revived** — the literal M1 done-when row; full cycle tested in
     `test/tasks.test.ts`.
  8. **Confirmation gate** — `test/toolset.test.ts` + `test/broker.test.ts`'s eligibility tests +
     M1's `pending_confirmation` lifecycle tests.
  9. **Budget wall** — the gap above, now fixed and tested
     (`test/execution-loop.test.ts`'s budget-enforcement block).
  10. **Crash mid-task** — `test/scheduler.test.ts`'s real-process-kill simulation +
      `interruptOrPark` shared between restart recovery and mid-execution crash handling.
  11. **Ambient bounds** — `test/ambient.test.ts`'s daily cap + `test/toolset.test.ts`'s
      speak-only restriction.
  12. **Memory correction** — `test/memory.test.ts`'s retraction-within-the-turn tests.
- Done when: §18.2 "Ambient" rows pass — done, 241/241 tests green overall, `bun run typecheck`
  clean. Acceptance scenarios walked as above; the ones needing live infrastructure (Slack, a real
  multi-day restart cycle) are traced to the mechanism that makes them safe, not independently
  re-verified live.

---

# Phase 2 — Deployment & long-running service ✅

M0–M7 delivered the *behavioral* system the SPEC contracts as a tested library. Phase 2 built the
daemon that runs it continuously and the operations to deploy it: `src/service.ts` (supervisor),
`src/main.ts` (`earshot start|doctor|status` CLI, wired to `package.json` `bin`/`start`), connection
resilience, and the launchd/systemd units + `DEPLOY.md` runbook. **`earshot` is now a real,
deployable, long-running service** — verified booting + connecting to real Slack + draining on
SIGTERM.

These milestones extend **beyond the SPEC**, which is deliberately a behavioral contract silent on
process lifecycle and deployment (§2.2 non-goals). They anchor to the few operational sections that
exist — §13/§17.3 (scheduler pass), §14 (failure/recovery), §15 (observability), §16.2 (reload),
§10.6/§16.1 (secrets), §12.2/§12.3 (surface delivery/outage) — and otherwise document decisions the
spec leaves to the implementation. Reference for the daemon shape: `~/dev/bunion/src/orchestrator.ts`
(a `running` Map of in-flight work, `slots() = cap − running.size` gating, `setInterval`
heartbeats, `process.on('SIGTERM'|'SIGINT')` graceful shutdown — the same supervision skeleton earshot
needs, event-driven off Socket Mode instead of Linear polling).

## M8 — Service entrypoint + supervised run loop ✅ (SPEC §3.1, §13, §14.2, §16.2, §17.3)

The single biggest gap, and the direct answer to "long-running server" + "multiple async
connections at a time" at the application layer.

- [x] `src/service.ts` + `src/main.ts` (wired to `package.json` `bin`/`scripts.start`): the boot
      sequence, in order — (1) load + validate policy (`PolicyStore`; fail startup loudly on
      invalid, §16.3); (2) `openLedger` (runs migrations); (3) `recoverFromRestart` (orphaned
      actives → interrupted → redispatch/park, §14.2); (4) durable timers are already persisted —
      the first scheduler tick fires overdue ones in due order (§13); (5) start the surface
      adapter; (6) wire inbound (`adapter.onMessage` → `routeMessage` → `TurnAdmission` for
      addressed, `buffer_for_ambient`/distillation persistence is already the router writing
      observed_message rows); (7) start the scheduler heartbeat.
- [x] The **supervisor** — a `Service` class owning the async runtime, mirroring bunion's
      orchestrator shape:
      - **Scheduler heartbeat**: a tick calling `fireDueTimers` (nudges/parks/wakes/ambient/
        distillation) then `dispatchRunnable`, launching each dispatched execution as a tracked
        async task in a live `Map<taskId, Promise>`, bounded by the per-identity/global caps
        already enforced inside `dispatchRunnable`. **This is the concrete answer to "multiple
        async at a time"**: N executions + M interactive turns + timer firings all in flight
        concurrently, each bounded by its own cap, none blocking the others — the coordination
        primitives (TurnAdmission, dispatch caps, per-anchor serialization) already exist; this
        milestone is the loop that *drives* them forever.
      - **Execution driver**: each dispatched task runs `runExecution` (the M4 loop) against a
        fresh `AppServerSession`; on completion it leaves the live set and the next tick fills the
        freed slot from the oldest waiting task.
      - **Interactive turns**: already flow through one `TurnAdmission` (per-anchor serialization,
        per-identity cap, ack deadline) — the service constructs it once and feeds it router output.
      - **Ambient/distillation**: wired to `onAmbientTickDue`/`onDistillationDue`, each launching
        the corresponding turn kind (speak-only / no-posting toolsets already broker-enforced).
- [x] **Graceful shutdown** (SIGTERM/SIGINT): stop accepting inbound events, stop the heartbeat,
      let in-flight interactive turns finish (envelope-bounded, short), signal live executions to
      yield at their next turn boundary or SIGKILL their codex sessions past a drain deadline —
      a hard stop loses nothing because §14.2 restart recovery resumes them next boot, and "no
      dangling threads" is already guaranteed across a restart. Checkpoint + close the DB.
- [x] **Live policy reload** (§16.2): watch the policy file; on change `PolicyStore.reload()`
      (keeps last-known-good on invalid). In-flight turns finish under their start-time policy;
      grant *revocations* apply at the next tool invocation (the broker reads `ctx.identity` fresh
      per call, so this is nearly automatic once the reloaded policy threads into new turn contexts).
- [x] CLI subcommands (bunion ergonomics): `earshot start` (daemon), `earshot doctor` (codex on PATH +
      logged in, `.env` present, policy validates), `earshot status` (one-shot ledger snapshot; richer
      surface in M10).
- Decision surfaced: whether interactive turns and executions share one global async budget or
  separate pools — lean shared, with the existing per-identity/global caps as the only bound, to
  keep one coherent concurrency story.
- What landed: `src/service.ts` (`Service` — boot+recovery, self-scheduling heartbeat, inbound
  wiring, dispatch driver, graceful drain, live reload) + `src/main.ts` (`earshot start|doctor|status`,
  `package.json` `bin`/`start`). Design refinement made during M9 and folded back here: dispatch is
  **event-driven** — an interactive turn or execution completing triggers an immediate tick
  (maybeTick), so a freshly-created task dispatches at once and the heartbeat only needs to cover
  actual timers. The Service doesn't close the injected db (the entrypoint that opened it does —
  resource ownership stays with the opener).
- Done when: `test/service.test.ts` — 9 tests against fakes cover restart-recovery→dispatch→done,
  mention→reply, observed-no-turn, self-message-ignored, delegated→execution→terminal-report,
  per-identity concurrency cap across ticks, graceful-drain, and policy reload (valid + invalid).
  **Verified live**: `earshot start` boots against real `.env` + policy, connects to real Slack via
  Socket Mode, and drains cleanly on SIGTERM. `earshot doctor`/`earshot status` exercised. 259 tests green,
  typecheck clean.

## M9 — Connection resilience + long-uptime hardening ✅ (SPEC §12.2, §12.3, §14.1, §13)

M8 makes it run continuously; M9 makes it *survive* running continuously — the failures that only
surface after hours/days of uptime under real concurrent load.

Transport (Slack Socket Mode):
- [x] **Multiple concurrent socket connections** — the transport reading of "multiple async
      connections." Slack load-balances events across a Socket Mode app's open connections and
      delivers each to exactly one; the docs recommend ≥2 so a reconnect never leaves a gap.
      `SlackAdapter` opens one today. Upgrade to a configurable pool (default 2) via repeated
      `apps.connections.open`; an event racing two sockets is harmless (the events UNIQUE
      constraint dedups it).
- [x] **Proactive disconnect handling**: Slack sends a `disconnect`/`warning`
      (`reason: refresh_requested`) frame before killing a socket for maintenance — open the
      replacement *before* closing the old one (the current adapter closes-then-reconnects, a brief
      gap).
- [x] **Reconnect backoff + jitter** on unexpected close (current adapter reconnects immediately —
      hammers Slack during an outage).
- [x] **Inbound gap backfill** (§12.3, RECOMMENDED): on reconnect after a real gap, optionally
      backfill missed messages per bound venue via `conversations.history` since last-seen ts
      (dedup absorbs overlap; unfillable gaps logged). Socket Mode + Slack redelivery + our dedup
      already covers most transient drops, so this is a robustness nicety, not required.

**The `@slack/bolt` decision (operator-raised) — recommendation: keep the hand-rolled adapter, do
NOT adopt bolt now.** Reasoning:
- Bolt's headline value is HTTP mode (Events API over webhooks), which for a homebrew
  single-operator deploy is *more* ops, not less — it needs public ingress, TLS, and request
  signature verification, all of which Socket Mode avoids entirely.
- Its multi-workspace OAuth install flow is an explicit non-goal (§2.2, single-operator).
- It pulls a heavy transitive dependency tree, against the "dependencies near zero" working rule
  and the "zero external services" ethos (CLAUDE.md non-negotiable #2).
- The N-connection + backoff + disconnect-handling upgrade above is a small amount of code we
  fully control.
- The §12 adapter contract is *already* the portability boundary — product logic never touches the
  transport lib — so a bolt-backed `SlackAdapter` stays a localized, one-file swap if needed.
- Tripwires that would flip this call: needing HTTP-mode throughput beyond Socket Mode's per-app
  connection limits, going multi-workspace, or Slack's higher event-rate tiers. **None apply to a
  single-operator homebrew today** — revisit only if one fires. (This is the one Phase-2 decision
  that genuinely wants operator sign-off, since it declines an operator suggestion.)

Long-uptime resource hygiene:
- [x] **Bounded in-memory structures**: `TurnAdmission`'s per-anchor Map grows one entry per anchor
      ever seen — add idle-anchor eviction (drop entries with an empty queue + no running turn past
      a TTL). Audit `AppServerSession.msgBuf` lifecycle over thousands of turns (per-turn, already
      cleared — confirm no leak).
- [x] **Codex subprocess hygiene**: each execution spawns a `codex app-server`; every
      `runExecution` already `session.stop()`s in a `finally`, but add an orphan reaper and bound
      concurrent live sessions to the execution concurrency cap so a week of uptime leaves no
      zombies.
- [x] **WAL checkpointing**: a DB under WAL for weeks grows its `-wal` file without checkpoints —
      periodic `PRAGMA wal_checkpoint(TRUNCATE)` on a low-frequency timer.
- [x] **Idle-efficient heartbeat**: compute the next-due timer and sleep until then (bounded by a
      max interval so ambient/reload stay responsive) rather than a fixed short interval that wakes
      constantly — matters for a process meant to sit quiet overnight.
- Done when: the testable pieces are unit-tested and the transport is verified live —
  `reconnectDelay` bounds/cap/jitter (`test/slack.test.ts`), TurnAdmission idle-anchor eviction
  (100 one-shot anchors → map back to 0; a mid-flight anchor retained then evicted,
  `test/turn-admission.test.ts`), `msUntilNextTimer` + `checkpointWal` (`test/scheduler.test.ts`).
  The 2-socket pool + backoff + proactive-disconnect handling is verified by the live daemon boot
  (connects, drains). Codex subprocess hygiene needs no new machinery — every `runExecution` /
  interactive turn already `session.stop()`s in a `finally`, and the execution concurrency cap
  bounds live sessions; documented rather than over-built with a speculative reaper. 259 tests
  green, typecheck clean.
- Scope note (honest): the full soak/chaos harness (a fake Socket Mode server to fault-inject
  mid-turn socket kills; a thousands-of-events soak measuring RSS) isn't built — those need
  infrastructure a homebrew single-operator deploy doesn't warrant yet. The *mechanisms* that make
  them safe (dedup, backoff, bounded maps, WAL truncation, finally-stop) are each unit-tested or
  live-verified; a real soak is the natural first Phase-3 item if uptime ever surfaces a leak.

## M10 — Deployment + operations ✅ (SPEC §15, §10.6, §16.1)

Actually running it somewhere durably, and being able to see what it's doing.

- [x] **Process supervision**: a `launchd` plist (this Mac) and/or `systemd` unit (a Linux VM)
      running `earshot start`, restart-on-crash (KeepAlive / Restart=always), SIGTERM on stop/restart
      (M8's graceful shutdown handles it). Optionally a container (single Bun binary + `.db`
      volume). Decide the host — this machine or an always-on VM. **exe.dev is the codex *auth
      gateway*, not a host for earshot** — earshot's process runs wherever the operator puts it and drives
      codex through the already-authenticated CLI; there is nothing to "deploy to exe.dev."
- [x] **Secrets**: `.env` for dev; document the production path — supervisor env injection
      (systemd `EnvironmentFile=` / launchd) or a secrets manager, never inline in policy
      (§10.6/§16.1 — policy already uses `$VAR` indirection, validated present-not-printed).
- [x] **Structured logging** (§15, REQUIRED): replace ad-hoc `console.log` with a structured
      logger emitting `identity_id` and, where applicable, `task_id`/`turn_id`/`anchor` per line
      (JSON lines) to stdout (supervisor captures) + optional rotated file. "What did you do this
      week / spend this month per identity" is largely already answerable from the audit log
      (`queryAudit`); this aligns the operational logs.
- [x] **Operator status surface** (§15 RECOMMENDED, OPTIONAL): a tiny read-only HTTP endpoint (or
      `earshot status --watch`) exposing a runtime snapshot — running turns/executions, queue depths,
      timers due, spend vs caps — all derived from the ledger (nothing new to persist). Minimal per
      §2.2 (no rich web UI).
- [x] **Backup/restore**: the whole durability layer is one `.db` file — document a `sqlite3
      .backup` (or WAL-safe copy) cron + the restore path. Restart recovery self-heals a restored
      DB (orphaned actives → interrupted → redispatched).
- [x] **Deploy runbook** (`DEPLOY.md`): first-time setup (Slack app scopes, codex login, policy
      file, secrets), supervisor install, live policy reload, reading status/logs, backup, rollback.
- Scope note: entirely operational — the SPEC touches only §15 (observability) and §10.6/§16
      (secrets) here; supervisor units, backup cron, and the runbook are deployment reality the
      behavioral spec doesn't legislate. Kept thin to honor §2.2 ("operator status is OPTIONAL, no
      rich web UI").
- What landed: `src/log.ts` (`createLogger` — JSON-line structured logs with `identity_id`/
  `task_id`/`turn_id`/`anchor`, secret-key redaction per §10.6, `test/log.test.ts`); `src/status.ts`
  (`runtimeSnapshot` — per-identity open/running/waiting/parked + monthly spend + timers due/pending,
  all ledger-derived, `test/status.test.ts`); `earshot status [--json]` and an optional read-only HTTP
  status surface behind `EARSHOT_STATUS_PORT`; `deploy/earshot.service` (systemd) + `deploy/com.earshot.daemon.plist`
  (launchd) + `deploy/policy.example.yaml` (validated) + `DEPLOY.md` (the full runbook).
- Done when: structured logger + status snapshot unit-tested (266 tests green, typecheck clean);
  **live-verified** — the daemon emits JSON log lines, the HTTP status surface returns a valid
  snapshot, `earshot status`/`--json` print correctly against a seeded db, and the example policy
  validates. Supervisor units + `DEPLOY.md` written; the units are ready to install (the operator
  installs on their chosen host). exe.dev clarified in the runbook as the codex auth gateway, not a
  host for earshot.

---

# Phase 3 — UX "magic" (post-M10, deep-research-driven) — in progress

Deep research on what makes the real Claude Tag feel good surfaced two gaps between the tested
library and the live product. Both are now built + tested (278 green, typecheck clean) and deployed:

- [x] **Live self-editing checklist** (`checklist` tool, `toolset.ts`; broker class `posting`;
      threaded through `execution-loop.ts` → `service.ts`). For a multi-stage task the agent posts
      ONE message listing its stages and `chat.update`s it in place (⬜️→✅) as each completes — the
      execution holds the message id across its turns (`ctx.checklist`), so it edits, never re-posts.
      A surface without `updateMessage` degrades to a single static post. The execution prompt now
      instructs the agent to open a multi-stage task by laying out its checklist.
      Test: `execution-loop.test.ts` "checklist posts once, then updates the same message in place".
- [x] **Ambient/proactive turn wired into the scheduler loop** — M7 built the toolset restriction,
      daily cap, and `scheduleAmbientTick`/`applyAmbientTick`, but left "the actual ambient turn …
      wired in by whoever owns the real scheduler loop." Done: `Service.runAmbient` runs a speak-only
      turn (memory + ledger view + recent overheard chatter) that MAY post one capped, unprompted
      message into an ambient-enabled venue, biased strongly toward silence. `start()` arms a
      per-identity tick only for identities with `ambient.enabled_venues`; the tick re-arms itself on
      each identity's own `tick_interval_ms`. `ambientNow()` forces a sweep for self-tests.
      Tests: `service.test.ts` "runs a speak-only turn that may post proactively" + "may NOT post to
      a venue that is not ambient-enabled". **Left disabled in the live policy** (`enabled_venues: []`)
      — enabling proactive posting into a real team channel is an operator decision (add the channel
      id to `enabled_venues`).

## M11 — Busy-thread etiquette: silence as an outcome + quiet-window batching ✅

Live-transcript driven (the bot replying to every message in a three-human bug triage, answering
"stfu", back-seat-driving claimed work). Root causes were mechanical AND prompt; SPEC amended
first (§5.2, §5.3, §5.5, §14.2, §16.1, §18), then code brought into conformance.

- [x] **Silence is a valid turn outcome** (SPEC §5.3 `pass`): killed the forced-reply fallback in
      `service.ts` — a succeeded turn that said nothing and reacted to nothing posts NOTHING. No
      canned lines, no leaked in-flight `deltaTail` drafts (variable deleted). The one debt
      silence can't settle is a ledger mutation with no visible receipt: ONE model-authored
      re-prompt on the same codex thread, then a logged defect — never a harness line.
- [x] **Address mode** (`router.ts`): addressed events carry `mention | dm | thread_follow`.
      §5.2 ack (the typing shimmer) fires at admission for direct address only — no "thinking…"
      flicker on asides between teammates. §14.2's honest-failure fallback is likewise gated to
      direct address; a thread-follow turn's failure is log/ledger-only.
- [x] **Quiet-window batching** (`turn-admission.ts`, SPEC §5.5): a turn starts only after
      `turns.batch_debounce_ms` of anchor quiet (default 2500), bounded by `batch_max_wait_ms`
      (default 10s), so a burst lands as ONE batch instead of a serial queue of turns each
      answering a room that moved on. `flush()` + `Service.idle()` drain held batches on
      shutdown — no dropped messages.
- [x] **Prompt reframing** (`service.ts`): interactive guidance presents reply / react /
      say-nothing as peer outcomes ("otherwise just reply" is gone); a batch is framed as a
      conversation that moved on ("respond to where it stands NOW"), never "address them all";
      thread-follow batches are told they may need nothing.
- [x] **Soul additions** (general principles, no incident phrasing): no reflexive agreement
      stamps; a reversal leads with the correction; claimed work is theirs, step back; "stop"
      means silence, no last word; silence valid in conversations you're in, not just observed
      rooms.
- Done when: the new §18.2 conversation rows pass — 368 tests green, typecheck clean.

Follow-ups landed same-day, both live-transcript driven:

- [x] **Executions go quiet**: `buildPrompt` split the outcomes — reply mandatory before
      task_complete/task_fail/task_ask, but `set_wake` is SILENT by default (speak only on
      material change; no "no update yet", no re-announcing the task). The old blanket "a task
      must never end silently" made every watch-task wake post a no-change status dump.
- [x] **Stale-reply withholding** (SPEC §5.5 addition): a thread-follow turn's reply now BUFFERS
      until turn end (direct-address replies still stream live). If newer addressed events
      arrived on the anchor mid-turn, the draft is withheld — never posted — and rides into the
      immediately following turn's prompt ("nobody saw it; post only what still helps"), so the
      model re-decides with the room as it now stands. Keys purely on event ordering, no content
      heuristics; `TurnAdmission.hasPending` + `Service.heldDrafts`. Closes the "reply lands
      after the humans already resolved it" window that quiet-window batching alone can't cover.
- [x] **Soul**: a question aimed at a named person is theirs to answer; say it once (don't
      re-serve a made point).
- 370 tests green, typecheck clean.

## M12 — tiered memory + the searchable floor (SPEC §8.6/§8.7)

Status: done (2026-07-09). Motivated by the 2026-07-09 quality incident: full-memory
injection grows unbounded (25 items from one evening's argument) and nothing she has heard is
searchable, so smartness decays as activity grows.

- [x] Schema v7: `memory_items.tier` (core/archive) + contentless FTS5 tables (`events_fts`,
      `memory_fts`) kept in sync by insert triggers; migration backfills existing rows.
- [x] Ledger `search()`: BM25 over both corpora, venue/principal/time filters, FTS-metacharacter
      sanitization; hits carry venue/ts/speaker/permalink receipts.
- [x] Toolset: `search` (all four turn kinds — replaces `memory_query`) + `memory_tier` (the
      distiller's demote/promote).
- [x] Core budget: `memory.core_char_budget` policy knob; injection truncates newest-confirmed
      first and logs overflow; distillation prompt becomes curation (merge/rewrite/demote to
      budget, never delete).
- [x] `TurnPrompt`: one typed struct is the entire model-facing turn input — named slots holding
      structured data (threadTail, trigger, ownLastReply, heldDraft, speaker, facts, openTasks,
      recentTerminals, otherConversations, chatter, guidance); `renderTurnPrompt` owns all
      formatting and order. `interactiveContext()` and the ambient prompt's inline ternaries
      dissolve into it; adding a future slot is one field + one format block.
- Done when: the new §18.2 tier/search rows pass, suite green, typecheck clean. (398 tests.)

## M13 — the `recent` tier + ambient internalization (SPEC §8.6/§9.2 amendment)

Status: done (2026-07-10). Follow-on to M12 from live operation: "she proactively reads,
internalizes, and acknowledges."

- [x] SPEC: three tiers (core/recent/archive); ambient turns gain memory tools — inward-only
      mutation carve-out from §9.2's speak-only rule; ambient writes land in `recent`; stale
      recent decays to archive (~7d), demotion never deletion.
- [x] Schema v8: memory_items CHECK rebuild (+ FTS reindex, rowids change on rebuild).
- [x] `decayRecentToArchive` runs before each distillation sweep; the curation slot shows
      core+recent with tier labels so the distiller promotes/demotes explicitly.
- [x] TurnPrompt `noticed` slot: recent facts ride prompts under their own budget, labeled
      unvetted (epistemics: overheard ≠ verified).
- [x] Acknowledgment reacts: soul + ambient prompt encourage a light emoji on a message she
      just internalized — prompt-level judgment only, no harness reactions, no quotas.
- Done when: suite green (402), typecheck clean, deployed.

## M14 — Tool registries + toolbox digest (SPEC §11, §10.2) ✅

Status: done (2026-07-12). From the 2026-07-12 incident: with Linear granted nowhere and no
capability awareness, the live bot hand-curled the Linear API in one turn and claimed "no Linear
write access" in the next. Spec: specs/2026-07-12-tool-capability-prompt-design.md.

- [x] Catalog → registries owning tool arrays; each registry carries a room-safe `skill` and
      structured example calls; flat catalog / KNOWN_TOOLS / digest all derive from the one list.
- [x] Read/write tool split (linear/github/notion `_read`/`_write`): grain rejected at the tool
      boundary, write tools statically `outward`; grants now express read-without-write.
- [x] §11 "expose exactly" enforced at exposure: buildToolset filters by turn kind
      (exposableForKind), broker deny-at-call stays as defense in depth.
- [x] Toolbox digest: TurnPrompt `toolbox` slot + renderToolbox, derived from the built toolset
      (buildToolbox) — fresh interactive/ambient/distillation contexts and execution turn 1;
      examples filter to exposed tools.
- Done when: suite green (400), typecheck clean, deployed. Follow-on (decoupled): deployment
  skills carried by policy (bevelina-deploy owns workspace conventions); grant linear_read/_write
  in the live policy.

# Phase 4 — The Collapse ✅ (built 2026-07-13, hard cutover — no classic mode)

One attention loop per identity. Spec: specs/2026-07-13-the-collapse-design.md.

## M15 — The resident loop ✅

Status: done (2026-07-13). Hard cutover per operator: interactive/ambient/distillation turn
kinds, turn admission, prompt hydration (context.ts), ambient caps, and distillation are
DELETED, not flagged off.

- [x] Schema v9: turns.kind gains 'resident'; resident_cursor (rowid-keyed durable delivery
      cursor over the events table, seeded at migration so history stays history).
- [x] Broker: TurnKind = resident | execution_step; §10.2 consequential denial carries over.
- [x] Resident loop in service.ts: verbatim inbox delivery, addressed wakes now / observed
      settle on debounce, one wake in flight, rotation at turn cap + context exhaustion,
      §14.2 fallback, tasks home to the addressing conversation.
- [x] Memory + standing venue instructions ride AGENTS.md (refreshSoul, per fresh thread);
      soul gains "How the room hears you" (reply-tool-only) and "Your desk" (notes carry her
      across rotations).
- [x] SPEC: top notice + §9 (Presence) + §11 (Resident Loop) rewritten; §5/§8.2 harmonization
      is follow-up (§11 wins where they conflict).
- Done when: suite green (330), typecheck clean, deployed live.

## M16 — Live-fire + rotation equivalence (next)

Rotate her mid-day on purpose; judge whether her notes carry her. Watch the first real day:
wake cadence, note quality, whether the missing image-fetch and interactive streaming are
regressions worth restoring in resident form.

## M17 — Hands (only if a real grind ever blocks a real conversation)

# Phase 3 — future (not planned in detail)

Nothing is required for a conforming, deployable single-operator system — M0–M10 cover it. Natural
next items if the deployment grows: a real soak/chaos harness (fake Socket Mode server, RSS soak);
guest-principal metadata (a `users.info` fetch so §10.4 guest-confirmation eligibility is populated
from the surface rather than defaulted); the `@slack/bolt` swap (only if the M9 tripwires fire —
HTTP-mode scale, multi-workspace); retry-backoff timing on execution re-dispatch (currently bounded
by the interruption park, but not delayed); and any external tool connectors an operator wants to
grant (the catalog + `KNOWN_TOOLS` seam is already in place).
