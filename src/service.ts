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
import { messagesAfter, type InboxMessage } from "./ledger/inbox";
import { openAttentionItem, closeAttentionItemsForThread, closeAttentionItem, reopenAttentionItem, openItems } from "./ledger/attention";
import {
  recordHold,
  recordWakeWhy,
  consumeJudgment,
  getConversationJudgment,
  pendingConversations,
  unjudgedConversations,
  advanceJudged,
  hasUndelivered,
  hasUnjudged,
  renderConversation,
  recordAct,
  setActTs,
  deleteAct,
  saveDraft,
  peekDrafts,
  markDraftsConsumed,
  engage,
  stanceOf,
  convoKey,
  makeRefTable,
} from "./ledger/conversations";
import { composeEarInstructions } from "./turn-runner/ear-soul";
import { asString, isRecord } from "./guard";
import { desc, sql } from "drizzle-orm";
import { checkpointWal, orm } from "./ledger/db";
import { events } from "./ledger/schema";
import { runExecution, type ExecutionOutcome } from "./turn-runner/execution-loop";
import { lastAskQuestion, type TurnStatus } from "./ledger/turns";
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
  // it settles behind the same debounce into an ear pass that judges whether to. Its judgment
  // is durable state on the conversation row (one room, one row) — nothing rides in RAM.
  private earDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  private earRunning = new Set<string>();
  private earRerun = new Set<string>();

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
      if (hasUndelivered(this.d.db, identity.id)) this.scheduleWake(identity.id, 1500);
      if (hasUnjudged(this.d.db, identity.id)) this.scheduleEar(identity.id);
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
      writeFileSync(join(this.earWorkspace(), "AGENTS.md"), composeEarInstructions(this.d.botPrincipalId, summaries));
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
      const convos = unjudgedConversations(this.d.db, identityId);
      if (convos.length === 0) return;
      const open = openItems(this.d.db, identityId);
      const effects: unknown[] = [];
      let needWake = false;
      // Addressing as capability (ladder R4): the pass's renderer MINTS a ref per conversation
      // and per message; a verdict can only land on a ref — a judgment about a conversation the
      // pass was never shown is not expressible, so the misattributed-read shape has no syntax.
      const refs = makeRefTable();
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
              ref: { type: "string", pattern: "^r\\d+$" },
              itemId: { type: "string" },
            },
          },
        },
        run: async (args: unknown) => {
          const a = isRecord(args) ? args : {};
          const decision = asString(a.decision);
          const why = asString(a.why);
          const ref = typeof a.ref === "string" ? a.ref : undefined;
          const itemId = typeof a.itemId === "string" ? a.itemId : undefined;
          const target = ref ? refs.get(ref) : undefined;
          if (ref && !target) {
            return { success: false, output: `"${ref}" is not a ref — copy the [rN] tag (like r3) from the start of the line you are judging; timestamps and channel ids are labels, not addresses` };
          }
          // A hold/wake without a ref has nowhere durable to live — bounced, never nodded
          // through (audit 2026-08-13: a refless hold returned "noted" while recording nothing,
          // the 2026-08-10 discarded-judgment failure wearing a polite face).
          if ((decision === "hold" || decision === "wake") && !target) {
            return { success: false, output: `${decision} needs ref — the [rN] tag of a line in the conversation being judged, so the judgment lands on its row` };
          }
          const venueId = target?.venueId;
          // hold/wake judge the conversation the message LIVES in (a top-level line is surface
          // traffic); open_ask ROOTS the debt at the ask itself, where its answer will land.
          const residenceRoot = target ? target.threadRootId : null;
          const askRoot = target ? (target.threadRootId ?? target.ts ?? null) : null;
          effects.push({ kind: "ear_verdict", decision, why, venueId, threadRootId: residenceRoot });
          if (decision === "hold") {
            // A hold is durable judgment on the conversation's row, never a discarded verdict:
            // whenever these messages eventually deliver, the reads that held them ride along
            // (2026-08-10: four discarded "this is settled" holds preceded the stale post).
            if (venueId) recordHold(this.d.db, this.d.clock, identityId, venueId, residenceRoot, why);
          } else if (decision === "wake") {
            needWake = true;
            // The why is her own first read, pinned to the conversation row — it rides the
            // wake that delivers these messages, and any later one, and survives a restart.
            if (venueId) recordWakeWhy(this.d.db, this.d.clock, identityId, venueId, residenceRoot, why);
          } else if (decision === "open_ask") {
            if (!target || !venueId) {
              return { success: false, output: "open_ask needs ref — the [rN] tag of the ask itself (the message line), so the debt roots where its answer will land" };
            }
            openAttentionItem(this.d.db, this.d.clock, {
              id: this.d.newId(),
              identityId,
              venueId,
              // The ask's message roots the thread its replies will carry (the router's own
              // convention) — an anchor-less debt can never be settled by an in-thread answer.
              threadRootId: askRoot,
              askTs: target.ts ?? null,
              what: why,
            });
          } else if (decision === "close_ask") {
            if (!itemId || !closeAttentionItem(this.d.db, this.d.clock, identityId, itemId, why)) return { success: false, output: "no open item with that id" };
          } else if (decision === "reopen_ask") {
            if (!itemId || !reopenAttentionItem(this.d.db, identityId, itemId)) {
              return { success: false, output: "nothing to reopen with that id: either it does not exist, or the operator settled it and that stays settled" };
            }
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
          // The one renderer, the ear's voice: every conversation with unjudged traffic renders
          // whole — standing, prior reads (peeked, not consumed: judgment belongs to delivery),
          // tail with her words inline, then the new lines marked by how they reached her.
          const cards = convos
            .map((c) =>
              renderConversation(this.d.db, identityId, c, {
                newMessages: c.messages,
                mark: (m) => (isDirectAddress(m) ? "[she was woken for this] " : m.addressMode === "thread_follow" ? "[a thread she is part of] " : ""),
                judgment: getConversationJudgment(this.d.db, identityId, c.venueId, c.threadRootId) ?? undefined,
                stance: c.stance,
                selfLabel: "she",
                beforeRowid: c.messages[0]!.rowid - 1,
                refs,
              }),
            )
            .join("\n\n");
          const debts = open.length
            ? `\n\nrecorded debts (close or reopen by itemId as the thread warrants):\n${open.map((i) => `- (${i.id}) <#${i.venueId}>${i.threadRootId ? ` thread=${i.threadRootId}` : ""}: ${i.what}`).join("\n")}`
            : "";
                    status = (
            await runTurn({
              session,
              threadId,
              cwd: this.earWorkspace(),
              prompt: `${cards}${debts}`,
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
        // Judged or punted, these rows are the ear's past now — per conversation, so a held
        // room's judgment watermark can never be dragged forward by an unrelated batch.
        for (const c of convos) advanceJudged(this.d.db, this.d.clock, identityId, c, c.messages.at(-1)!.rowid);
      }
      if (status !== "succeeded") {
        // Fail-open (the design's sacred rule #2): a dead ear must cost nothing but the judgment —
        // the mind wakes for the batch exactly as it would have pre-ear.
        this.log.warn("ear pass did not succeed — failing open to a wake", { identityId, status });
        needWake = true;
      }
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
      // One room, one row: undelivered traffic arrives grouped by conversation, each with its
      // standing. Out-stance conversations hold their observed chatter back (her own recorded
      // choice, not a cheap-tier judgment); a mention re-engaged at ingest, so it always lands.
      const convos = pendingConversations(this.d.db, identityId);
      if (convos.length === 0) return;
      const pending = convos.flatMap((c) => c.messages).toSorted((a, b) => a.rowid - b.rowid);
      const wakeId = this.d.newId();
      const addressed = pending.filter((m) => m.kind === "addressed_message");
      // Direct addresses (mention/DM) alone carry the §14.2 duties: the failure fallback, the
      // answered gate, and the typing shimmer. Thread-follow is addressed for the ledger but
      // not spoken TO her — a dead wake over thread chatter fails into the log, never the room
      // (SPEC §18: "a thread-follow turn's failure is ledger/log-only").
      const direct = pending.filter(isDirectAddress);
      // Broker gating (guest checks) keys on the wake's most recent human addresser — policy,
      // not routing: no destination and no durable row derives from this pick. Everything that
      // lands somewhere (replies, reacts, cards, tasks, confirmations, the §14.2 fallback)
      // routes by ref or by the exact events owed (audit 2026-08-13: every seat this pick used
      // to feed misrouted live at least once).
      const gatingMsg = addressed.at(-1) ?? pending.at(-1)!;
      // One native streamed message PER CONVERSATION she speaks into (reply-stream.ts): the
      // stream for a conversation is created lazily at her first ref-addressed post there, so
      // the seat is always model-chosen. Checklist cards buffer inside their conversation's
      // stream until her first words materialize it — a plan box alone never posts and never
      // notifies (2026-07-20 live defect). The recipient is that conversation's own last human
      // speaker in the batch (a worker-report conversation has none; its stream fails open to
      // plain posts).
      const streams = new Map<string, ReplyStream>();
      const streamFor = (a: Anchor): ReplyStream => {
        const k = convoKey(a.venueId, a.threadRootId);
        let s = streams.get(k);
        if (!s) {
          const recipient =
            pending.toReversed().find((m) => m.principalId && convoKey(m.venueId ?? "", m.threadRootId ?? m.ts) === k)?.principalId ?? null;
          s = new ReplyStream({ adapter: this.d.adapter, venueId: a.venueId, threadTs: a.threadRootId, recipient, log: this.log });
          streams.set(k, s);
        }
        return s;
      };
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
      // Buffering is decided per CONVERSATION, not per wake: a reply into a conversation whose
      // batch carried a direct address posts immediately (the asker is owed the answer even if
      // the thread moves); a reply into any other conversation buffers for the staleness check
      // — even inside a mixed wake (the 2026-07-23 shape survived in mixed wakes until the
      // enforcement audit caught it: one mention anywhere used to disarm §5.5 everywhere).
      // Both anchors a direct message can be answered at: its thread (a reply ref), and — for a
      // top-level mention or DM — the venue surface itself (DMs answer top-level; withholding
      // there would leave the asker hanging and fire the §14.2 fallback over a written reply).
      const directConvos = new Set(
        direct.flatMap((m) => [convoKey(m.venueId ?? "", m.threadRootId ?? m.ts), ...(m.threadRootId ? [] : [convoKey(m.venueId ?? "", null)])]),
      );
      const bufferReply = (a: Anchor, text: string): boolean => {
        if (directConvos.has(convoKey(a.venueId, a.threadRootId))) return false;
        buffered.push({ anchor: a, text });
        return true;
      };
      const flushBuffered = async (turnStatus: TurnStatus): Promise<void> => {
        const toFlush = buffered.splice(0); // each retry attempt re-decides from scratch
        if (turnStatus !== "succeeded") return; // a dead wake's half-sent words never post (same rule as clearCards)
        for (const b of toFlush) {
          const moved = messagesAfter(this.d.db, identityId, batchTail).some(
            (m) =>
              m.kind === "addressed_message" &&
              (m.venueId ?? "") === b.anchor.venueId &&
              (b.anchor.threadRootId === null ? m.threadRootId === null : (m.threadRootId ?? m.ts) === b.anchor.threadRootId),
          );
          if (moved) {
            saveDraft(this.d.db, this.d.clock, identityId, b.anchor.venueId, b.anchor.threadRootId, b.text);
            effects.push({ kind: "withheld", anchor: b.anchor, text: b.text });
            continue;
          }
          const act = recordAct(this.d.db, this.d.clock, identityId, wakeId, { kind: "posted", venueId: b.anchor.venueId, threadRootId: b.anchor.threadRootId, ts: null, text: b.text });
          if (!act.inserted) continue; // an earlier attempt of this wake already sent it
          let result: { messageId: string };
          try {
            const streamedId = await streamFor(b.anchor).post(b.text);
            result = streamedId ? { messageId: streamedId } : await this.postMessage(b.anchor, b.text);
          } catch (e) {
            deleteAct(this.d.db, wakeId, act.actKey);
            throw e;
          }
          if (result.messageId === "undelivered") {
            // The turn is already over — nobody can be told. The buffered path owns a durable
            // home for unsent words: park it as a draft and the next wake re-decides.
            deleteAct(this.d.db, wakeId, act.actKey);
            saveDraft(this.d.db, this.d.clock, identityId, b.anchor.venueId, b.anchor.threadRootId, b.text);
            effects.push({ kind: "withheld", anchor: b.anchor, text: b.text });
            continue;
          }
          setActTs(this.d.db, wakeId, act.actKey, result.messageId, b.anchor.threadRootId ?? result.messageId);
          engage(this.d.db, this.d.clock, identityId, b.anchor.venueId, b.anchor.threadRootId ?? result.messageId);
          closeAttentionItemsForThread(this.d.db, this.d.clock, identityId, b.anchor.venueId, b.anchor.threadRootId ?? null, "answered in thread");
          effects.push({ kind: "posted", anchor: b.anchor, text: b.text });
        }
      };
      // §14.2 gate, PER CONVERSATION: a post or react into a conversation marks IT answered —
      // a wake that answered one asker before dying still owes the others their fallback (audit
      // 2026-08-13: one wake-scoped boolean let any answer anywhere silence every other owed
      // conversation, and the apology itself went to a batch-tail guess). Every insertion
      // co-occurs with a pushed effect (the same tool call records one): the retry loop's
      // effects-nonempty guard is what keeps a later attempt from seeing prior partial work as
      // its own.
      const answeredConvos = new Set<string>();
      // Built PER ATTEMPT (below): tool factories carry per-turn state (the reply tool's
      // step-back bounce). A retry is a fresh session that never saw a prior attempt's tool
      // results, so it must re-decide against re-armed tools — a bounce a dead attempt consumed
      // must not wave the next attempt through. Shared wake state (effects, streams,
      // answeredConvos, the checklist holder) lives out here and survives rebuilds.
      const checklist = new Map<string, string>();
      const makeTools = () => buildToolset({
        db: this.d.db,
        clock: this.d.clock,
        identity,
        turnKind: "resident",
        catalog: this.catalog,
        // No batch-level anchor exists to be reused: resident posting scope is venue-wide, and
        // every tool that needs a place gets it from a ref. principal serves broker gating only
        // — durable writes (task sponsor/origin, confirmation approver) bind to ref provenance.
        anchor: null,
        principal: this.principalOf(gatingMsg.principalId),
        resolvePrincipal: (id) => this.principalOf(id),
        nudgeAfterMs: this.policy().tasks.nudgeAfterMs,
        outwardScopeId: wakeId,
        permalink: (v, ts) => this.d.adapter.permalink?.(v, ts),
        postMessage: async (a, text) => {
          const act = recordAct(this.d.db, this.d.clock, identityId, wakeId, { kind: "posted", venueId: a.venueId, threadRootId: a.threadRootId, ts: null, text });
          if (!act.inserted) return { messageId: "already-sent-this-wake" }; // a retry attempt re-issuing the identical post is a no-op
          let result: { messageId: string };
          try {
            const streamedId = await streamFor(a).post(text);
            result = streamedId ? { messageId: streamedId } : await this.postMessage(a, text);
          } catch (e) {
            deleteAct(this.d.db, wakeId, act.actKey); // intent must not outlive a failed call
            throw e;
          }
          if (result.messageId === "undelivered") {
            // deliverPost exhausted its retries: nothing landed — no act, no engage, no ts.
            deleteAct(this.d.db, wakeId, act.actKey);
            return result;
          }
          // A top-level post homes its act into the thread it just rooted (engage keys on the
          // message id) — her opening message must render in that thread, not on the surface.
          setActTs(this.d.db, wakeId, act.actKey, result.messageId, a.threadRootId ?? result.messageId);
          engage(this.d.db, this.d.clock, identityId, a.venueId, a.threadRootId ?? result.messageId);
          answeredConvos.add(convoKey(a.venueId, a.threadRootId));
          // Optimistic close (ear design): answering in a thread settles its recorded debts the
          // moment the post lands — she never re-answers her own work. The ear can reopen.
          closeAttentionItemsForThread(this.d.db, this.d.clock, identityId, a.venueId, a.threadRootId ?? null, "answered in thread");
          return result;
        },
        updateMessage: this.d.adapter.updateMessage ? (v, m, t) => this.d.adapter.updateMessage!(v, m, t) : undefined,
        renderChecklist: async (items, seat) => streamFor(seat).setCards(items),
        // Reactions reach any delivered message by venue + ts (the values in her lines), and
        // carry the same bookkeeping a reply does — the §14.2 answered mark and the optimistic
        // attention close — for the conversation the ref target itself names: a react on a tail
        // line files into ITS thread, never a batch-derived one (audit 2026-08-13).
        reactTo: async (v, ts, emoji, threadRootId) => {
          // The act files at the target's OWN thread — null for a top-level line, whose acts
          // render on the venue-surface conversation (filing at its ts would hide them there).
          // The root key (thread it roots, for a top-level message) serves the §14.2 answered
          // mark and the attention close, which speak in conversation keys.
          const residence = threadRootId ?? ts;
          const act = recordAct(this.d.db, this.d.clock, identityId, wakeId, { kind: "reacted", venueId: v, threadRootId, ts, text: emoji });
          if (!act.inserted) return; // already reacted in an earlier attempt of this wake
          try {
            await this.d.adapter.addReaction(v, ts, emoji);
          } catch (e) {
            deleteAct(this.d.db, wakeId, act.actKey); // a failed call is not "already reacted"
            throw e;
          }
          answeredConvos.add(convoKey(v, residence));
          closeAttentionItemsForThread(this.d.db, this.d.clock, identityId, v, residence, "reacted in thread");
        },
        checklist,
        effects,
        // Addressing as capability: the wake's ref table is the ONLY source of speakable
        // targets. Refs minted by the renderer were read this turn; refs minted for drafts,
        // owed items, and search hits carry via='search' and bounce once with the card — a
        // PEEK, never delivery (it must not advance watermarks or consume judgment).
        refs,
        renderConversationCard: (target: { venueId: string; threadRootId: string | null }) =>
          renderConversation(this.d.db, identityId, target, {
            newMessages: [],
            judgment: getConversationJudgment(this.d.db, identityId, target.venueId, target.threadRootId) ?? undefined,
            stance: stanceOf(this.d.db, identityId, target.venueId, target.threadRootId),
            selfLabel: "you",
            beforeRowid: Number.MAX_SAFE_INTEGER,
            refs,
          }),
        bufferReply,
      });
      this.refreshSoul(); // a fresh thread must open with current memory + standing instructions
      // One room, one row: each conversation renders WHOLE through the one renderer — standing,
      // the ear's reads of the stretch being delivered, the tail with her own words inline,
      // then the new lines. Assembly PEEKS the judgment; the commit (consume + watermark, one
      // transaction per conversation) happens in the finally below, AFTER the wake — SPEC §11:
      // a process death mid-wake must re-deliver the batch, never lose it.
      const refs = makeRefTable();
      const rendered = convos
        .map((c) =>
          renderConversation(this.d.db, identityId, c, {
            newMessages: c.messages,
            mark: (m) => (isDirectAddress(m) ? "[to you] " : ""),
            judgment: getConversationJudgment(this.d.db, identityId, c.venueId, c.threadRootId) ?? undefined,
            stance: c.stance,
            selfLabel: "you",
            beforeRowid: c.messages[0]!.rowid - 1,
            refs,
          }),
        )
        .join("\n\n");
      // §5.5: a withheld reply surfaces to the immediately following wake — the model's own
      // words, reconsidered against the room as it now stands. Peeked here; consumed with the
      // delivery commit below, so a wake that dies returns them to the next one.
      const heldDrafts = peekDrafts(this.d.db, identityId);
      // Draft and owed targets were read in an EARLIER wake, not this one — their refs carry
      // via='search', so speaking there starts with the conversation's card (read, then send).
      const draftSection = heldDrafts.length
        ? `\n\n[drafted last wake but not sent — the conversation had moved on; decide fresh what (if anything) to say]\n${heldDrafts.map((d) => `- [${refs.mint({ venueId: d.venueId, threadRootId: d.threadRootId, via: "search" })}] to <#${d.venueId}>${d.threadRootId ? ` thread=${d.threadRootId}` : ""}: ${d.text}`).join("\n")}`
        : "";
      const owed = openItems(this.d.db, identityId);
      const owedSection = owed.length
        ? `\n\n[still owed]\n${owed
            .slice(0, ATTENTION_PROMPT_CAP)
            .map((i) => {
              const overdue = Date.parse(this.d.clock()) - Date.parse(i.openedAt) > ATTENTION_MAX_AGE_MS;
              return `- [${refs.mint({ venueId: i.venueId, threadRootId: i.threadRootId, via: "search" })}] <#${i.venueId}>${i.threadRootId ? ` thread=${i.threadRootId}` : ""}: ${i.what}${overdue ? " (open a long time — settle it or drop it)" : ""}`;
            })
            .join("\n")}${owed.length > ATTENTION_PROMPT_CAP ? `\n(+${owed.length - ATTENTION_PROMPT_CAP} newer ones not shown — they surface as these settle)` : ""}`
        : "";
      const prompt = `${rendered}${draftSection}${owedSection}`;
      let status: TurnStatus = "failed";
      // In-flight work finishes under the policy it started with (SPEC §16.2) — snapshot once.
      const turns = this.policy().turns;
      try {
        // §14.2: retry a dead wake with backoff up to turns.max_retries, a fresh runtime
        // session each time — but only while it has touched nothing; replaying a turn that
        // already acted would duplicate its effects.
        for (let attempt = 0; attempt <= turns.maxRetries; attempt++) {
          failureCause = "";
          const session = this.d.sessionFactory(makeTools(), (e) => {
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
              stallTimeoutMs: turns.stallTimeoutMs,
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
        // could answer. Honest, in the runtime's words when they read human. One fallback per
        // DISTINCT owed conversation, each anchored to its own coordinates — derived from the
        // exact addressed events, never a batch-tail pick (audit 2026-08-13: `direct.at(-1)`
        // apologized to one room and left the other asker hanging; any answer anywhere used to
        // silence all of them). A conversation counts answered at either of a direct's two
        // anchors: its thread, or — for a top-level mention/DM — the venue surface.
        if (status !== "succeeded" && direct.length > 0) {
          const owedRooms = new Map<string, { anchor: Anchor; aliases: string[] }>();
          for (const m of direct) {
            const anchor: Anchor = { venueId: m.venueId ?? "", threadRootId: m.threadRootId ?? m.ts };
            const k = convoKey(anchor.venueId, anchor.threadRootId);
            if (!owedRooms.has(k)) owedRooms.set(k, { anchor, aliases: [k, ...(m.threadRootId ? [] : [convoKey(anchor.venueId, null)])] });
          }
          const why = failureCause || (status === "timed_out" ? "it ran out of time" : "my agent runtime failed");
          const fallbackText = `can't run right now — ${why}. try me again, or flag the operator if it keeps up.`;
          for (const { anchor, aliases } of owedRooms.values()) {
            if (aliases.some((k) => answeredConvos.has(k))) continue;
            // The sole harness-authored words the room ever hears go through the same acts door
            // as everything outward: idempotent across restarts of the same wake, visible in her
            // own tail, never a post the ledger doesn't know about.
            const fallbackAct = recordAct(this.d.db, this.d.clock, identityId, wakeId, { kind: "posted", venueId: anchor.venueId, threadRootId: anchor.threadRootId, ts: null, text: fallbackText });
            if (fallbackAct.inserted) {
              await this.postMessage(anchor, fallbackText)
                .then((r) => (r.messageId === "undelivered" ? deleteAct(this.d.db, wakeId, fallbackAct.actKey) : setActTs(this.d.db, wakeId, fallbackAct.actKey, r.messageId)))
                .catch(() => deleteAct(this.d.db, wakeId, fallbackAct.actKey));
            }
          }
        }
      } finally {
        // Close every conversation's stream: a succeeded wake settles any still-pending cards
        // (Slack renders a pending card on a stopped stream as "Something went wrong"); a
        // failed wake drops buffered cards instead — a checked-off plan over a failure is a lie.
        for (const s of streams.values()) {
          if (status === "succeeded") s.settleCards();
          else s.clearCards();
          await s.close().catch(() => {});
        }
        // Delivery commits HERE, after the wake — done even when the turn failed (re-delivering
        // the same batch to a broken thread just loops the failure, observed live pre-collapse),
        // but never before it: a process death mid-wake leaves every watermark unadvanced and
        // the batch re-delivers on boot (SPEC §11). Each conversation commits its messages and
        // its judgment in one transaction — inseparable.
        for (const c of convos) consumeJudgment(this.d.db, this.d.clock, identityId, c, c.messages.at(-1)!.rowid);
        // Only the drafts THIS wake rendered, and only when the turn succeeded — a failed wake
        // returns them; the wake's own new withholds are untouched (they carry higher ids).
        if (status === "succeeded" && heldDrafts.length) markDraftsConsumed(this.d.db, this.d.clock, identityId, heldDrafts.map((d) => d.id));
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
      if (!this.stopping && (again || hasUndelivered(this.d.db, identityId))) this.runWake(identityId);
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
        return r;
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
      // A report identical to the task's previous one still lands durably in events (it rides
      // the next wake — nothing dangles) but does not FORCE a wake: a stuck task re-reporting
      // the same state cannot drag the mind out of bed for it. 2026-08-10 live: a task's
      // repeated identical "waiting on a human" wake was the one that posted stale into a
      // settled thread; the workflow measurement put this class as the largest wake driver.
      const prev = orm(this.d.db)
        .select({ text: sql<string | null>`json_extract(${events.payload}, '$.text')` })
        .from(events)
        .where(sql`${events.dedupKey} LIKE ${`worker:${taskId}:%`}`)
        .orderBy(desc(sql`${events}.rowid`))
        .limit(1)
        .get();
      orm(this.d.db)
        .insert(events)
        .values({
          id: this.d.newId(),
          dedupKey: `worker:${taskId}:${this.d.newId()}`,
          kind: "external_signal",
          identityId: task.identityId,
          venueId: task.homeAnchor.venueId,
          threadRootId: task.homeAnchor.threadRootId,
          principalId: null,
          payload: { text },
          receivedAt: this.d.clock(),
        })
        .run();
      if (prev?.text !== text) this.scheduleWake(task.identityId, 0);
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
        return { identity: i.id, facts: kept.map((m) => ({ content: m.content, asOf: m.lastConfirmedAt })), dropped: dropped.length };
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
              // A live resident wake always has a ref table, and several tools shape their
              // schema on its presence (checklist/task_confirm require ref) — the digest must
              // describe the schemas she will actually see.
              refs: makeRefTable(),
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
