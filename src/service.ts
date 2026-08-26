// Long-running service: boots once, drives ledger/scheduler/turns/adapter concurrently.
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
import { queryMemory, coreWithinBudget, decayRecentToArchive } from "./ledger/memory";
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
  recentIdenticalPost,
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

const ATTENTION_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const ATTENTION_PROMPT_CAP = 5;
// §14.2 restart-duplicate window: identical words from another wake → skip send, use landed id.
const POST_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

function isDirectAddress(message: InboxMessage): boolean {
  return message.addressMode === "mention" || message.addressMode === "dm";
}

export interface ServiceDeps {
  db: Database;
  clock: Clock;
  policyStore: PolicyStore;
  adapter: SurfaceAdapter;
  botPrincipalId: string;
  cwd: string; // workspace directory for codex sessions
  // Attention-pass workspace (its AGENTS.md); defaults to `${cwd}-ear`.
  earCwd?: string;
  sessionFactory: (tools: DynamicTool[], onEvent?: (agentEvent: AgentEvent) => void, overrides?: { model?: string; effort?: string }) => AgentRuntimeSession;
  newId: () => string; // unique ids for events / executions / turns
  catalog?: ToolCatalog; // external tool implementations (empty for the built-in-only default)
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
  private residentDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  private residentRunning = new Set<string>();
  private residentRerun = new Set<string>();
  private wakes = new Set<Promise<unknown>>();
  private executions = new Set<Promise<unknown>>();
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
    const recovery = recoverFromRestart(this.d.db, this.d.clock, {
      maxConsecutiveInterruptions: this.policy().executions.maxAttempts,
    });
    if (recovery.reopened.length > 0 || recovery.parked.length > 0) {
      this.log.info("restart recovery", { reopened: recovery.reopened, parked: recovery.parked });
    }
    this.refreshSoul();
    this.d.adapter.onMessage((msg) => {
      this.onInbound(msg);
    });
    await this.d.adapter.start();
    this.log.info("service started");
    for (const identity of this.policy().identities) {
      if (hasUndelivered(this.d.db, identity.id)) this.scheduleWake(identity.id, 1500);
      if (hasUnjudged(this.d.db, identity.id)) this.scheduleEar(identity.id);
    }
    if (this.d.heartbeatMs && this.d.heartbeatMs > 0) this.scheduleHeartbeat();
  }

  private scheduleHeartbeat(): void {
    if (this.stopping) return;
    const maxMs = this.d.heartbeatMs!;
    const sleep = msUntilNextTimer(this.d.db, this.d.clock, maxMs);
    this.heartbeat = setTimeout(() => {
      void this.tick()
        .catch((error: unknown) => {
          this.log.error("tick failed", { error: String(error) });
        })
        .finally(() => {
          this.scheduleHeartbeat();
        });
    }, sleep);
  }

  private maybeTick(): void {
    if (!this.stopping) {
      void this.tick().catch((error: unknown) => {
        this.log.error("tick failed", { error: String(error) });
      });
    }
  }

  async tick(): Promise<void> {
    if (this.stopping) return;
    // Drain legacy ambient/distillation timers (mark fired, no handler).
    fireDueTimers(this.d.db, this.d.clock, {
      parkAfterMs: this.policy().tasks.parkAfterMs,
    });

    const result = dispatchRunnable(this.d.db, this.d.clock, {
      maxConcurrentPerIdentity: this.policy().executions.maxConcurrentPerIdentity,
      maxConcurrentGlobal: this.policy().executions.maxConcurrentGlobal,
      newExecutionId: () => this.d.newId(),
    });
    for (const taskId of result.dispatched) this.launchExecution(taskId);

    // Periodic WAL checkpoint (single-writer process never auto-checkpoints on close).
    if (++this.ticksSinceCheckpoint >= 300) {
      this.ticksSinceCheckpoint = 0;
      try {
        checkpointWal(this.d.db);
      } catch (error) {
        this.log.warn("wal checkpoint failed", { error: String(error) });
      }
    }
  }

  async idle(): Promise<void> {
    while (true) {
      for (const [id, timeout] of this.earDebounce) {
        clearTimeout(timeout);
        this.earDebounce.delete(id);
        this.runEarPass(id);
      }
      for (const [id, timeout] of this.residentDebounce) {
        clearTimeout(timeout);
        this.residentDebounce.delete(id);
        this.runWake(id);
      }
      if (this.wakes.size === 0 && this.executions.size === 0) return;
      await Promise.allSettled([...this.wakes, ...this.executions]);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeat) clearTimeout(this.heartbeat);
    for (const timeout of this.residentDebounce.values()) clearTimeout(timeout);
    this.residentDebounce.clear();
    for (const timeout of this.earDebounce.values()) clearTimeout(timeout);
    this.earDebounce.clear();
    this.d.adapter.stop();
    await this.idle(); // let in-flight interactive turns + executions finish cleanly
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

  ingest(msg: import("@bevyl-ai/agent-tools").RawMessage): void {
    this.onInbound(msg);
  }

  wakeNow(identityId: string): void {
    this.runWake(identityId);
  }

  private onInbound(msg: import("@bevyl-ai/agent-tools").RawMessage): void {
    const result = routeMessage(this.d.db, this.d.clock, msg, {
      botPrincipalId: this.d.botPrincipalId,
      policy: this.policy(),
      newEventId: () => this.d.newId(),
      onUnboundVenue: (venueId) => {
        this.log.warn("message from unbound venue", { venueId });
      },
    });
    if (result.kind === "addressed") {
      if (result.event.addressMode !== "thread_follow") {
        this.showThinking(result.event.venueId, result.event.threadRootId ?? result.event.ts);
        this.scheduleWake(result.event.identityId, 0);
      }
      this.scheduleEar(result.event.identityId);
    } else if (result.kind === "observed") {
      this.scheduleEar(result.event.identityId);
    }
  }

  private identityById(id: string): IdentityConfig | undefined {
    return this.policy().identities.find((identity) => identity.id === id);
  }

  private principalOf(principalId: string | null): { id: string; isOperator: boolean } {
    return { id: principalId ?? "unknown", isOperator: this.policy().operatorPrincipals.includes(principalId ?? "") };
  }


  private postMessage(anchor: Anchor, text: string): Promise<{ messageId: string }> {
    return deliverPost(() => this.d.adapter.postMessage(anchor.venueId, anchor.threadRootId, text), {
      maxAttempts: 5,
      backoffMs: 500,
      maxBackoffMs: 30_000,
      onExhausted: (error) => {
        this.log.error("OUTBOUND DELIVERY FAILED — operator must convey this manually", { anchor, text, error: String(error) });
      },
    }).then((result) => result ?? { messageId: "undelivered" });
  }

  private showThinking(venueId: string, threadTs: string): void {
    void this.d.adapter
      .setTypingStatus?.(venueId, threadTs, "is thinking…", ["is thinking…", "is digging in…", "is working on it…", "is putting it together…"])
      .catch(() => {});
  }

  // This process never posts on its own; sole carve-out is the §14.2 addressed-turn fallback.

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


  private workspaceFor(identityId: string): string {
    const dir = join(this.d.cwd, identityId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private earWorkspace(): string {
    return this.d.earCwd ?? `${this.d.cwd}-ear`;
  }

  private earWorkspaceFor(identityId: string): string {
    const dir = join(this.earWorkspace(), identityId);
    mkdirSync(dir, { recursive: true });
    return dir;
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
      }, identity?.ambient.eventDebounceMs ?? 20_000),
    );
  }

  private refreshEarSoul(): void {
    try {
      for (const identity of this.policy().identities) {
        const { kept } = coreWithinBudget(queryMemory(this.d.db, identity.id, { tier: "core" }), this.policy().memory.coreCharBudget);
        const summary = { identity: identity.id, persona: identity.persona, facts: kept.map((memory) => memory.content) };
        writeFileSync(join(this.earWorkspaceFor(identity.id), "AGENTS.md"), composeEarInstructions(this.d.botPrincipalId, [summary]));
      }
    } catch (error) {
      this.log.warn("could not write ear soul (AGENTS.md) — ear runs on codex default voice", { error: String(error) });
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
          const rawArgs = isRecord(args) ? args : {};
          const decision = asString(rawArgs.decision);
          const why = asString(rawArgs.why);
          const ref = typeof rawArgs.ref === "string" ? rawArgs.ref : undefined;
          const itemId = typeof rawArgs.itemId === "string" ? rawArgs.itemId : undefined;
          const target = ref ? refs.get(ref) : undefined;
          if (ref && !target) {
            return { success: false, output: `"${ref}" is not a ref — copy the [rN] tag (like r3) from the start of the line you are judging; timestamps and channel ids are labels, not addresses` };
          }
          if ((decision === "hold" || decision === "wake") && !target) {
            return { success: false, output: `${decision} needs ref — the [rN] tag of a line in the conversation being judged, so the judgment lands on its row` };
          }
          const venueId = target?.venueId;
          const residenceRoot = target ? target.threadRootId : null;
          const askRoot = target ? (target.threadRootId ?? target.ts ?? null) : null;
          effects.push({ kind: "ear_verdict", decision, why, venueId, threadRootId: residenceRoot });
          if (decision === "hold") {
            if (venueId) recordHold(this.d.db, this.d.clock, identityId, venueId, residenceRoot, why);
          } else if (decision === "wake") {
            needWake = true;
            if (venueId) recordWakeWhy(this.d.db, this.d.clock, identityId, venueId, residenceRoot, why);
          } else if (decision === "open_ask") {
            if (!target || !venueId) {
              return { success: false, output: "open_ask needs ref — the [rN] tag of the ask itself (the message line), so the debt roots where its answer will land" };
            }
            openAttentionItem(this.d.db, this.d.clock, {
              id: this.d.newId(),
              identityId,
              venueId,
              threadRootId: askRoot,
              askTs: target.ts ?? null,
              what: why,
            });
          } else if (decision === "close_ask") {
            if (!itemId || !closeAttentionItem(this.d.db, this.d.clock, identityId, itemId, why)) return { success: false, output: "no open item with that id" };
          } else if (decision === "reopen_ask" && (!itemId || !reopenAttentionItem(this.d.db, identityId, itemId))) {
            return { success: false, output: "nothing to reopen with that id: either it does not exist, or the operator settled it and that stays settled" };
          }
          return { success: true, output: "noted" };
        },
      };
      let status: TurnStatus = "failed";
      try {
        this.refreshEarSoul();
        const session = this.d.sessionFactory([verdictTool], (agentEvent) => {
          if (agentEvent.log) this.log.info("ear", { line: agentEvent.log });
        }, this.policy().models.low);
        try {
          await session.start(this.earWorkspaceFor(identityId));
          const threadId = await session.startThread(this.earWorkspaceFor(identityId)); // fresh every pass — an observer never accumulates
          const cards = convos
            .map((convo) =>
              renderConversation(this.d.db, identityId, convo, {
                newMessages: convo.messages,
                mark: (message) => (isDirectAddress(message) ? "[she was woken for this] " : message.addressMode === "thread_follow" ? "[a thread she is part of] " : ""),
                judgment: getConversationJudgment(this.d.db, identityId, convo.venueId, convo.threadRootId) ?? undefined,
                stance: convo.stance,
                selfLabel: "she",
                beforeRowid: convo.messages[0]!.rowid - 1,
                refs,
              }),
            )
            .join("\n\n");
          const debts = open.length > 0
            ? `\n\nrecorded debts (close or reopen by itemId as the thread warrants):\n${open.map((item) => `- (${item.id}) <#${item.venueId}>${item.threadRootId ? ` thread=${item.threadRootId}` : ""}: ${item.what}`).join("\n")}`
            : "";
                    status = (
            await runTurn({
              session,
              threadId,
              cwd: this.earWorkspaceFor(identityId),
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
      } catch (error) {
        this.log.error("ear pass threw", { identityId, error: String(error) });
      } finally {
        // Per-conversation judged watermark — unrelated batches must not advance it.
        for (const convo of convos) advanceJudged(this.d.db, this.d.clock, identityId, convo, convo.messages.at(-1)!.rowid);
      }
      if (status !== "succeeded") {
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
      const convos = pendingConversations(this.d.db, identityId);
      if (convos.length === 0) return;
      const pending = convos.flatMap((convo) => convo.messages).toSorted((a, b) => a.rowid - b.rowid);
      const wakeId = this.d.newId();
      const addressed = pending.filter((message) => message.kind === "addressed_message");
      // §14.2 duties (fallback, answered gate, typing) only for mention/DM, not thread-follow.
      const direct = pending.filter((message) => isDirectAddress(message));
      const gatingMsg = addressed.at(-1) ?? pending.at(-1)!;
      const streams = new Map<string, ReplyStream>();
      const streamFor = (anchor: Anchor): ReplyStream => {
        const convoKeyStr = convoKey(anchor.venueId, anchor.threadRootId);
        let stream = streams.get(convoKeyStr);
        if (!stream) {
          const recipient =
            pending.toReversed().find((message) => message.principalId && convoKey(message.venueId ?? "", message.threadRootId ?? message.ts) === convoKeyStr)?.principalId ?? null;
          stream = new ReplyStream({ adapter: this.d.adapter, venueId: anchor.venueId, threadTs: anchor.threadRootId, recipient, log: this.log });
          streams.set(convoKeyStr, stream);
        }
        return stream;
      };
      const effects: unknown[] = [];
      let failureCause = "";
      // §5.5: no direct address → buffer replies until turn end; withhold if newer addressed traffic.
      const batchTail = pending.at(-1)!.rowid;
      const buffered: { anchor: Anchor; text: string }[] = [];
      const directConvos = new Set(
        direct.flatMap((message) => [convoKey(message.venueId ?? "", message.threadRootId ?? message.ts), ...(message.threadRootId ? [] : [convoKey(message.venueId ?? "", null)])]),
      );
      const bufferReply = (anchor: Anchor, text: string): boolean => {
        if (directConvos.has(convoKey(anchor.venueId, anchor.threadRootId))) return false;
        buffered.push({ anchor, text });
        return true;
      };
      const flushBuffered = async (turnStatus: TurnStatus): Promise<void> => {
        const toFlush = buffered.splice(0); // each retry attempt re-decides from scratch
        if (turnStatus !== "succeeded") return; // a dead wake's half-sent words never post (same rule as clearCards)
        for (const pendingReply of toFlush) {
          const moved = messagesAfter(this.d.db, identityId, batchTail).some(
            (message) =>
              message.kind === "addressed_message" &&
              (message.venueId ?? "") === pendingReply.anchor.venueId &&
              (pendingReply.anchor.threadRootId === null ? message.threadRootId === null : (message.threadRootId ?? message.ts) === pendingReply.anchor.threadRootId),
          );
          if (moved) {
            saveDraft(this.d.db, this.d.clock, identityId, pendingReply.anchor.venueId, pendingReply.anchor.threadRootId, pendingReply.text);
            effects.push({ kind: "withheld", anchor: pendingReply.anchor, text: pendingReply.text });
            continue;
          }
          const act = recordAct(this.d.db, this.d.clock, identityId, wakeId, { kind: "posted", venueId: pendingReply.anchor.venueId, threadRootId: pendingReply.anchor.threadRootId, ts: null, text: pendingReply.text });
          if (!act.inserted) continue; // an earlier attempt of this wake already sent it
          if (recentIdenticalPost(this.d.db, this.d.clock, identityId, pendingReply.anchor.venueId, pendingReply.anchor.threadRootId, pendingReply.text, wakeId, POST_DEDUPE_WINDOW_MS, { unlessNewerEventArrived: true })) {
            deleteAct(this.d.db, wakeId, act.actKey); // a prior wake landed these exact words (§14.2 restart-duplicate)
            answeredConvos.add(convoKey(pendingReply.anchor.venueId, pendingReply.anchor.threadRootId));
            continue;
          }
          let result: { messageId: string };
          try {
            const streamedId = await streamFor(pendingReply.anchor).post(pendingReply.text);
            result = streamedId ? { messageId: streamedId } : await this.postMessage(pendingReply.anchor, pendingReply.text);
          } catch (error) {
            deleteAct(this.d.db, wakeId, act.actKey);
            throw error;
          }
          if (result.messageId === "undelivered") {
            deleteAct(this.d.db, wakeId, act.actKey);
            saveDraft(this.d.db, this.d.clock, identityId, pendingReply.anchor.venueId, pendingReply.anchor.threadRootId, pendingReply.text);
            effects.push({ kind: "withheld", anchor: pendingReply.anchor, text: pendingReply.text });
            continue;
          }
          setActTs(this.d.db, wakeId, act.actKey, result.messageId, pendingReply.anchor.threadRootId ?? result.messageId);
          engage(this.d.db, this.d.clock, identityId, pendingReply.anchor.venueId, pendingReply.anchor.threadRootId ?? result.messageId);
          closeAttentionItemsForThread(this.d.db, this.d.clock, identityId, pendingReply.anchor.venueId, pendingReply.anchor.threadRootId ?? null, "answered in thread");
          effects.push({ kind: "posted", anchor: pendingReply.anchor, text: pendingReply.text });
        }
      };
      // §14.2 answered gate is per conversation, not wake-scoped.
      const answeredConvos = new Set<string>();
      const checklist = new Map<string, string>();
      const makeTools = () => buildToolset({
        db: this.d.db,
        clock: this.d.clock,
        identity,
        turnKind: "resident",
        catalog: this.catalog,
        anchor: null,
        principal: this.principalOf(gatingMsg.principalId),
        resolvePrincipal: (id) => this.principalOf(id),
        nudgeAfterMs: this.policy().tasks.nudgeAfterMs,
        outwardScopeId: wakeId,
        permalink: (venueId, ts) => this.d.adapter.permalink?.(venueId, ts),
        postMessage: async (anchor, text) => {
          const act = recordAct(this.d.db, this.d.clock, identityId, wakeId, { kind: "posted", venueId: anchor.venueId, threadRootId: anchor.threadRootId, ts: null, text });
          if (!act.inserted) return { messageId: "already-sent-this-wake" }; // a retry attempt re-issuing the identical post is a no-op
          const landed = recentIdenticalPost(this.d.db, this.d.clock, identityId, anchor.venueId, anchor.threadRootId, text, wakeId, POST_DEDUPE_WINDOW_MS, { unlessNewerEventArrived: true });
          if (landed) {
            deleteAct(this.d.db, wakeId, act.actKey); // first wake's act already carries the words in the tail
            answeredConvos.add(convoKey(anchor.venueId, anchor.threadRootId));
            return { messageId: "already-landed" };
          }
          let result: { messageId: string };
          try {
            const streamedId = await streamFor(anchor).post(text);
            result = streamedId ? { messageId: streamedId } : await this.postMessage(anchor, text);
          } catch (error) {
            deleteAct(this.d.db, wakeId, act.actKey); // intent must not outlive a failed call
            throw error;
          }
          if (result.messageId === "undelivered") {
            deleteAct(this.d.db, wakeId, act.actKey);
            return result;
          }
          setActTs(this.d.db, wakeId, act.actKey, result.messageId, anchor.threadRootId ?? result.messageId);
          engage(this.d.db, this.d.clock, identityId, anchor.venueId, anchor.threadRootId ?? result.messageId);
          answeredConvos.add(convoKey(anchor.venueId, anchor.threadRootId));
          closeAttentionItemsForThread(this.d.db, this.d.clock, identityId, anchor.venueId, anchor.threadRootId ?? null, "answered in thread");
          return result;
        },
        updateMessage: this.d.adapter.updateMessage ? (venueId, messageId, text) => this.d.adapter.updateMessage!(venueId, messageId, text) : undefined,
        renderChecklist: async (items, seat) => streamFor(seat).setCards(items),
        // React carries §14.2 answered mark + optimistic attention close for the target's conversation.
        reactTo: async (venueId, ts, emoji, threadRootId) => {
          const residence = threadRootId ?? ts;
          const act = recordAct(this.d.db, this.d.clock, identityId, wakeId, { kind: "reacted", venueId, threadRootId, ts, text: emoji });
          if (!act.inserted) return; // already reacted in an earlier attempt of this wake
          try {
            await this.d.adapter.addReaction(venueId, ts, emoji);
          } catch (error) {
            deleteAct(this.d.db, wakeId, act.actKey); // a failed call is not "already reacted"
            throw error;
          }
          answeredConvos.add(convoKey(venueId, residence));
          closeAttentionItemsForThread(this.d.db, this.d.clock, identityId, venueId, residence, "reacted in thread");
        },
        checklist,
        effects,
        // via='search' refs bounce once with the card (peek — must not advance watermarks).
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
      // Peek judgment during assembly; commit consume+watermark in finally after the wake (re-deliver on crash).
      const refs = makeRefTable();
      const rendered = convos
        .map((convo) =>
          renderConversation(this.d.db, identityId, convo, {
            newMessages: convo.messages,
            mark: (message) => (isDirectAddress(message) ? "[to you] " : ""),
            judgment: getConversationJudgment(this.d.db, identityId, convo.venueId, convo.threadRootId) ?? undefined,
            stance: convo.stance,
            selfLabel: "you",
            beforeRowid: convo.messages[0]!.rowid - 1,
            refs,
          }),
        )
        .join("\n\n");
      // §5.5 withheld replies surface on the next wake; via='search' so speak starts with the card.
      const heldDrafts = peekDrafts(this.d.db, identityId);
      const draftSection = heldDrafts.length > 0
        ? `\n\n[drafted last wake but not sent — the conversation had moved on; decide fresh what (if anything) to say]\n${heldDrafts.map((draft) => `- [${refs.mint({ venueId: draft.venueId, threadRootId: draft.threadRootId, via: "search" })}] to <#${draft.venueId}>${draft.threadRootId ? ` thread=${draft.threadRootId}` : ""}: ${draft.text}`).join("\n")}`
        : "";
      const owed = openItems(this.d.db, identityId);
      const owedSection = owed.length > 0
        ? `\n\n[still owed]\n${owed
            .slice(0, ATTENTION_PROMPT_CAP)
            .map((item) => {
              const overdue = Date.parse(this.d.clock()) - Date.parse(item.openedAt) > ATTENTION_MAX_AGE_MS;
              return `- [${refs.mint({ venueId: item.venueId, threadRootId: item.threadRootId, via: "search" })}] <#${item.venueId}>${item.threadRootId ? ` thread=${item.threadRootId}` : ""}: ${item.what}${overdue ? " (open a long time — settle it or drop it)" : ""}`;
            })
            .join("\n")}${owed.length > ATTENTION_PROMPT_CAP ? `\n(+${owed.length - ATTENTION_PROMPT_CAP} newer ones not shown — they surface as these settle)` : ""}`
        : "";
      const prompt = `${rendered}${draftSection}${owedSection}`;
      let status: TurnStatus = "failed";
      // Snapshot policy once — in-flight work finishes under the policy it started with.
      const turns = this.policy().turns;
      const onResidentEvent = (agentEvent: AgentEvent) => {
        if (agentEvent.event === "turn_failed" && agentEvent.log) failureCause = agentEvent.log;
        if (agentEvent.log) this.log.info("codex", { line: agentEvent.log });
      };
      try {
        // §14.2: retry a dead wake (fresh session) only while it has touched nothing.
        for (let attempt = 0; attempt <= turns.maxRetries; attempt++) {
          failureCause = "";
          const session = this.d.sessionFactory(makeTools(), onResidentEvent);
          try {
            await session.start(this.workspaceFor(identityId));
            const threadId = await session.startThread(this.workspaceFor(identityId));
            const result = await runTurn({
              session,
              threadId,
              cwd: this.workspaceFor(identityId),
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
          } catch (error) {
            status = "failed";
            failureCause = error instanceof Error ? error.message : String(error);
          } finally {
            session.stop();
          }
          if (status === "succeeded") break;
          this.log.error("resident wake attempt did not succeed", { identityId, attempt, status, cause: failureCause });
          if (effects.length > 0) break;
          if (attempt < turns.maxRetries) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, turns.backoffMs * 2 ** attempt);
            });
          }
        }
        // §14.2 carve-out: direct address and model died before answering → post fallback.
        if (status !== "succeeded" && direct.length > 0) {
          const owedConvos = new Map<string, { anchor: Anchor; aliases: string[] }>();
          for (const message of direct) {
            const anchor: Anchor = { venueId: message.venueId ?? "", threadRootId: message.threadRootId ?? message.ts };
            const convoKeyStr = convoKey(anchor.venueId, anchor.threadRootId);
            if (!owedConvos.has(convoKeyStr)) owedConvos.set(convoKeyStr, { anchor, aliases: [convoKeyStr, ...(message.threadRootId ? [] : [convoKey(anchor.venueId, null)])] });
          }
          const why = failureCause || (status === "timed_out" ? "it ran out of time" : "my agent runtime failed");
          const fallbackText = `can't run right now — ${why}. try me again, or flag the operator if it keeps up.`;
          for (const { anchor, aliases } of owedConvos.values()) {
            if (aliases.some((alias) => answeredConvos.has(alias))) continue;
            const fallbackAct = recordAct(this.d.db, this.d.clock, identityId, wakeId, { kind: "posted", venueId: anchor.venueId, threadRootId: anchor.threadRootId, ts: null, text: fallbackText });
            if (fallbackAct.inserted && recentIdenticalPost(this.d.db, this.d.clock, identityId, anchor.venueId, anchor.threadRootId, fallbackText, wakeId, POST_DEDUPE_WINDOW_MS, { unlessNewerEventArrived: false })) {
              deleteAct(this.d.db, wakeId, fallbackAct.actKey); // a crash-looping boot must not stack apologies
            } else if (fallbackAct.inserted) {
              try {
                const result = await this.postMessage(anchor, fallbackText);
                if (result.messageId === "undelivered") deleteAct(this.d.db, wakeId, fallbackAct.actKey);
                else setActTs(this.d.db, wakeId, fallbackAct.actKey, result.messageId);
              } catch {
                deleteAct(this.d.db, wakeId, fallbackAct.actKey);
              }
            }
          }
        }
      } finally {
        for (const stream of streams.values()) {
          if (status === "succeeded") stream.settleCards();
          else if (stream.opened) stream.failCards();
          else stream.clearCards();
          await stream.close().catch(() => {});
        }
        // Commit consume+watermark after the wake; crash mid-wake re-delivers the batch.
        for (const convo of convos) consumeJudgment(this.d.db, this.d.clock, identityId, convo, convo.messages.at(-1)!.rowid);
        if (status === "succeeded" && heldDrafts.length > 0) markDraftsConsumed(this.d.db, this.d.clock, identityId, heldDrafts.map((draft) => draft.id));
        for (const message of direct) {
          void this.d.adapter.setTypingStatus?.(message.venueId ?? "", message.threadRootId ?? message.ts ?? "", "").catch(() => {});
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

    const tierCfg = this.policy().models[task.tier] ?? {};
    this.refreshSoul(); // worker threads read AGENTS.md too — memory and standing instructions
    const promise = runExecution({
      db: this.d.db,
      clock: this.d.clock,
      taskId,
      executionId,
      identity,
      catalog: this.catalog,
      cwd: this.workspaceFor(identity.id),
      nudgeAfterMs: this.policy().tasks.nudgeAfterMs,
      permalink: (venueId: string, ts: string) => this.d.adapter.permalink?.(venueId, ts),
      maxTurns: this.policy().executions.maxTurns,
      maxTurnsBackoffMs: this.policy().executions.backoffMs,
      maxConsecutiveInterruptions: this.policy().executions.maxAttempts,
      stallTimeoutMs: this.policy().executions.stallTimeoutMs,
      postMessage: async (anchor, text) => {
        this.log.warn("worker attempted to post — dropped (workers report to the mind)", { taskId, venueId: anchor.venueId, chars: text.length });
        return { messageId: "worker-no-post" };
      },
      buildPrompt: (turnNumber, guidance, tools) => {
        const spec = getTask(this.d.db, taskId)?.spec ?? "";
        const note = guidance.length > 0 ? `\n\nNew guidance:\n${guidance.join("\n")}` : "";
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
      .then((result) => {
        this.log.info("execution finished", { taskId, outcome: result.outcome, turnsRun: result.turnsRun, tier: task.tier });
        this.deliverWorkerReport(taskId, result.outcome);
        return result;
      })
      .catch((error: unknown) => {
        this.log.error("execution threw", { taskId, error: String(error) });
        this.deliverWorkerReport(taskId, "failed");
      })
      .finally(() => {
        this.maybeTick();
      });

    this.track(this.executions, promise);
  }

  private deliverWorkerReport(taskId: string, outcome: ExecutionOutcome): void {
    const task = getTask(this.d.db, taskId);
    if (!task) return;
    if (outcome === "yielded" && task.waitingOn === "timer") return; // silent check-in
    if (outcome === "cancelled") return; // already cancelled — resident already knows
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
    } catch (error) {
      this.log.error("worker report delivery failed", { taskId, error: String(error) });
    }
  }

  private refreshSoul(): void {
    try {
      for (const identity of this.policy().identities) {
        const decayed = decayRecentToArchive(this.d.db, this.d.clock, identity.id, this.policy().memory.recentMaxAgeMs);
        if (decayed.length > 0) this.log.info("recent memory decayed to archive (§8.6)", { identityId: identity.id, decayed: decayed.length });
        const { kept, dropped } = coreWithinBudget(queryMemory(this.d.db, identity.id, { tier: "core" }), this.policy().memory.coreCharBudget);
        if (dropped.length > 0) this.log.warn("core memory over budget — items truncated from the soul (§8.6 hygiene defect)", { identityId: identity.id, dropped: dropped.length });
        const recent = coreWithinBudget(queryMemory(this.d.db, identity.id, { tier: "recent" }), this.policy().memory.recentCharBudget);
        const knowledge = {
          identity: identity.id,
          facts: kept.map((memory) => ({ content: memory.content, asOf: memory.lastConfirmedAt })),
          dropped: dropped.length,
          recent: recent.kept.map((memory) => ({ content: memory.content, asOf: memory.lastConfirmedAt })),
        };
        const standing = { identity: identity.id, venues: identity.venueInstructions };
        const digest = renderToolbox(
          buildToolbox(
            buildToolset({
              db: this.d.db,
              clock: this.d.clock,
              identity,
              turnKind: "resident",
              catalog: this.catalog,
              anchor: null,
              nudgeAfterMs: 0,
              postMessage: async () => ({ messageId: "digest-probe" }),
              refs: makeRefTable(),
              effects: [],
            }),
            this.registries,
          ),
          "", // the section heading above carries the framing
        );
        const path = join(this.workspaceFor(identity.id), "AGENTS.md");
        writeFileSync(path, composeInstructions(identity.persona ? [identity.persona] : [], [knowledge], [standing], [{ identity: identity.id, digest }]));
        this.log.info("soul written", { path, identity: identity.id, knowledgeItems: knowledge.facts.length, recentItems: knowledge.recent.length });
      }
    } catch (error) {
      this.log.warn("could not write soul (AGENTS.md) — using codex default voice", { error: String(error) });
    }
  }

  private track(set: Set<Promise<unknown>>, promise: Promise<unknown>): void {
    set.add(promise);
    void promise.finally(() => {
      set.delete(promise);
    });
  }
}
