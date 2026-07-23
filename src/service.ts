// SPEC §3.1 (component wiring), §13/§17.3 (scheduler pass), §14.2 (restart recovery on boot),
// §16.2 (live policy reload) — the long-running service. Everything M0–M7 built is a library; this
// is the supervisor that boots once and drives them all concurrently, forever. Reference daemon
// shape: ~/dev/bunion/src/orchestrator.ts (a `running` map of in-flight work, `slots = cap −
// running.size` gating, a heartbeat, SIGTERM/SIGINT graceful shutdown).
//
// This module is beyond the SPEC's behavioral contract (§2.2 non-goals: process lifecycle is
// implementation territory); it anchors to the operational sections that exist and documents the
// rest as deliberate choices.
import { writeFileSync, mkdirSync } from "node:fs";
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
import { pendingMessages, messagesAfter, advanceCursor, type InboxMessage } from "./ledger/inbox";
import { openAttentionItem, closeAttentionItemsForThread, closeAttentionItem, reopenAttentionItem, openItems, earCursor, advanceEarCursor } from "./ledger/attention";
import { recordThreadParticipation } from "./ledger/threads";
import { composeEarInstructions } from "./turn-runner/ear-soul";
import { checkpointWal } from "./ledger/db";
import { runExecution, type ExecutionOutcome } from "./turn-runner/execution-loop";
import { lastAskQuestion, lastTurnStartedAt, outboundEffectsSince, type TurnStatus } from "./ledger/turns";
import { runTurn } from "./turn-runner/turn";
import { buildToolset, BUILTIN_REGISTRIES } from "./turn-runner/toolset";
import { buildToolbox, renderToolbox, type ToolRegistry } from "./tools/catalog";
import { composeInstructions } from "./turn-runner/soul";
import { deliverPost } from "./adapter/outbound";
import { ReplyStream } from "./adapter/reply-stream";
import { routeMessage } from "./adapter/router";
import type { SurfaceAdapter } from "@bevyl-ai/agent-tools";
import type { AgentRuntimeSession, DynamicTool, AgentEvent } from "./turn-runner/types";
import type { PolicyStore } from "./policy/load";
import type { Policy, IdentityConfig } from "./policy/schema";
import type { ToolCatalog } from "./policy/broker";
import { createLogger, type Logger } from "./log";

// Attention items past this age stop being trusted to the ear's closure judgment and are flagged
// into the wake for the mind's own call (the ear design's bound on luna being wrong for days).
const ATTENTION_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const ATTENTION_PROMPT_CAP = 5;

// A delivered inbox message, verbatim, with the coordinates she needs to reply into or react
// to it: venue, thread root, and the message's own ts.
function inboxLine(m: InboxMessage): string {
  const files = m.files?.length ? ` [attached: ${m.files.map((f) => f.name).join(", ")}]` : "";
  return `[<#${m.venueId}>${m.threadRootId ? ` thread=${m.threadRootId}` : ""} ts=${m.ts}] <@${m.principalId ?? "?"}>: ${m.text.slice(0, 2500)}${files}`;
}

// A mention or DM is spoken TO her; everything else in a batch (thread chatter, held observed
// traffic, worker signals) merely reached her. The mind's prompt marks the difference so
// silence toward a ride-along line reads as licensed, not negligent.
function isDirectAddress(m: InboxMessage): boolean {
  return m.addressMode === "mention" || m.addressMode === "dm";
}

export interface ServiceDeps {
  db: Database;
  clock: Clock;
  policyStore: PolicyStore;
  adapter: SurfaceAdapter;
  botPrincipalId: string;
  cwd: string; // workspace directory for codex sessions
  // The ear's own workspace (its AGENTS.md is the observer's, never the participant soul).
  // Defaults to `${cwd}-ear`. Must be a codex-trusted directory in live deploys.
  earCwd?: string;
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
  // The Ear (specs/2026-07-13-the-ear-design.md): observed traffic no longer wakes the mind —
  // it settles behind the same debounce into an ear pass that judges whether to. The ear gates
  // waking, never delivery. Why-lines from wake verdicts wait here for the next wake (in-memory
  // on purpose: a crash just means the wake delivers without annotations — fail-open).
  private earDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  private earRunning = new Set<string>();
  private earRerun = new Set<string>();
  private earNotes = new Map<string, string[]>();
  // §5.5 withheld replies awaiting the next wake's reconsideration. In-memory like earNotes
  // (and for the same reason): a crash loses a draft the model can simply re-derive — fail-open.
  private unsentDrafts = new Map<string, string[]>();

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
      if (messagesAfter(this.d.db, identity.id, earCursor(this.d.db, identity.id), 1).length > 0) this.scheduleEar(identity.id);
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
      for (const [id, t] of this.earDebounce) {
        clearTimeout(t);
        this.earDebounce.delete(id);
        this.runEarPass(id);
      }
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
    for (const t of this.earDebounce.values()) clearTimeout(t);
    this.earDebounce.clear();
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
      if (result.event.addressMode === "thread_follow") {
        // Thread-follow stays addressed for the ledger (participation, delivery, debts), but
        // most of it is people talking to each other in a thread she's part of — whether it
        // wakes her is the ear's judgment, same as observed chatter (SPEC §11).
        this.scheduleEar(result.event.identityId);
      } else {
        // §5.2: the ack duty is met AT ADMISSION for a direct address (mention/DM), and a
        // direct address never waits on the ear — the mind wakes now.
        this.showThinking(result.event.venueId, result.event.threadRootId ?? result.event.ts);
        this.scheduleWake(result.event.identityId, 0);
        // The ear bookkeeps direct addresses after the fact (never gating them): a direct ask
        // becomes an attention item that outlives a whiffed wake.
        this.scheduleEar(result.event.identityId);
      }
    } else if (result.kind === "observed") {
      // The Ear: overheard chatter settles behind the debounce into an ear pass, which judges
      // whether the mind wakes. Every message reaches the inbox regardless — the ear gates
      // waking, never delivery; held chatter rides the next wake verbatim.
      this.scheduleEar(result.event.identityId);
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

  // --- the ear (specs/2026-07-13-the-ear-design.md) ---
  // A small, voiceless attention pass over traffic the mind wasn't directly addressed by. It
  // judges per conversation — hold, wake the mind, open/close a debt — and reads with its own
  // cursor. It gates WAKING, never delivery: held messages stay pending on the mind's cursor and
  // ride the next wake verbatim. Fail-open: a dead ear pass wakes the mind unjudged.

  private earWorkspace(): string {
    return this.d.earCwd ?? `${this.d.cwd}-ear`;
  }

  private scheduleEar(identityId: string): void {
    if (this.stopping) return;
    if (this.earDebounce.has(identityId)) return; // first arm wins — the burst rides one pass
    const identity = this.identityById(identityId);
    this.earDebounce.set(
      identityId,
      setTimeout(() => {
        this.earDebounce.delete(identityId);
        if (!this.stopping) this.runEarPass(identityId);
      }, identity?.ambient.eventDebounceMs || 20_000),
    );
  }

  private refreshEarSoul(): void {
    try {
      const summaries = this.policy().identities.map((i) => {
        const { kept } = coreWithinBudget(queryMemory(this.d.db, i.id, { tier: "core" }), this.policy().memory.coreCharBudget);
        return { identity: i.id, persona: i.persona, facts: kept.map((m) => m.content) };
      });
      mkdirSync(this.earWorkspace(), { recursive: true });
      writeFileSync(join(this.earWorkspace(), "AGENTS.md"), composeEarInstructions(summaries));
    } catch (e) {
      // Same contract as refreshSoul: a missing standing doc degrades the voice, never the pass.
      this.log.warn("could not write ear soul (AGENTS.md) — ear runs on codex default voice", { error: String(e) });
    }
  }

  private runEarPass(identityId: string): void {
    if (this.earRunning.has(identityId)) {
      this.earRerun.add(identityId);
      return;
    }
    this.earRunning.add(identityId);
    const promise = (async () => {
      const batch = messagesAfter(this.d.db, identityId, earCursor(this.d.db, identityId));
      if (batch.length === 0) return;
      const open = openItems(this.d.db, identityId);
      const effects: unknown[] = [];
      let needWake = false;
      const notes: string[] = [];
      const verdictTool: DynamicTool = {
        spec: {
          name: "verdict",
          description:
            "Report one judgment about one conversation. decision: 'hold' (nothing needed from her), 'wake' (this is HERS and needs her now — why becomes her own first read of it), 'open_ask' (a direct ask of her, never what one teammate owes another — record the debt; does not wake by itself), 'close_ask' / 'reopen_ask' (a recorded debt was settled / was not actually settled; pass itemId). Every why must read naturally if said aloud in the room.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["decision", "why"],
            properties: {
              decision: { type: "string", enum: ["hold", "wake", "open_ask", "close_ask", "reopen_ask"] },
              why: { type: "string" },
              venueId: { type: "string" },
              threadRootId: { type: ["string", "null"] },
              askTs: { type: "string" },
              itemId: { type: "string" },
            },
          },
        },
        run: async (args: unknown) => {
          const a = args as { decision: string; why: string; venueId?: string; threadRootId?: string | null; askTs?: string; itemId?: string };
          effects.push({ kind: "ear_verdict", ...a });
          if (a.decision === "wake") {
            needWake = true;
            if (a.venueId) notes.push(`<#${a.venueId}>${a.threadRootId ? ` thread=${a.threadRootId}` : ""}: ${a.why}`);
            else notes.push(a.why);
          } else if (a.decision === "open_ask") {
            if (!a.venueId) return { success: false, output: "open_ask needs venueId (and threadRootId/askTs when known)" };
            openAttentionItem(this.d.db, this.d.clock, {
              id: this.d.newId(),
              identityId,
              venueId: a.venueId,
              threadRootId: a.threadRootId ?? null,
              askTs: a.askTs ?? null,
              what: a.why,
            });
          } else if (a.decision === "close_ask") {
            if (!a.itemId || !closeAttentionItem(this.d.db, this.d.clock, a.itemId, a.why)) return { success: false, output: "no open item with that id" };
          } else if (a.decision === "reopen_ask") {
            if (!a.itemId || !reopenAttentionItem(this.d.db, a.itemId)) return { success: false, output: "no item with that id" };
          }
          return { success: true, output: "noted" };
        },
      };
      let status: TurnStatus = "failed";
      try {
        this.refreshEarSoul();
        const session = this.d.sessionFactory([verdictTool], (e) => {
          if (e.log) this.log.info("ear", { line: e.log });
        }, this.policy().models.low);
        try {
          await session.start(this.earWorkspace());
          const threadId = await session.startThread(this.earWorkspace()); // fresh every pass — an observer never accumulates
          const lines = batch
            .map((m) => `${isDirectAddress(m) ? "[she was woken for this] " : m.addressMode === "thread_follow" ? "[a thread she is part of] " : ""}${inboxLine(m)}`)
            .join("\n");
          // Her own replies and reactions since the last pass: without these the ear judges
          // settlement blind (her posts never enter the events stream) and reopens debts
          // against answers it never saw.
          const sinceLast = lastTurnStartedAt(this.d.db, identityId, "attention");
          const didLines = (sinceLast ? outboundEffectsSince(this.d.db, identityId, sinceLast) : []).map((d) =>
            d.kind === "posted"
              ? `- she replied in <#${d.venueId}>${d.threadRootId ? ` thread=${d.threadRootId}` : ""}: ${(d.text ?? "").slice(0, 300)}`
              : `- she reacted :${d.emoji}: to ts=${d.ts} in <#${d.venueId}>`,
          );
          const did = didLines.length ? `\n\nwhat she has said and done since your last listen:\n${didLines.join("\n")}` : "";
          const debts = open.length
            ? `\n\nrecorded debts (close or reopen by itemId as the thread warrants):\n${open.map((i) => `- (${i.id}) <#${i.venueId}>${i.threadRootId ? ` thread=${i.threadRootId}` : ""}: ${i.what}`).join("\n")}`
            : "";
          status = (
            await runTurn({
              session,
              threadId,
              cwd: this.earWorkspace(),
              prompt: `${lines}${did}${debts}`,
              title: `ear:${identityId}`,
              db: this.d.db,
              clock: this.d.clock,
              turnId: this.d.newId(),
              identityId,
              kind: "attention",
              effects,
              tokensUsed: () => 0,
              spendAmount: () => 0,
              envelope: { timeoutMs: this.policy().turns.interactiveTimeoutMs, tokenCeiling: this.policy().turns.interactiveTokenCeiling },
            })
          ).status;
        } finally {
          session.stop();
        }
      } catch (e) {
        this.log.error("ear pass threw", { identityId, error: String(e) });
      } finally {
        // Judged or punted, these rows are the ear's past now. The mind's own cursor is untouched.
        advanceEarCursor(this.d.db, identityId, batch.at(-1)!.rowid);
      }
      if (status !== "succeeded") {
        // Fail-open (the design's sacred rule #2): a dead ear must cost nothing but the judgment —
        // the mind wakes for the batch exactly as it would have pre-ear.
        this.log.warn("ear pass did not succeed — failing open to a wake", { identityId, status });
        needWake = true;
      }
      if (notes.length) this.earNotes.set(identityId, [...(this.earNotes.get(identityId) ?? []), ...notes]);
      if (needWake) this.runWake(identityId);
    })().finally(() => {
      this.earRunning.delete(identityId);
      const again = this.earRerun.delete(identityId);
      if (!this.stopping && again) this.runEarPass(identityId);
    });
    this.track(this.wakes, promise);
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
      // Direct addresses (mention/DM) alone carry the §14.2 duties: the failure fallback, the
      // answered gate, and the typing shimmer. Thread-follow is addressed for the ledger but
      // not spoken TO her — a dead wake over thread chatter fails into the log, never the room
      // (SPEC §18: "a thread-follow turn's failure is ledger/log-only").
      const direct = pending.filter(isDirectAddress);
      // Tasks born in this wake home to the conversation that most recently engaged her (the
      // last addressed message, else the last overheard one) — its thread gets the checklist
      // and progress posts. Posting is never homed: reply/react take explicit coordinates
      // (SPEC §11) because a batch can span conversations and a guessed destination misroutes.
      const homeMsg = addressed.at(-1) ?? pending.at(-1)!;
      const anchorObj: Anchor = { venueId: homeMsg.venueId ?? "", threadRootId: homeMsg.threadRootId ?? homeMsg.ts };
      // The home thread's reply is ONE native streamed message (reply-stream.ts): checklist
      // cards buffer inside the stream until her first words materialize it, so a plan box
      // alone never posts and never notifies (2026-07-20 live defect: a bare card-only
      // checklist landed as her whole reply while she worked). Replies addressed elsewhere
      // still go out as plain posts — a stream belongs to exactly one thread.
      const stream = new ReplyStream({
        adapter: this.d.adapter,
        venueId: anchorObj.venueId,
        threadTs: anchorObj.threadRootId,
        recipient: homeMsg.principalId,
        log: this.log,
      });
      const effects: unknown[] = [];
      let failureCause = "";
      // §5.5 stale-reply withholding: nobody addressed this wake directly, so a reply races the
      // room — the model composes against a snapshot while people keep talking (2026-07-23 live:
      // she answered a question a human had already answered, a minute later). Replies buffer
      // here until turn end; flushBuffered (below, run before the turn records) posts each one
      // unless newer addressed messages landed on its conversation mid-turn — those are withheld
      // into the next wake as unsent drafts. A directly-addressed wake never buffers: the asker
      // is owed the answer even if the thread has moved.
      const batchTail = pending.at(-1)!.rowid;
      const buffered: { anchor: Anchor; text: string }[] = [];
      const bufferReply = direct.length > 0 ? undefined : (a: Anchor, text: string) => void buffered.push({ anchor: a, text });
      const flushBuffered = async (turnStatus: TurnStatus): Promise<void> => {
        const toFlush = buffered.splice(0); // each retry attempt re-decides from scratch
        if (turnStatus !== "succeeded") return; // a dead wake's half-sent words never post (same rule as clearCards)
        const drafts: string[] = [];
        for (const b of toFlush) {
          const moved = messagesAfter(this.d.db, identityId, batchTail).some(
            (m) =>
              m.kind === "addressed_message" &&
              (m.venueId ?? "") === b.anchor.venueId &&
              (b.anchor.threadRootId === null ? m.threadRootId === null : (m.threadRootId ?? m.ts) === b.anchor.threadRootId),
          );
          if (moved) {
            drafts.push(`- to <#${b.anchor.venueId}>${b.anchor.threadRootId ? ` thread=${b.anchor.threadRootId}` : ""}: ${b.text}`);
            effects.push({ kind: "withheld", anchor: b.anchor, text: b.text });
            continue;
          }
          const streamedId =
            b.anchor.venueId === anchorObj.venueId && b.anchor.threadRootId === anchorObj.threadRootId ? await stream.post(b.text) : null;
          const result = streamedId ? { messageId: streamedId } : await this.postMessage(b.anchor, b.text);
          recordThreadParticipation(this.d.db, this.d.clock, identityId, b.anchor.venueId, b.anchor.threadRootId ?? result.messageId);
          closeAttentionItemsForThread(this.d.db, this.d.clock, identityId, b.anchor.venueId, b.anchor.threadRootId ?? null, "answered in thread");
          effects.push({ kind: "posted", anchor: b.anchor, text: b.text });
        }
        if (drafts.length) this.unsentDrafts.set(identityId, [...(this.unsentDrafts.get(identityId) ?? []), ...drafts]);
      };
      // §14.2 gate: flipped when a reply or react lands on a directly addressed message — a
      // wake that answered someone before dying leaves nobody hanging, so no fallback. Every
      // flip must co-occur with a pushed effect (the same tool call records one): the retry
      // loop's effects-nonempty guard is what keeps a later attempt from seeing answered=true
      // off a prior attempt's partial work.
      let answered = false;
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
        postMessage: async (a, text) => {
          const streamedId =
            a.venueId === anchorObj.venueId && a.threadRootId === anchorObj.threadRootId ? await stream.post(text) : null;
          const result = streamedId ? { messageId: streamedId } : await this.postMessage(a, text);
          if (direct.some((m) => a.venueId === (m.venueId ?? "") && a.threadRootId === (m.threadRootId ?? m.ts))) answered = true;
          // Optimistic close (ear design): answering in a thread settles its recorded debts the
          // moment the post lands — she never re-answers her own work. The ear can reopen.
          closeAttentionItemsForThread(this.d.db, this.d.clock, identityId, a.venueId, a.threadRootId ?? null, "answered in thread");
          return result;
        },
        updateMessage: this.d.adapter.updateMessage ? (v, m, t) => this.d.adapter.updateMessage!(v, m, t) : undefined,
        renderChecklist: async (items) => stream.setCards(items),
        // Reactions reach any delivered message by venue + ts (the values in her lines). When
        // one lands on a message in this batch, it carries the same bookkeeping a reply does:
        // the §14.2 answered flip and the optimistic attention close for that message's thread.
        reactTo: async (v, ts, emoji) => {
          await this.d.adapter.addReaction(v, ts, emoji);
          const m = pending.find((p) => v === (p.venueId ?? "") && ts === p.ts);
          if (!m) return;
          if (isDirectAddress(m)) answered = true;
          closeAttentionItemsForThread(this.d.db, this.d.clock, identityId, v, m.threadRootId ?? m.ts ?? ts, "reacted in thread");
        },
        checklist: { messageId: null },
        effects,
        ...(bufferReply ? { bufferReply } : {}),
      });
      this.refreshSoul(); // a fresh thread must open with current memory + standing instructions
      // The prompt is the messages, plus the two model-authored slots the ear design adds: her
      // own first read of the room (wake-verdict why-lines, consumed here) and what she still
      // owes (open attention items, capped; the oldest past max-age is flagged to her own call).
      const notes = this.earNotes.get(identityId) ?? [];
      this.earNotes.delete(identityId);
      const owed = openItems(this.d.db, identityId);
      // Her own posts and reactions since the previous wake: a fresh thread has no history, so
      // without these she answers blind to what she already said (same recovery the ear uses —
      // her posts never enter the events stream).
      const sinceLast = lastTurnStartedAt(this.d.db, identityId, "resident");
      const didLines = (sinceLast ? outboundEffectsSince(this.d.db, identityId, sinceLast) : []).map((d) =>
        d.kind === "posted"
          ? `- you replied in <#${d.venueId}>${d.threadRootId ? ` thread=${d.threadRootId}` : ""}: ${(d.text ?? "").slice(0, 300)}`
          : `- you reacted :${d.emoji}: to ts=${d.ts} in <#${d.venueId}>`,
      );
      const didSection = didLines.length ? `\n\n[what you did recently]\n${didLines.join("\n")}` : "";
      // §5.5: a withheld reply surfaces to the immediately following wake — the model's own
      // words, reconsidered by the model against the room as it now stands. Consumed like ear
      // notes: once, by whichever wake comes next.
      const heldDrafts = this.unsentDrafts.get(identityId) ?? [];
      this.unsentDrafts.delete(identityId);
      const draftSection = heldDrafts.length
        ? `\n\n[drafted last wake but not sent — the conversation had moved on; decide fresh what (if anything) to say]\n${heldDrafts.join("\n")}`
        : "";
      const readSection = notes.length ? `\n\n[your first read of the room]\n${notes.map((n) => `- ${n}`).join("\n")}` : "";
      const owedSection = owed.length
        ? `\n\n[still owed]\n${owed
            .slice(0, ATTENTION_PROMPT_CAP)
            .map((i) => {
              const overdue = Date.parse(this.d.clock()) - Date.parse(i.openedAt) > ATTENTION_MAX_AGE_MS;
              return `- <#${i.venueId}>${i.threadRootId ? ` thread=${i.threadRootId}` : ""}: ${i.what}${overdue ? " (open a long time — settle it or drop it)" : ""}`;
            })
            .join("\n")}${owed.length > ATTENTION_PROMPT_CAP ? `\n(+${owed.length - ATTENTION_PROMPT_CAP} newer ones not shown — they surface as these settle)` : ""}`
        : "";
      const prompt = `${pending.map((m) => `${isDirectAddress(m) ? "[to you] " : ""}${inboxLine(m)}`).join("\n")}${didSection}${draftSection}${readSection}${owedSection}`;
      let status: TurnStatus = "failed";
      // In-flight work finishes under the policy it started with (SPEC §16.2) — snapshot once.
      const turns = this.policy().turns;
      try {
        // §14.2: retry a dead wake with backoff up to turns.max_retries, a fresh runtime
        // session each time — but only while it has touched nothing; replaying a turn that
        // already acted would duplicate its effects.
        for (let attempt = 0; attempt <= turns.maxRetries; attempt++) {
          failureCause = "";
          const session = this.d.sessionFactory(tools, (e) => {
            if (e.event === "turn_failed" && e.log) failureCause = e.log;
            if (e.log) this.log.info("codex", { line: e.log });
          });
          try {
            await session.start(this.d.cwd);
            // SPEC §11 "No thread survives its wake": every wake (and every retry) is a fresh
            // runtime thread. Context cannot accumulate, so rot (2026-07-09, 2026-07-20) is
            // structurally impossible; continuity is AGENTS.md + ledger memory + the
            // recent-actions slot in the prompt.
            const threadId = await session.startThread(this.d.cwd);
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
              envelope: { timeoutMs: turns.interactiveTimeoutMs, tokenCeiling: turns.interactiveTokenCeiling },
              beforeRecord: flushBuffered,
            });
            status = result.status;
            if (!failureCause && result.cause) failureCause = result.cause;
          } catch (e) {
            status = "failed";
            failureCause = e instanceof Error ? e.message : String(e);
          } finally {
            session.stop();
          }
          if (status === "succeeded") break;
          this.log.error("resident wake attempt did not succeed", { identityId, attempt, status, cause: failureCause });
          if (effects.length > 0) break;
          if (attempt < turns.maxRetries) await new Promise((r) => setTimeout(r, turns.backoffMs * 2 ** attempt));
        }
        // §14.2's one carve-out: someone directly addressed her and the model died before it
        // could answer. Honest, in the runtime's words when they read human.
        if (status !== "succeeded" && direct.length > 0 && !answered) {
          const last = direct.at(-1)!;
          const why = failureCause || (status === "timed_out" ? "it ran out of time" : "my agent runtime failed");
          await this.postMessage(
            { venueId: last.venueId ?? "", threadRootId: last.threadRootId ?? last.ts },
            `can't run right now — ${why}. try me again, or flag the operator if it keeps up.`,
          ).catch(() => {});
        }
      } finally {
        // Close the home stream: a succeeded wake settles any still-pending cards (Slack
        // renders a pending card on a stopped stream as "Something went wrong"); a failed
        // wake drops buffered cards instead — a checked-off plan over a failure is a lie.
        if (status === "succeeded") stream.settleCards();
        else stream.clearCards();
        await stream.close().catch(() => {});
        // Delivery is done even when the turn wasn't — re-delivering the same batch to a broken
        // thread just loops the failure (observed live pre-collapse); the fallback above settled
        // the addressed duty, and everything stays searchable.
        advanceCursor(this.d.db, identityId, pending.at(-1)!.rowid);
        // The shimmer promised words; make sure it never outlives the wake. Only direct
        // addresses ever showed one (§5.2).
        for (const m of direct) {
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
      maxTurnsBackoffMs: this.policy().executions.backoffMs,
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
        // The dropped count rides into the soul so SHE curates (§8.6: curation is the fix;
        // post-Collapse there is no distiller — an ordinary wake with memory tools is it).
        return { identity: i.id, facts: kept.map((m) => m.content), dropped: dropped.length };
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
