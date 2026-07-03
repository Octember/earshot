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
import {
  getTask,
  liveExecutionId,
  ledgerView,
  type Anchor,
} from "./ledger/tasks";
import {
  fireDueTimers,
  dispatchRunnable,
  recoverFromRestart,
  msUntilNextTimer,
  scheduleDistillationTick,
  scheduleAmbientTick,
} from "./ledger/scheduler";
import { bufferedObservedMessages } from "./ledger/ambient";
import { queryMemory } from "./ledger/memory";
import { checkpointWal } from "./ledger/db";
import { runExecution } from "./turn-runner/execution-loop";
import { runTurn } from "./turn-runner/turn";
import { buildToolset } from "./turn-runner/toolset";
import { composeInstructions } from "./turn-runner/soul";
import { getConversationThread, setConversationThread } from "./ledger/continuity";
import { deliverPost } from "./adapter/outbound";
import { routeMessage, type Event } from "./adapter/router";
import { TurnAdmission, type AnchorKey } from "./adapter/turn-admission";
import type { SurfaceAdapter } from "./adapter/types";
import type { AgentRuntimeSession, DynamicTool, AgentEvent } from "./turn-runner/types";
import type { PolicyStore } from "./policy/load";
import type { Policy, IdentityConfig } from "./policy/schema";
import type { ToolCatalog } from "./policy/broker";
import { createLogger, type Logger } from "./log";

// Split reply text into word-boundary pieces of roughly `size` chars — appended sequentially they
// give the streamed-in feel (each append is its own HTTP call, so pacing comes for free).
function chunkText(text: string, size: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const cut = rest.lastIndexOf(" ", size);
    const at = cut > size / 2 ? cut + 1 : size; // no nearby space → hard cut
    pieces.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest) pieces.push(rest);
  return pieces;
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
  sessionFactory: (tools: DynamicTool[], onEvent?: (e: AgentEvent) => void) => AgentRuntimeSession;
  newId: () => string; // unique ids for events / executions / turns
  catalog?: ToolCatalog; // external tool implementations (empty for the built-in-only default)
  logger?: Logger;
  heartbeatMs?: number; // if set, start() runs a real interval; omit to drive tick() manually
}

export class Service {
  private readonly d: ServiceDeps;
  private readonly log: Logger;
  private readonly catalog: ToolCatalog;
  private admission: TurnAdmission;
  private heartbeat: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private ticksSinceCheckpoint = 0;
  // Per-identity high-water mark for distillation: observed messages received after this were not
  // yet swept into memory. In-memory (resets to epoch on restart → a re-sweep, which the model
  // dedupes against existing memory); good enough for a homebrew single-operator deploy.
  private lastDistilledAt = new Map<string, string>();
  private lastAmbientAt = new Map<string, string>();
  // In-flight work, tracked for graceful shutdown (§14.2 leaves nothing dangling, but a clean
  // drain avoids needless interrupted-execution churn on the next boot).
  private executions = new Set<Promise<unknown>>();
  private interactiveTurns = new Set<Promise<unknown>>();

  constructor(deps: ServiceDeps) {
    this.d = deps;
    this.log = deps.logger ?? createLogger();
    this.catalog = deps.catalog ?? {};
    this.admission = new TurnAdmission({
      maxConcurrentInteractive: this.policy().turns.maxConcurrentInteractive,
      ackTimeoutMs: this.policy().turns.ackTimeoutMs,
      ackIfSlow: (_id, _anchor, events) => this.ackSlow(events),
      runInteractiveTurn: (identityId, anchor, events) => this.runInteractiveTurn(identityId, anchor, events),
    });
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
    // (1b) write tag's "soul doc" to the workspace AGENTS.md — codex loads it as standing
    // instructions for every turn (its native system-prompt seam). This is where tag's CHARACTER
    // comes from; each identity's `persona` extends it. Best-effort: a write failure must not stop
    // the daemon (it just falls back to codex's default voice).
    try {
      const personas = this.policy().identities.map((i) => i.persona ?? "").filter((p) => p);
      writeFileSync(join(this.d.cwd, "AGENTS.md"), composeInstructions(personas));
      this.log.info("soul written", { path: join(this.d.cwd, "AGENTS.md"), personas: personas.length });
    } catch (e) {
      this.log.warn("could not write soul (AGENTS.md) — using codex default voice", { error: String(e) });
    }
    // (2) wire inbound + start the surface.
    this.d.adapter.onMessage((msg) => this.onInbound(msg));
    await this.d.adapter.start();
    this.log.info("service started");
    // (2b) arm the per-identity distillation cadence (§8.2) so observed messages get swept into
    // memory on a schedule. The first tick fires one cadence from now.
    const cadence = this.policy().memory.distillationCadenceMs;
    for (const identity of this.policy().identities) {
      this.lastDistilledAt.set(identity.id, "1970-01-01T00:00:00Z"); // first sweep covers all undistilled
      scheduleDistillationTick(this.d.db, this.d.clock, identity.id, cadence);
      // (2c) arm the per-identity ambient tick (§9.1) — but only for identities that actually have
      // ambient-enabled venues, so a non-proactive identity never wakes a speak-only turn.
      if (identity.ambient.enabledVenues.length > 0) {
        scheduleAmbientTick(this.d.db, this.d.clock, identity.id, identity.ambient.tickIntervalMs);
      }
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
      distillationCadenceMs: this.policy().memory.distillationCadenceMs, // re-arms the next tick
      onDistillationDue: (identityId) => this.runDistillation(identityId),
      // Left undefined so the scheduler does NOT re-arm with a single global cadence — ambient
      // intervals are per-identity, so runAmbient re-arms each identity with its own tick_interval.
      ambientTickCadenceMs: undefined,
      onAmbientTickDue: (identityId) => this.runAmbient(identityId),
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
  // that work spawned while draining is also awaited.
  async idle(): Promise<void> {
    while (this.interactiveTurns.size || this.executions.size) {
      await Promise.allSettled([...this.interactiveTurns, ...this.executions]);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
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
  ingest(msg: import("./adapter/types").RawMessage): void {
    this.onInbound(msg);
  }

  // Run a distillation sweep for an identity immediately (off its cadence). For self-tests /
  // operators who want to force a memory sweep now. Returns the in-flight promise via idle().
  distillNow(identityId: string): void {
    this.runDistillation(identityId);
  }

  // Run an ambient/proactive turn for an identity immediately (off its tick). Does NOT re-arm the
  // schedule — for self-tests / operators who want to trigger a speak-only sweep now.
  ambientNow(identityId: string): void {
    this.runAmbient(identityId, false);
  }

  // --- inbound ---
  private onInbound(msg: import("./adapter/types").RawMessage): void {
    const result = routeMessage(this.d.db, this.d.clock, msg, {
      botPrincipalId: this.d.botPrincipalId,
      policy: this.policy(),
      newEventId: () => this.d.newId(),
      onUnboundVenue: (venueId) => this.log.warn("message from unbound venue", { venueId }),
    });
    if (result.kind === "addressed") {
      this.admission.enqueue(result.event.identityId, { venueId: result.event.venueId, threadRootId: result.event.threadRootId }, result.event);
    }
    // observed → already persisted by the router for the ambient/distillation buffer; nothing to
    // launch. ignored_self / unbound_venue / duplicate → nothing.
  }

  private ackSlow(events: Event[]): void {
    const event = events[events.length - 1];
    if (event) void this.d.adapter.addReaction(event.venueId, event.ts, "eyes").catch(() => {});
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
  // the post silently (§12.3 "no dangling threads outranks tidiness"). Returns a sentinel id on
  // final failure so the turn still completes — the ledger transition already happened; the
  // operator alert is the escape hatch for manually conveying an undelivered terminal report.
  private postMessage(anchor: Anchor, text: string): Promise<{ messageId: string }> {
    return deliverPost(() => this.d.adapter.postMessage(anchor.venueId, anchor.threadRootId, text), {
      maxAttempts: 5,
      backoffMs: 500,
      maxBackoffMs: 30_000,
      onExhausted: (error) => this.log.error("OUTBOUND DELIVERY FAILED — operator must convey this manually", { anchor, text, error: String(error) }),
    }).then((r) => r ?? { messageId: "undelivered" });
  }

  // --- interactive turns ---
  private async runInteractiveTurn(identityId: string, anchor: AnchorKey, events: Event[]): Promise<void> {
    const promise = (async () => {
      const identity = this.identityById(identityId);
      if (!identity) return;
      const event = events[events.length - 1]!; // origin = latest event in the batch
      const effects: unknown[] = [];
      const anchorObj = { venueId: anchor.venueId, threadRootId: anchor.threadRootId };
      const prompt =
        events.length === 1
          ? event.text
          : `Multiple messages arrived together; address them all:\n${events.map((e) => `- ${e.text}`).join("\n")}`;

      // Reply delivery is native Slack streaming (chat.startStream/appendStream/stopStream): the
      // real in-channel UX — the message shows Slack's native "thinking" shimmer the moment the
      // stream opens (streaming_state, before any content), live task cards while codex works, then
      // the answer streaming in. Streaming requires a thread, so the reply streams into the
      // conversation's thread — the mention's thread, or a fresh thread under a top-level mention.
      const convoThreadTs = anchor.threadRootId ?? event.ts;
      const recipient = event.principalId;
      // The fancy "Bevelina is thinking…" shimmer: assistant.threads.setStatus works on regular
      // channel threads for agent apps (probed live), with rotating loading lines. Set the instant
      // the turn starts. The stream itself opens LAZILY at first real content — an open-but-empty
      // stream renders a literal italic "Thinking…" placeholder bubble, exactly what we don't want.
      void this.d.adapter
        .setTypingStatus?.(anchorObj.venueId, convoThreadTs, "is thinking…", ["is thinking…", "is digging in…", "is working on it…", "is putting it together…"])
        .catch(() => {});
      let streamMsg: { messageId: string } | null = null;
      let streamFailed = false;
      const ensureStream = async (): Promise<{ messageId: string } | null> => {
        if (streamMsg || streamFailed || !recipient || !this.d.adapter.startStream) return streamMsg;
        for (let attempt = 0; attempt < 2 && !streamMsg; attempt++) {
          try {
            streamMsg = await this.d.adapter.startStream(anchorObj.venueId, convoThreadTs, recipient);
          } catch (e) {
            this.log.warn("chat.startStream threw", { attempt, venueId: anchorObj.venueId, threadTs: convoThreadTs, error: String(e) });
          }
        }
        if (!streamMsg) {
          streamFailed = true;
          this.log.warn("no reply stream — delivering via plain post", { venueId: anchorObj.venueId, threadTs: convoThreadTs });
        }
        return streamMsg;
      };

      // All appends (text + task cards) are serialized through one queue so they land in order and
      // never race.
      let queue: Promise<void> = Promise.resolve();
      const enqueue = (fn: () => Promise<void>) => {
        queue = queue.then(fn, fn);
      };
      // Live task cards: each codex tool call ("⚙ read_channel") becomes an in_progress task card,
      // completed when the next one starts or the final answer arrives — Slack renders the timeline.
      let taskSeq = 0;
      let openTask: string | null = null;
      const taskTitles = new Map<string, string>();
      const taskCard = (title: string, status: "in_progress" | "complete", id?: string) => {
        if (!this.d.adapter.appendTaskUpdate) return id ?? null;
        const taskId = id ?? `t${++taskSeq}`;
        enqueue(async () => {
          const s = await ensureStream(); // stream opens at first real content, never empty
          if (!s) return;
          try {
            await this.d.adapter.appendTaskUpdate!(anchorObj.venueId, s.messageId, { id: taskId, title, status });
          } catch (e) {
            this.log.warn("appendTaskUpdate failed", { error: String(e) });
          }
        });
        return taskId;
      };
      const closeOpenTask = () => {
        if (openTask) {
          taskCard(taskTitles.get(openTask) ?? "…", "complete", openTask);
          openTask = null;
        }
      };
      // Codex may emit SEVERAL agent messages in one turn: working narration ("Let me check the
      // channel…"), then tools, then the actual answer. Only the LAST completed message is the
      // reply. The stream is append-only — text once appended can't be retracted — so narration
      // must NEVER go out as reply text: interim messages render as ephemeral task cards instead,
      // and the reply text is appended once, when the turn ends. While codex works, Slack's native
      // thinking shimmer + the task cards ARE the liveness.
      let heldReply = ""; // last completed agent message — the reply candidate
      let deltaTail = ""; // newest in-flight delta text (fallback if the turn dies mid-message)
      const onEvent = (e: AgentEvent) => {
        if (typeof e.stream === "string" && e.stream.trim()) deltaTail = e.stream.trim();
        if (e.log) {
          if (e.log.startsWith("⚙ ")) {
            const title = e.log.slice(2).trim();
            // `reply` is delivery plumbing (it just sets the reply text) — not work worth a card.
            if (title !== "reply") {
              closeOpenTask();
              openTask = taskCard(title, "in_progress");
              if (openTask) taskTitles.set(openTask, title);
            }
          }
          if (e.log.startsWith("● ")) {
            closeOpenTask();
            // A newer message supersedes the held one — the held one was interim narration; show it
            // as a completed task card (the ephemeral working note), not text.
            if (heldReply) taskCard(heldReply.split("\n")[0]!.slice(0, 200), "complete");
            heldReply = e.log.slice(2).trim();
            deltaTail = "";
          }
          this.log.info("codex", { line: e.log });
        }
      };

      const tools = buildToolset({
        db: this.d.db,
        clock: this.d.clock,
        identity,
        turnKind: "interactive",
        catalog: this.catalog,
        anchor: anchorObj,
        principal: this.principalOf(event.principalId),
        originEventId: event.id,
        nudgeAfterMs: this.policy().tasks.nudgeAfterMs,
        // The reply tool sets the reply candidate directly (same one-message stream, not a post).
        postMessage: async (_a, text) => {
          heldReply = text.trim();
          return { messageId: streamMsg?.messageId ?? "streaming" };
        },
        effects,
      });
      const session = this.d.sessionFactory(tools, onEvent);
      await session.start(this.d.cwd);
      // Continuity (SPEC §5): resume the codex thread for THIS conversation thread (convoThreadTs is
      // where the reply streams, so keying on it keeps streaming + memory consistent — a follow-up in
      // the thread resumes the same conversation). Fall back to a fresh codex thread if resume fails
      // (rollout gone / version skew) so a bad resume never wedges the conversation.
      const priorThreadId = getConversationThread(this.d.db, identityId, anchorObj.venueId, convoThreadTs);
      let threadId: string;
      try {
        threadId = priorThreadId ? await session.resumeThread(priorThreadId) : await session.startThread(this.d.cwd);
      } catch (e) {
        this.log.warn("thread resume failed — starting fresh", { venueId: anchorObj.venueId, threadTs: convoThreadTs, error: String(e) });
        threadId = await session.startThread(this.d.cwd);
      }
      setConversationThread(this.d.db, this.d.clock, identityId, anchorObj.venueId, convoThreadTs, threadId);
      try {
        await runTurn({
          session,
          threadId,
          cwd: this.d.cwd,
          prompt: `${prompt}\n\nIf this is real delegated work that won't finish in this reply, use task_create; otherwise just reply.`,
          title: `interactive:${anchor.venueId}`,
          db: this.d.db,
          clock: this.d.clock,
          turnId: this.d.newId(),
          identityId,
          kind: "interactive",
          anchor: anchorObj,
          effects,
          tokensUsed: () => 0,
          spendAmount: () => 0,
          envelope: { timeoutMs: this.policy().turns.interactiveTimeoutMs, tokenCeiling: this.policy().turns.interactiveTokenCeiling },
        });
        // Every turn owes a visible reply (SPEC §6.1 no dangling threads):
        //  - normal: the LAST completed agent message (or the reply tool's text) is the reply,
        //    appended in word-boundary chunks for the streamed-in feel.
        //  - turn produced no text at all → a minimal honest line.
        //  - stream never started → deliver as a plain post (delivery guarantee, logged loudly
        //    above — not a second UX path).
        const created = effects.some((e) => (e as { kind?: string }).kind === "task_created");
        const silentLine = created ? "Got it — I've picked that up as a task and I'm on it." : "On it.";
        const replyText = heldReply || deltaTail || silentLine;
        for (const piece of chunkText(replyText, 400)) {
          enqueue(async () => {
            const s = await ensureStream();
            if (!s) return;
            await this.d.adapter.appendStream!(anchorObj.venueId, s.messageId, piece).catch((e) => this.log.warn("appendStream failed", { error: String(e) }));
          });
        }
        await queue;
        // Delivery guarantee (SPEC §6.1): if the stream could not start at all, the reply still
        // lands as a plain post — logged loudly above, not a second UX path.
        if (!streamMsg) {
          await this.postMessage({ venueId: anchorObj.venueId, threadRootId: convoThreadTs }, replyText).catch((e) => this.log.error("reply delivery failed entirely", { error: String(e) }));
        }
      } catch (e) {
        this.log.error("interactive turn failed", { identityId, error: String(e) });
      } finally {
        void this.d.adapter.setTypingStatus?.(anchorObj.venueId, convoThreadTs, "").catch(() => {}); // clear the shimmer
        // (read via a cast: streamMsg is assigned inside ensureStream, which TS's flow analysis can't see)
        const openStream = streamMsg as { messageId: string } | null;
        if (openStream) {
          await queue.catch(() => {});
          await this.d.adapter.stopStream?.(anchorObj.venueId, openStream.messageId).catch(() => {});
        }
        session.stop();
      }
      // Any task created here is now 'open'. Trigger an immediate tick so it dispatches without
      // waiting for the heartbeat (keeps the run loop the sole dispatcher — one concurrency story).
      this.maybeTick();
    })();
    this.track(this.interactiveTurns, promise);
    return promise;
  }

  // --- distillation (SPEC §8.2) ---
  // Sweep observed messages received since the last distillation into memory: run a distillation
  // turn (memory tools, no posting — enforced by the broker) over the buffer + existing memory, so
  // the agent writes durable facts it can reference later (incl. from other channels it observes).
  private runDistillation(identityId: string): void {
    const promise = (async () => {
      const identity = this.identityById(identityId);
      if (!identity) return;
      const since = this.lastDistilledAt.get(identityId) ?? "1970-01-01T00:00:00Z";
      const observed = bufferedObservedMessages(this.d.db, identityId, since).slice(-100); // cap the prompt
      this.lastDistilledAt.set(identityId, this.d.clock());
      if (observed.length === 0) return; // nothing to distill — no codex turn, no cost

      const existing = queryMemory(this.d.db, identityId).map((m) => `- ${m.content}`).join("\n") || "(none yet)";
      const messages = observed.map((m) => `[${m.venueId}] ${m.principalId ?? "?"}: ${m.text}`).join("\n");
      const effects: unknown[] = [];
      const tools = buildToolset({
        db: this.d.db,
        clock: this.d.clock,
        identity,
        turnKind: "distillation",
        catalog: this.catalog,
        anchor: null,
        nudgeAfterMs: this.policy().tasks.nudgeAfterMs,
        postMessage: async () => ({ messageId: "distillation-no-post" }), // never called (no posting in distillation)
        effects,
      });
      const session = this.d.sessionFactory(tools, (e) => e.log && this.log.info("codex", { line: e.log }));
      await session.start(this.d.cwd);
      const threadId = await session.startThread(this.d.cwd);
      try {
        await runTurn({
          session,
          threadId,
          cwd: this.d.cwd,
          prompt: `You are distilling durable memory for identity "${identityId}". Below are recent messages observed in your venues since the last sweep. Extract only DURABLE facts worth remembering — people and their roles, projects, decisions, terminology, preferences, recurring pain. Skip transient chatter and one-off task context. Use memory_write for each new fact; do NOT duplicate anything already in memory. Post nothing.\n\nExisting memory:\n${existing}\n\nRecent messages:\n${messages}`,
          title: `distillation:${identityId}`,
          db: this.d.db,
          clock: this.d.clock,
          turnId: this.d.newId(),
          identityId,
          kind: "distillation",
          effects,
          tokensUsed: () => 0,
          spendAmount: () => 0,
          envelope: { timeoutMs: this.policy().turns.interactiveTimeoutMs, tokenCeiling: this.policy().turns.interactiveTokenCeiling },
        });
      } catch (e) {
        this.log.error("distillation turn failed", { identityId, error: String(e) });
      } finally {
        session.stop();
      }
      this.log.info("distillation swept", { identityId, messages: observed.length });
    })();
    this.track(this.interactiveTurns, promise);
  }

  // SPEC §9.2: an ambient turn is speak-only — it reads (memory + ledger view + recent observed
  // chatter) and MAY post an unprompted, per-venue-per-day-capped message into an ambient-enabled
  // venue. Most ticks should surface nothing; proactiveness is a scalpel, not a firehose. Re-arms
  // the identity's next tick (unless invoked manually via ambientNow).
  private runAmbient(identityId: string, rearm = true): void {
    const promise = (async () => {
      const identity = this.identityById(identityId);
      if (!identity) return;
      if (rearm) scheduleAmbientTick(this.d.db, this.d.clock, identityId, identity.ambient.tickIntervalMs);
      if (identity.ambient.enabledVenues.length === 0) return; // proactivity disabled for this identity

      const since = this.lastAmbientAt.get(identityId) ?? "1970-01-01T00:00:00Z";
      this.lastAmbientAt.set(identityId, this.d.clock());
      const observed = bufferedObservedMessages(this.d.db, identityId, since).slice(-100);
      const memory = queryMemory(this.d.db, identityId).map((m) => `- ${m.content}`).join("\n") || "(none yet)";
      const view = ledgerView(this.d.db, identityId);
      const open = view.open.map((t) => `- ${t.id} [${t.status}${t.waitingOn ? `/${t.waitingOn}` : ""}] ${t.title}`).join("\n") || "(no open tasks)";
      const chatter = observed.map((m) => `[${m.venueId}] ${m.principalId ?? "?"}: ${m.text}`).join("\n") || "(no new messages since last tick)";

      const effects: unknown[] = [];
      const tools = buildToolset({
        db: this.d.db,
        clock: this.d.clock,
        identity,
        turnKind: "ambient",
        catalog: this.catalog,
        anchor: null, // ambient is venue-scoped, not anchor-scoped — reply picks an enabled venueId
        ambientEnabledVenues: identity.ambient.enabledVenues,
        ambientDailyPostCap: identity.ambient.dailyPostCap,
        budgetTimezone: this.policy().budget.timezone,
        nudgeAfterMs: this.policy().tasks.nudgeAfterMs,
        postMessage: (a, text) => this.postMessage(a, text),
        effects,
      });
      const session = this.d.sessionFactory(tools, (e) => e.log && this.log.info("codex", { line: e.log }));
      await session.start(this.d.cwd);
      const threadId = await session.startThread(this.d.cwd);
      try {
        await runTurn({
          session,
          threadId,
          cwd: this.d.cwd,
          prompt: `You are "${identityId}", running a periodic AMBIENT check. You are a guest in these channels. Below is your durable memory, your open tasks, and recent chatter you've overheard since your last check. Decide whether there is anything genuinely worth surfacing UNPROMPTED right now — a blocker you can flag, a question you can answer, a task update the team would want, a dropped thread worth reviving. Bias STRONGLY toward silence: most checks should end with NO post. Only if you have something clearly useful, call \`reply\` with { venueId, text } to one of your ambient-enabled venues (${identity.ambient.enabledVenues.join(", ")}). Be brief and low-key. Do nothing else.\n\nYour memory:\n${memory}\n\nYour open tasks:\n${open}\n\nRecent chatter:\n${chatter}`,
          title: `ambient:${identityId}`,
          db: this.d.db,
          clock: this.d.clock,
          turnId: this.d.newId(),
          identityId,
          kind: "ambient",
          effects,
          tokensUsed: () => 0,
          spendAmount: () => 0,
          envelope: { timeoutMs: this.policy().turns.interactiveTimeoutMs, tokenCeiling: this.policy().turns.interactiveTokenCeiling },
        });
      } catch (e) {
        this.log.error("ambient turn failed", { identityId, error: String(e) });
      } finally {
        session.stop();
      }
      const posted = effects.filter((e) => (e as { kind?: string }).kind === "posted").length;
      this.log.info("ambient tick ran", { identityId, observed: observed.length, posted });
    })();
    this.track(this.interactiveTurns, promise);
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

    const promise = runExecution({
      db: this.d.db,
      clock: this.d.clock,
      taskId,
      executionId,
      identity,
      catalog: this.catalog,
      cwd: this.d.cwd,
      nudgeAfterMs: this.policy().tasks.nudgeAfterMs,
      maxTurns: this.policy().executions.maxTurns,
      maxConsecutiveInterruptions: this.policy().executions.maxAttempts,
      stallTimeoutMs: this.policy().executions.stallTimeoutMs,
      postMessage: (a, text) => this.postMessage(a, text),
      updateMessage: this.d.adapter.updateMessage ? (v, m, t) => this.d.adapter.updateMessage!(v, m, t) : undefined,
      buildPrompt: (turnNumber, guidance) => {
        const spec = getTask(this.d.db, taskId)?.spec ?? "";
        const note = guidance.length ? `\n\nNew guidance:\n${guidance.join("\n")}` : "";
        return turnNumber === 1
          ? `Work this task to a terminal state. If it has multiple stages, FIRST call \`checklist\` with your planned stages (all done:false), then update it as you complete each one — it edits one message in place. Call task_complete/task_fail when done, task_ask if blocked, or set_wake to check back later.\n\n${spec}${note}`
          : `Continuation, turn ${turnNumber}. Keep your checklist up to date as you go. ${spec}${note}`;
      },
      newTurnId: () => this.d.newId(),
      sessionFactory: this.d.sessionFactory,
      perTaskCap: identity.budget.perTaskCap,
      budgetPolicy: {
        timezone: this.policy().budget.timezone,
        identityMonthlyCap: identity.budget.monthlyCap,
        globalMonthlyCap: this.policy().budget.globalMonthlyCap,
        reserve: this.policy().budget.reserve,
      },
    })
      .then((r) => this.log.info("execution finished", { taskId, outcome: r.outcome, turnsRun: r.turnsRun }))
      .catch((e) => this.log.error("execution threw", { taskId, error: String(e) }))
      // A finished execution freed a concurrency slot — re-tick so a deferred task fills it
      // immediately rather than waiting for the heartbeat.
      .finally(() => this.maybeTick());

    this.track(this.executions, promise);
  }

  private track(set: Set<Promise<unknown>>, promise: Promise<unknown>): void {
    set.add(promise);
    void promise.finally(() => set.delete(promise));
  }
}
