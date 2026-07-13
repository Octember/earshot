// SPEC §3.1 (component wiring), §13/§17.3 (scheduler pass), §14.2 (restart recovery on boot),
// §16.2 (live policy reload) — the long-running service. Everything M0–M7 built is a library; this
// is the supervisor that boots once and drives them all concurrently, forever. Reference daemon
// shape: ~/dev/bunion/src/orchestrator.ts (a `running` map of in-flight work, `slots = cap −
// running.size` gating, a heartbeat, SIGTERM/SIGINT graceful shutdown).
//
// This module is beyond the SPEC's behavioral contract (§2.2 non-goals: process lifecycle is
// implementation territory); it anchors to the operational sections that exist and documents the
// rest as deliberate choices.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { Clock } from "./ledger/clock";
import { getTask, liveExecutionId, type Anchor } from "./ledger/tasks";
import {
  fireDueTimers,
  dispatchRunnable,
  recoverFromRestart,
  msUntilNextTimer,
} from "./ledger/scheduler";
import { queryMemory, coreWithinBudget } from "./ledger/memory";
import { pendingMessages, advanceCursor, type InboxMessage } from "./ledger/inbox";
import { checkpointWal } from "./ledger/db";
import { runExecution, type ExecutionOutcome } from "./turn-runner/execution-loop";
import { lastAskQuestion } from "./ledger/turns";
import { runTurn } from "./turn-runner/turn";
import { buildToolset, BUILTIN_REGISTRIES } from "./turn-runner/toolset";
import { buildToolbox, renderToolbox, type ToolRegistry } from "./tools/catalog";
import { composeInstructions } from "./turn-runner/soul";
import { getConversationThread, setConversationThread, clearConversationThread } from "./ledger/continuity";
import { deliverPost } from "./adapter/outbound";
import { routeMessage } from "./adapter/router";
import type { SurfaceAdapter } from "@bevyl-ai/agent-tools";
import type { AgentRuntimeSession, DynamicTool, AgentEvent } from "./turn-runner/types";
import type { PolicyStore } from "./policy/load";
import type { Policy, IdentityConfig } from "./policy/schema";
import type { ToolCatalog } from "./policy/broker";
import { createLogger, type Logger } from "./log";

// Thread rot (observed live 2026-07-09): a codex thread past its context window starts
// compacting, and compaction evicts the OLDEST history first — AGENTS.md, the soul itself (the
// all-day ambient thread hit 147 turns, compacted 13 times, and spent the evening de-souled).
// Rotate to a fresh thread well before that; a cold start rebuilds context from the ledger and
// loses nothing durable. Ambient turns carry a full chatter buffer each, so their cap is lower.
// SPEC §8.6 'recent' tier: overheard facts ride prompts under their own small budget and decay
// to archive if unconfirmed. Constants (not policy knobs) until someone actually needs to tune.
// The reactive arm of the same problem: a thread whose history ALREADY outgrew the gateway's
// payload limit or the model's window fails every resume identically (a bug-reports conversation
// wedged this way for two days). Match the runtime's own words and drop the mapping.
const CONTEXT_EXHAUSTED = /payload too large|context window|context length|prompt too long/i;

// The resident thread's continuity key (one per identity) and its rotation budget. Rotation is
// cheap by design: AGENTS.md + her workspace notes carry identity, so the thread is only
// working memory. Rotate early, rotate often.
const RESIDENT_VENUE = "__resident__";
const RESIDENT_MAX_TURNS = 60;

// A delivered inbox message, verbatim, with the coordinates she needs to reply into or react
// to it: venue, thread root, and the message's own ts.
function inboxLine(m: InboxMessage): string {
  const files = m.files?.length ? ` [attached: ${m.files.map((f) => f.name).join(", ")}]` : "";
  return `[<#${m.venueId}>${m.threadRootId ? ` thread=${m.threadRootId}` : ""} ts=${m.ts}] <@${m.principalId ?? "?"}>: ${m.text.slice(0, 2500)}${files}`;
}

export interface ServiceDeps {
  db: Database;
  clock: Clock;
  policyStore: PolicyStore;
  adapter: SurfaceAdapter;
  botPrincipalId: string;
  cwd: string; // workspace directory for codex sessions
  // onEvent lets the caller (interactive turns) observe the runtime's live stream (codex token
  // deltas) to drive streaming replies. Optional — executions pass no onEvent (extra param ignored).
  // overrides carry a task tier's model/effort (policy.models); the wiring (main.ts) turns them
  // into per-session runtime config. Omitted for resident wakes (the runtime default is the mind).
  sessionFactory: (tools: DynamicTool[], onEvent?: (e: AgentEvent) => void, overrides?: { model?: string; effort?: string }) => AgentRuntimeSession;
  newId: () => string; // unique ids for events / executions / turns
  catalog?: ToolCatalog; // external tool implementations (empty for the built-in-only default)
  // Registry grouping for the toolbox digest (SPEC §11) — the same registries the catalog was
  // flattened from. Built-ins are grouped internally; omitting this just leaves external tools
  // in per-tool groups with no skill text.
  registries?: ToolRegistry[];
  logger?: Logger;
  heartbeatMs?: number; // if set, start() runs a real interval; omit to drive tick() manually
}

export class Service {
  private readonly d: ServiceDeps;
  private readonly log: Logger;
  private readonly catalog: ToolCatalog;
  private readonly registries: ToolRegistry[];
  private heartbeat: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private ticksSinceCheckpoint = 0;
  // The resident loop (specs/2026-07-13-the-collapse-design.md): one attention per identity.
  // An addressed message wakes it now; observed chatter settles behind a debounce; one wake
  // in flight per identity, a rerun flag collapsing whatever arrives mid-wake.
  private residentDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  private residentRunning = new Set<string>();
  private residentRerun = new Set<string>();
  private wakes = new Set<Promise<unknown>>();
  private executions = new Set<Promise<unknown>>();

  constructor(deps: ServiceDeps) {
    this.d = deps;
    this.log = deps.logger ?? createLogger();
    this.catalog = deps.catalog ?? {};
    this.registries = [...BUILTIN_REGISTRIES, ...(deps.registries ?? [])];
  }

  policy(): Policy {
    return this.d.policyStore.current();
  }

  async start(): Promise<void> {
    // (1) restart recovery — orphaned actives from a prior process → interrupted → reopen/park.
    const recovery = recoverFromRestart(this.d.db, this.d.clock, {
      maxConsecutiveInterruptions: this.policy().executions.maxAttempts,
    });
    if (recovery.reopened.length || recovery.parked.length) {
      this.log.info("restart recovery", { reopened: recovery.reopened, parked: recovery.parked });
    }
    // (1b) write earshot's "soul doc" to the workspace AGENTS.md — codex loads it as standing
    // instructions for every turn (its native system-prompt seam). This is where earshot's CHARACTER
    // comes from; each identity's `persona` extends it. Best-effort: a write failure must not stop
    // the daemon (it just falls back to codex's default voice).
    this.refreshSoul();
    // (2) wire inbound + start the surface.
    this.d.adapter.onMessage((msg) => this.onInbound(msg));
    await this.d.adapter.start();
    this.log.info("service started");
    // (2b) anything that arrived while we were down (or was never delivered before a crash) is
    // still in the inbox past the cursor — wake for it shortly after boot.
    for (const identity of this.policy().identities) {
      if (pendingMessages(this.d.db, identity.id, 1).length > 0) this.scheduleWake(identity.id, 1500);
    }
    // (3) heartbeat — only when configured (tests drive tick() directly). Self-scheduling and
    // idle-efficient (M9): after each tick it sleeps until the next durable timer is due, bounded
    // by heartbeatMs as a safety net. Newly-open tasks don't wait for this sleep — an interactive
    // turn or execution completing triggers an immediate tick (maybeTick), so dispatch is
    // event-driven and the heartbeat only needs to cover actual timers (nudges/parks/wakes/ticks).
    if (this.d.heartbeatMs && this.d.heartbeatMs > 0) this.scheduleHeartbeat();
  }

  private scheduleHeartbeat(): void {
    if (this.stopping) return;
    const maxMs = this.d.heartbeatMs!;
    const sleep = msUntilNextTimer(this.d.db, this.d.clock, maxMs);
    this.heartbeat = setTimeout(() => {
      void this.tick()
        .catch((e) => this.log.error("tick failed", { error: String(e) }))
        .finally(() => this.scheduleHeartbeat());
    }, sleep);
  }

  private maybeTick(): void {
    // Event-driven re-tick after work completes: a finished interactive turn may have created a
    // task (dispatch it), a finished execution frees a concurrency slot (fill it). Guarded so it
    // never fires during shutdown.
    if (!this.stopping) void this.tick().catch((e) => this.log.error("tick failed", { error: String(e) }));
  }

  // One scheduler pass (SPEC §17.3): fire due timers, then dispatch runnable tasks into freed
  // concurrency slots, launching each as a tracked async execution.
  async tick(): Promise<void> {
    if (this.stopping) return;
    fireDueTimers(this.d.db, this.d.clock, {
      parkAfterMs: this.policy().tasks.parkAfterMs,
      // The Collapse: ambient/distillation ticks no longer exist. A live db may still hold
      // pending legacy timers — they drain here once (marked fired, no handler, no re-arm).
    });

    const result = dispatchRunnable(this.d.db, this.d.clock, {
      maxConcurrentPerIdentity: this.policy().executions.maxConcurrentPerIdentity,
      maxConcurrentGlobal: this.policy().executions.maxConcurrentGlobal,
      newExecutionId: () => this.d.newId(),
    });
    for (const taskId of result.dispatched) this.launchExecution(taskId);

    // M9: fold the WAL back into the main db periodically so a weeks-long single-writer process
    // doesn't grow an unbounded -wal file (auto-checkpoint-on-close never fires while we're up).
    if (++this.ticksSinceCheckpoint >= 300) {
      this.ticksSinceCheckpoint = 0;
      try {
        checkpointWal(this.d.db);
      } catch (e) {
        this.log.warn("wal checkpoint failed", { error: String(e) });
      }
    }
  }

  // Await all in-flight interactive turns and executions (used by stop() and by tests). Loops so
  // that work spawned while draining is also awaited. Flushes the admission quiet window first —
  // a queued-but-held batch is in-flight work too, and stop() must never drop a member's message.
  async idle(): Promise<void> {
    while (true) {
      for (const [id, t] of this.residentDebounce) {
        clearTimeout(t);
        this.residentDebounce.delete(id);
        this.runWake(id);
      }
      if (!this.wakes.size && !this.executions.size) return;
      await Promise.allSettled([...this.wakes, ...this.executions]);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeat) clearTimeout(this.heartbeat);
    for (const t of this.residentDebounce.values()) clearTimeout(t);
    this.residentDebounce.clear();
    this.d.adapter.stop();
    await this.idle(); // let in-flight interactive turns + executions finish cleanly
    // The db is injected, not opened here — the entrypoint that opened it (main.ts) closes it,
    // after stop() returns. Resource ownership stays with the opener.
    this.log.info("service stopped");
  }

  reloadPolicy(): boolean {
    const result = this.d.policyStore.reload();
    if (result.ok) {
      this.log.info("policy reloaded");
      return true;
    }
    this.log.error("policy reload rejected — keeping last-known-good", { errors: result.errors });
    return false;
  }

  // Feed a message through the inbound pipeline directly (bypassing the surface socket). For
  // self-tests / operator harnesses that want to exercise the full router→turn→reply path without
  // a real Slack event.
  ingest(msg: import("@bevyl-ai/agent-tools").RawMessage): void {
    this.onInbound(msg);
  }

  // Force a wake now (off any debounce). For self-tests / operators.
  wakeNow(identityId: string): void {
    this.runWake(identityId);
  }

  // --- inbound ---
  private onInbound(msg: import("@bevyl-ai/agent-tools").RawMessage): void {
    const result = routeMessage(this.d.db, this.d.clock, msg, {
      botPrincipalId: this.d.botPrincipalId,
      policy: this.policy(),
      newEventId: () => this.d.newId(),
      onUnboundVenue: (venueId) => this.log.warn("message from unbound venue", { venueId }),
    });
    if (result.kind === "addressed") {
      // §5.2: the ack duty is met AT ADMISSION for a direct address (mention/DM). A
      // thread-follow message carries no ack duty but still wakes her now — she's part of
      // that conversation.
      if (result.event.addressMode !== "thread_follow") {
        this.showThinking(result.event.venueId, result.event.threadRootId ?? result.event.ts);
      }
      this.scheduleWake(result.event.identityId, 0);
    } else if (result.kind === "observed") {
      // Overheard chatter settles before it wakes her — first arm wins, the rest of the burst
      // rides the same wake. Every message reaches the inbox regardless; the debounce only
      // decides WHEN she reads.
      const identity = this.identityById(result.event.identityId);
      this.scheduleWake(result.event.identityId, identity?.ambient.eventDebounceMs || 20_000);
    }
    // ignored_self / unbound_venue / duplicate → nothing.
  }

  private identityById(id: string): IdentityConfig | undefined {
    return this.policy().identities.find((i) => i.id === id);
  }

  private principalOf(principalId: string | null): { id: string; isGuest: boolean; isOperator: boolean } {
    // Guest detection needs surface member metadata this build doesn't yet fetch (a Slack
    // users.info call) — default non-guest; the confirmation-eligibility default (§10.4) still
    // makes a guest's confirmation unacceptable IF a caller marks them so, which the router will
    // supply once member metadata is wired (a documented follow-up, not a correctness gap here).
    return { id: principalId ?? "unknown", isGuest: false, isOperator: this.policy().operatorPrincipals.includes(principalId ?? "") };
  }

  // A postMessage that retries (§12.2) and, on exhaustion, alerts the operator rather than losing
  // the post silently. Returns a sentinel id on final failure so the turn still completes — the
  // ledger transition already happened; the operator alert is the escape hatch for manually
  // conveying an undelivered model post.
  private postMessage(anchor: Anchor, text: string): Promise<{ messageId: string }> {
    return deliverPost(() => this.d.adapter.postMessage(anchor.venueId, anchor.threadRootId, text), {
      maxAttempts: 5,
      backoffMs: 500,
      maxBackoffMs: 30_000,
      onExhausted: (error) => this.log.error("OUTBOUND DELIVERY FAILED — operator must convey this manually", { anchor, text, error: String(error) }),
    }).then((r) => r ?? { messageId: "undelivered" });
  }

  // The fancy "Marvin is thinking…" shimmer: assistant.threads.setStatus works on regular channel
  // threads for agent apps (probed live), with rotating loading lines. Best-effort by contract.
  private showThinking(venueId: string, threadTs: string): void {
    void this.d.adapter
      .setTypingStatus?.(venueId, threadTs, "is thinking…", ["is thinking…", "is digging in…", "is working on it…", "is putting it together…"])
      .catch(() => {});
  }

  // --- the resident loop (specs/2026-07-13-the-collapse-design.md) ---
  // One attention per identity: pending inbox messages deliver VERBATIM to one resident codex
  // thread; she does whatever she does; the thread rotates before it can rot (a fresh thread
  // re-reads AGENTS.md — soul, memory, standing instructions — and is her again). The harness
  // delivers, gates tools, and rotates. It never speaks (§6.1); the sole carve-out is the
  // §14.2 fallback below, when the model died before it could answer someone who addressed it.

  private scheduleWake(identityId: string, delayMs: number): void {
    if (this.stopping) return;
    if (delayMs <= 0) {
      const prior = this.residentDebounce.get(identityId);
      if (prior) {
        clearTimeout(prior);
        this.residentDebounce.delete(identityId);
      }
      this.runWake(identityId);
      return;
    }
    if (this.residentDebounce.has(identityId)) return; // first arm wins — the burst rides one wake
    this.residentDebounce.set(
      identityId,
      setTimeout(() => {
        this.residentDebounce.delete(identityId);
        if (!this.stopping) this.runWake(identityId);
      }, delayMs),
    );
  }

  private runWake(identityId: string): void {
    if (this.residentRunning.has(identityId)) {
      this.residentRerun.add(identityId);
      return;
    }
    this.residentRunning.add(identityId);
    const promise = (async () => {
      const identity = this.identityById(identityId);
      if (!identity) return;
      const pending = pendingMessages(this.d.db, identityId);
      if (pending.length === 0) return;
      const addressed = pending.filter((m) => m.kind === "addressed_message");
      // Tasks born in this wake home to the conversation that most recently engaged her (the
      // last addressed message, else the last overheard one) — its thread gets the checklist
      // and progress posts. reply with no explicit venue defaults here too.
      const homeMsg = addressed.at(-1) ?? pending.at(-1)!;
      const anchorObj: Anchor = { venueId: homeMsg.venueId ?? "", threadRootId: homeMsg.threadRootId ?? homeMsg.ts };
      const effects: unknown[] = [];
      let failureCause = "";
      const tools = buildToolset({
        db: this.d.db,
        clock: this.d.clock,
        identity,
        turnKind: "resident",
        catalog: this.catalog,
        anchor: anchorObj,
        principal: this.principalOf(homeMsg.principalId),
        originEventId: homeMsg.id,
        nudgeAfterMs: this.policy().tasks.nudgeAfterMs,
        permalink: (v, ts) => this.d.adapter.permalink?.(v, ts),
        postMessage: (a, text) => this.postMessage(a, text),
        updateMessage: this.d.adapter.updateMessage ? (v, m, t) => this.d.adapter.updateMessage!(v, m, t) : undefined,
        // Bare react targets the message being answered; reactTo reaches any delivered message
        // by venue + ts (the values in her lines).
        react: async (emoji) => {
          await this.d.adapter.addReaction(homeMsg.venueId ?? "", homeMsg.ts ?? "", emoji);
        },
        reactTo: (v, ts, emoji) => this.d.adapter.addReaction(v, ts, emoji),
        checklist: { messageId: null },
        effects,
      });
      this.refreshSoul(); // a fresh thread must open with current memory + standing instructions
      const session = this.d.sessionFactory(tools, (e) => {
        if (e.event === "turn_failed" && e.log) failureCause = e.log;
        if (e.log) this.log.info("codex", { line: e.log });
      });
      await session.start(this.d.cwd);
      const prior = getConversationThread(this.d.db, identityId, RESIDENT_VENUE, null);
      const priorThreadId = prior && prior.turnCount < RESIDENT_MAX_TURNS ? prior.codexThreadId : null;
      if (prior && !priorThreadId) this.log.info("resident thread rotated at turn cap", { identityId, turns: prior.turnCount });
      let threadId: string;
      try {
        threadId = priorThreadId ? await session.resumeThread(priorThreadId) : await session.startThread(this.d.cwd);
      } catch (e) {
        this.log.warn("resident thread resume failed — rotating", { identityId, error: String(e) });
        threadId = await session.startThread(this.d.cwd);
      }
      setConversationThread(this.d.db, this.d.clock, identityId, RESIDENT_VENUE, null, threadId);
      // The prompt is the messages — nothing else. AGENTS.md (loaded by the runtime at thread
      // start) carries the soul, memory, standing instructions, and the toolbox digest.
      const prompt = pending.map((m) => inboxLine(m)).join("\n");
      try {
        const result = await runTurn({
          session,
          threadId,
          cwd: this.d.cwd,
          prompt,
          title: `resident:${identityId}`,
          db: this.d.db,
          clock: this.d.clock,
          turnId: this.d.newId(),
          identityId,
          kind: "resident",
          effects,
          tokensUsed: () => 0,
          spendAmount: () => 0,
          envelope: { timeoutMs: this.policy().turns.interactiveTimeoutMs, tokenCeiling: this.policy().turns.interactiveTokenCeiling },
        });
        if (result.status !== "succeeded") {
          this.log.error("resident wake did not succeed", { identityId, status: result.status, cause: failureCause });
          if (CONTEXT_EXHAUSTED.test(failureCause)) {
            clearConversationThread(this.d.db, identityId, RESIDENT_VENUE, null);
            this.log.warn("resident thread context exhausted — rotated, next wake starts fresh", { identityId });
          }
          // §14.2's one carve-out: someone addressed her and the model died before it could
          // answer. Honest, in the runtime's words when they read human.
          if (addressed.length > 0) {
            const last = addressed.at(-1)!;
            const why = failureCause || (result.status === "timed_out" ? "it ran out of time" : "my agent runtime failed");
            await this.postMessage(
              { venueId: last.venueId ?? "", threadRootId: last.threadRootId ?? last.ts },
              `can't run right now — ${why}. try me again, or flag the operator if it keeps up.`,
            ).catch(() => {});
          }
        }
      } catch (e) {
        this.log.error("resident wake threw", { identityId, error: String(e) });
        const cause = e instanceof Error ? e.message : String(e);
        if (CONTEXT_EXHAUSTED.test(cause)) clearConversationThread(this.d.db, identityId, RESIDENT_VENUE, null);
        if (addressed.length > 0) {
          const last = addressed.at(-1)!;
          await this.postMessage(
            { venueId: last.venueId ?? "", threadRootId: last.threadRootId ?? last.ts },
            `can't run right now — my agent runtime failed with: ${cause}`,
          ).catch(() => {});
        }
      } finally {
        session.stop();
        // Delivery is done even when the turn wasn't — re-delivering the same batch to a broken
        // thread just loops the failure (observed live pre-collapse); the fallback above settled
        // the addressed duty, and everything stays searchable.
        advanceCursor(this.d.db, identityId, pending.at(-1)!.rowid);
        // The shimmer promised words; make sure it never outlives the wake.
        for (const m of addressed) {
          void this.d.adapter.setTypingStatus?.(m.venueId ?? "", m.threadRootId ?? m.ts ?? "", "").catch(() => {});
        }
      }
      this.maybeTick(); // the wake may have created tasks — dispatch without waiting for the heartbeat
    })().finally(() => {
      this.residentRunning.delete(identityId);
      const again = this.residentRerun.delete(identityId);
      if (!this.stopping && (again || pendingMessages(this.d.db, identityId, 1).length > 0)) this.runWake(identityId);
    });
    this.track(this.wakes, promise);
  }

  // --- executions ---
  private launchExecution(taskId: string): void {
    const executionId = liveExecutionId(this.d.db, taskId);
    if (!executionId) {
      this.log.warn("dispatched task has no live execution row", { taskId });
      return;
    }
    const task = getTask(this.d.db, taskId);
    if (!task) return;
    const identity = this.identityById(task.identityId);
    if (!identity) return;

    // Workers never post (2026-07-13): the execution runs on its task's tier and its outcome
    // wakes the resident mind, who tells the room in her own voice.
    const tierCfg = this.policy().models[task.tier] ?? {};
    this.refreshSoul(); // worker threads read AGENTS.md too — memory and standing instructions
    const promise = runExecution({
      db: this.d.db,
      clock: this.d.clock,
      taskId,
      executionId,
      identity,
      catalog: this.catalog,
      cwd: this.d.cwd,
      nudgeAfterMs: this.policy().tasks.nudgeAfterMs,
      permalink: (v: string, ts: string) => this.d.adapter.permalink?.(v, ts),
      maxTurns: this.policy().executions.maxTurns,
      maxConsecutiveInterruptions: this.policy().executions.maxAttempts,
      stallTimeoutMs: this.policy().executions.stallTimeoutMs,
      // No mouth: the broker denies posting tools to execution steps; this is the belt to that
      // suspenders — a worker post lands nowhere but the log.
      postMessage: async (a, text) => {
        this.log.warn("worker attempted to post — dropped (workers report to the mind)", { taskId, venueId: a.venueId, chars: text.length });
        return { messageId: "worker-no-post" };
      },
      buildPrompt: (turnNumber, guidance, tools) => {
        const spec = getTask(this.d.db, taskId)?.spec ?? "";
        const note = guidance.length ? `\n\nNew guidance:\n${guidance.join("\n")}` : "";
        return turnNumber === 1
          ? `${renderToolbox(buildToolbox(tools, this.registries))}\n\nYou are working ONE delegated task to a terminal state, as a background worker. Nothing you write is seen by anyone until you hand it back: end every run with exactly one outcome tool. task_complete when done, task_fail if it can't be done, task_ask if blocked on a human, or set_wake to check back later (a routine nothing-new check ends with set_wake alone). Your report goes to the main mind, who speaks to the room: write it as a complete handoff with receipts (links, ids, what changed), not a status diary.\n\n${spec}${note}`
          : `Continuation, turn ${turnNumber}. ${spec}${note}`;
      },
      newTurnId: () => this.d.newId(),
      sessionFactory: (tools) => this.d.sessionFactory(tools, undefined, tierCfg),
      perTaskCap: identity.budget.perTaskCap,
      budgetPolicy: {
        timezone: this.policy().budget.timezone,
        identityMonthlyCap: identity.budget.monthlyCap,
        globalMonthlyCap: this.policy().budget.globalMonthlyCap,
        reserve: this.policy().budget.reserve,
      },
    })
      .then((r) => {
        this.log.info("execution finished", { taskId, outcome: r.outcome, turnsRun: r.turnsRun, tier: task.tier });
        this.deliverWorkerReport(taskId, r.outcome);
      })
      .catch((e) => {
        this.log.error("execution threw", { taskId, error: String(e) });
        this.deliverWorkerReport(taskId, "failed");
      })
      .finally(() => {
        this.maybeTick();
      });

    this.track(this.executions, promise);
  }

  // A worker outcome becomes an inbox event that wakes the mind — except routine timer yields,
  // which are silent by design (the thread already knows she's watching). §6.1 holds: the
  // harness posts nothing; SHE decides what the room hears.
  private deliverWorkerReport(taskId: string, outcome: ExecutionOutcome): void {
    const task = getTask(this.d.db, taskId);
    if (!task) return;
    if (outcome === "yielded" && task.waitingOn === "timer") return; // silent check-in
    if (outcome === "cancelled") return; // she (or a member) cancelled it — she already knows
    const detail =
      task.status === "waiting" && task.pendingConfirmation
        ? `it needs a go-ahead: ${task.pendingConfirmation.description}`
        : task.status === "waiting"
          ? `it's blocked on a question for the room: ${lastAskQuestion(this.d.db, taskId) ?? "(see the worker's report)"}`
          : (task.terminalReport ?? "(no report)");
    const text = `[task update] "${task.title}" (the work from <#${task.homeAnchor.venueId}>${task.homeAnchor.threadRootId ? `, thread ${task.homeAnchor.threadRootId}` : ""}) ${
      outcome === "done" ? "finished" : outcome === "failed" ? "failed" : outcome === "parked" ? "was parked after repeated interruptions" : "is waiting on a human"
    }. Worker's handoff: ${detail}`;
    try {
      this.d.db
        .query(
          `INSERT INTO events (id, dedup_key, kind, identity_id, venue_id, thread_root_id, principal_id, payload, received_at)
           VALUES (?, ?, 'external_signal', ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          this.d.newId(),
          `worker:${taskId}:${this.d.newId()}`,
          task.identityId,
          task.homeAnchor.venueId,
          task.homeAnchor.threadRootId,
          JSON.stringify({ text }),
          this.d.clock(),
        );
      this.scheduleWake(task.identityId, 0);
    } catch (e) {
      this.log.error("worker report delivery failed", { taskId, error: String(e) });
    }
  }

  // Regenerate the workspace AGENTS.md: soul + personas + each identity's core memory as "What
  // you know" — standing knowledge in codex's instructions channel, not turn input to respond
  // to. Called at start and before each codex session so a fresh thread opens with current
  // memory. Best-effort: a write failure must never stop a turn.
  private refreshSoul(): void {
    try {
      const identities = this.policy().identities;
      const personas = identities.map((i) => i.persona ?? "").filter((p) => p);
      const knowledge = identities.map((i) => {
        const { kept, dropped } = coreWithinBudget(queryMemory(this.d.db, i.id, { tier: "core" }), this.policy().memory.coreCharBudget);
        if (dropped.length) this.log.warn("core memory over budget — items truncated from the soul (§8.6 hygiene defect)", { identityId: i.id, dropped: dropped.length });
        return { identity: i.id, facts: kept.map((m) => m.content) };
      });
      // §9.5: standing venue instructions ride the soul — standing config in the standing channel.
      const standing = identities.map((i) => ({ identity: i.id, venues: i.venueInstructions }));
      // The toolbox digest is standing too, post-collapse: resident exposure varies only with
      // grants, and grants change exactly when this regenerates. Tool construction is pure
      // (closures are built, never invoked), so stub callbacks are safe here.
      const toolDigests = identities.map((i) => ({
        identity: i.id,
        digest: renderToolbox(
          buildToolbox(
            buildToolset({
              db: this.d.db,
              clock: this.d.clock,
              identity: i,
              turnKind: "resident",
              catalog: this.catalog,
              anchor: null,
              nudgeAfterMs: 0,
              postMessage: async () => ({ messageId: "digest-probe" }),
              effects: [],
            }),
            this.registries,
          ),
          "", // the section heading above carries the framing
        ),
      }));
      writeFileSync(join(this.d.cwd, "AGENTS.md"), composeInstructions(personas, knowledge, standing, toolDigests));
      this.log.info("soul written", { path: join(this.d.cwd, "AGENTS.md"), personas: personas.length, knowledgeItems: knowledge.reduce((n, k) => n + k.facts.length, 0) });
    } catch (e) {
      this.log.warn("could not write soul (AGENTS.md) — using codex default voice", { error: String(e) });
    }
  }

  private track(set: Set<Promise<unknown>>, promise: Promise<unknown>): void {
    set.add(promise);
    void promise.finally(() => set.delete(promise));
  }
}
