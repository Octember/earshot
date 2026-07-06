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
import { bufferedObservedMessages, distillableMessages } from "./ledger/ambient";
import { queryMemory } from "./ledger/memory";
import { checkpointWal } from "./ledger/db";
import { runExecution } from "./turn-runner/execution-loop";
import { runTurn } from "./turn-runner/turn";
import { buildToolset } from "./turn-runner/toolset";
import { composeInstructions } from "./turn-runner/soul";
import { getConversationThread, setConversationThread, recentConversations } from "./ledger/continuity";
import { deliverPost } from "./adapter/outbound";
import { routeMessage, type Event } from "./adapter/router";
import { TurnAdmission, type AnchorKey } from "./adapter/turn-admission";
import { ReplyStream } from "./adapter/reply-stream";
import type { SurfaceAdapter } from "./adapter/types";
import type { AgentRuntimeSession, DynamicTool, AgentEvent } from "./turn-runner/types";
import type { PolicyStore } from "./policy/load";
import type { Policy, IdentityConfig } from "./policy/schema";
import type { ToolCatalog } from "./policy/broker";
import { createLogger, type Logger } from "./log";

// §9.5 — operator-set per-venue standing instructions, appended to the ambient prompt. The
// silence bias is the default posture; for a venue with an instruction, the instruction IS the
// job there (still speak-only, still under the daily post cap).
function standingInstructions(identity: IdentityConfig): string {
  const entries = Object.entries(identity.venueInstructions);
  if (entries.length === 0) return "";
  return ` EXCEPTION — your operator gave you standing instructions for specific venues; there, the instruction (not the silence bias) decides whether and how to engage:\n${entries.map(([venueId, text]) => `- <#${venueId}>: ${text}`).join("\n")}\n`;
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
  // Event-driven ambient (the "proactively reads my messages" behavior): an overheard message in an
  // ambient-enabled venue arms this per-identity debounce; when the chatter settles, one speak-only
  // ambient turn evaluates whether anything is worth saying. Bursts collapse to a single turn.
  private ambientDebounce = new Map<string, ReturnType<typeof setTimeout>>();
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
    // (1b) write earshot's "soul doc" to the workspace AGENTS.md — codex loads it as standing
    // instructions for every turn (its native system-prompt seam). This is where earshot's CHARACTER
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
    if (this.heartbeat) clearTimeout(this.heartbeat);
    for (const t of this.ambientDebounce.values()) clearTimeout(t);
    this.ambientDebounce.clear();
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
    } else if (result.kind === "observed") {
      // Persisted for the ambient/distillation buffer by the router; if this venue is
      // ambient-enabled, also arm the event-driven ambient debounce (proactive engagement).
      // HUMAN chatter only — bot firehoses (error feeds etc.) would arm an evaluation on every
      // message; bots still reach ambient via the periodic tick's buffer. Exception: a venue with
      // a standing instruction (§9.5) opted into reacting to exactly that firehose — an alert
      // channel's instruction is useless if it only runs on the half-hour tick.
      const identity = this.identityById(result.event.identityId);
      if (identity && (!msg.isBot || identity.venueInstructions[result.event.venueId])) this.maybeArmAmbient(identity, result.event);
    }
    // ignored_self / unbound_venue / duplicate → nothing.
  }

  private maybeArmAmbient(identity: IdentityConfig, event: Event): void {
    if (this.stopping) return;
    const { enabledVenues, eventDebounceMs } = identity.ambient;
    if (eventDebounceMs <= 0) return; // event-driven ambient disabled — timer ticks only
    if (!(enabledVenues.includes("*") || enabledVenues.includes(event.venueId))) return;
    const prior = this.ambientDebounce.get(identity.id);
    if (prior) clearTimeout(prior); // still chattering — wait for quiet
    this.ambientDebounce.set(
      identity.id,
      setTimeout(() => {
        this.ambientDebounce.delete(identity.id);
        if (!this.stopping) this.runAmbient(identity.id, false); // no re-arm: the durable tick is the backstop
      }, eventDebounceMs),
    );
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

  // The context block a FRESH conversation opens with — what makes a new thread feel like the same
  // agent, not an amnesiac: who's speaking + durable memory + the task ledger + pointers to other
  // recent conversations + recent overheard chatter (raw events, so recall never waits for a
  // distillation sweep). Kept compact; the model pulls more via memory_query/task_query/read_channel.
  private interactiveContext(identityId: string, event: Event): string {
    const memory = queryMemory(this.d.db, identityId).slice(0, 30).map((m) => `- ${m.content}`).join("\n") || "(none yet)";
    const view = ledgerView(this.d.db, identityId);
    const open = view.open.slice(0, 10).map((t) => `- ${t.id} [${t.status}${t.waitingOn ? `/${t.waitingOn}` : ""}] ${t.title}`).join("\n") || "(none)";
    const recent = view.recentTerminals.slice(0, 5).map((t) => `- ${t.id} [${t.status}] ${t.title}`).join("\n") || "(none)";
    const convos =
      recentConversations(this.d.db, identityId, { exclude: { venueId: event.venueId, threadRootId: event.threadRootId }, limit: 8 })
        .map((c) => `- <#${c.venueId}> ${c.lastAt}: "${c.snippet}"`)
        .join("\n") || "(none)";
    const dayAgo = new Date(new Date(this.d.clock()).getTime() - 24 * 60 * 60 * 1000).toISOString();
    const chatter =
      bufferedObservedMessages(this.d.db, identityId, dayAgo)
        .slice(-20)
        .map((m) => `- [<#${m.venueId}>] ${m.principalId ? `<@${m.principalId}>` : "?"}: ${m.text.slice(0, 120)}`)
        .join("\n") || "(none)";
    const instruction = this.identityById(identityId)?.venueInstructions[event.venueId];
    return [
      `You are replying in <#${event.venueId}>. The person speaking is <@${event.principalId ?? "unknown"}>.`,
      ...(instruction ? [`\nStanding instruction from your operator for THIS venue:\n${instruction}`] : []),
      `\nYour durable memory:\n${memory}`,
      `\nYour open tasks:\n${open}`,
      `\nRecently finished tasks:\n${recent}`,
      `\nYour other recent conversations (separate threads — recall details with memory_query, or read a channel with read_channel):\n${convos}`,
      `\nRecent channel chatter you've overheard (last 24h):\n${chatter}`,
    ].join("\n");
  }

  // --- interactive turns ---
  private runInteractiveTurn(identityId: string, anchor: AnchorKey, events: Event[]): Promise<void> {
    const promise = (async () => {
      const identity = this.identityById(identityId);
      if (!identity) return;
      const event = events[events.length - 1]!; // origin = latest event in the batch
      const effects: unknown[] = [];
      const anchorObj = { venueId: anchor.venueId, threadRootId: anchor.threadRootId };

      // Reply delivery is native Slack streaming (chat.startStream/appendStream/stopStream): the
      // real in-channel UX — the message shows Slack's native "thinking" shimmer the moment the
      // stream opens (streaming_state, before any content), live task cards while codex works, then
      // the answer streaming in. Streaming requires a thread, so the reply streams into the
      // conversation's thread — the mention's thread, or a fresh thread under a top-level mention.
      const convoThreadTs = anchor.threadRootId ?? event.ts;
      const recipient = event.principalId;

      // Continuity read happens up front because it also decides the prompt: a FRESH codex thread
      // opens with full context (who's speaking, memory, ledger, other conversations, recent
      // chatter) so a new thread is never amnesiac; a RESUMED thread already carries all of that.
      const priorThreadId = getConversationThread(this.d.db, identityId, anchorObj.venueId, convoThreadTs);
      let userText =
        events.length === 1
          ? event.text
          : `Multiple messages arrived together; address them all:\n${events.map((e) => `- ${e.text}`).join("\n")}`;
      // Ground the turn in the thread it's standing in: a bare "@bot" under a Sentry alert is
      // meaningless without the alert. Included on every thread-reply turn (resumed threads too —
      // teammates may have replied between her turns, which the codex thread never saw).
      if (anchor.threadRootId && this.d.adapter.readThread) {
        try {
          const msgs = await this.d.adapter.readThread(anchorObj.venueId, anchor.threadRootId, 15);
          const rendered = msgs
            .filter((m) => m.ts !== event.ts) // the triggering message is already userText
            .map((m) => `[${m.ts}] ${m.user ?? "?"}: ${m.text.slice(0, 500)}`)
            .join("\n");
          if (rendered) userText = `The thread you are replying in (thread ts ${anchor.threadRootId}, oldest first — read_thread for more):\n${rendered}\n---\n${userText}`;
        } catch (e) {
          this.log.warn("thread context fetch failed", { venueId: anchorObj.venueId, threadTs: anchor.threadRootId, error: String(e) });
        }
      }
      // Vision: attached images download into the workspace and ride the turn input as localImage
      // items — the model literally sees the screenshot. Caps keep a paste-bomb bounded.
      const images: string[] = [];
      if (this.d.adapter.downloadFile) {
        const attached = events.flatMap((e) => e.files ?? []).filter((f) => /^image\/(png|jpe?g|gif|webp)$/.test(f.mimetype));
        for (const f of attached.slice(0, 4)) {
          if (f.size > 8_000_000) continue; // vision-input sanity cap
          try {
            const bytes = await this.d.adapter.downloadFile(f.urlPrivate);
            const dir = join(this.d.cwd, "incoming");
            mkdirSync(dir, { recursive: true });
            const path = join(dir, `${event.id}-${images.length}-${f.name.replace(/[^\w.-]/g, "_").slice(-60)}`);
            writeFileSync(path, bytes);
            images.push(path);
          } catch (e) {
            this.log.warn("attachment download failed", { file: f.id, error: String(e) });
            userText += `\n\n[an attached image (${f.name}) could not be fetched: ${e instanceof Error ? e.message : String(e)}]`;
          }
        }
        if (images.length) userText += `\n\n[${images.length} attached image${images.length > 1 ? "s are" : " is"} included in your input — you can see ${images.length > 1 ? "them" : "it"}.]`;
      }
      // Turn-kind mechanics only — voice, formatting, and narration rules live in AGENTS.md (the
      // soul), which codex already loads; restating them here would just drift out of sync.
      const guidance =
        "If this is real delegated work that won't finish in this reply, use task_create; otherwise just reply. Default to NO checklist — most replies, including a quick alert triage, are just the answer. Reach for `checklist` ONLY when the work is genuinely long and multi-step and the reader benefits from watching progress; when you do, 2-4 HIGH-LEVEL goals (what you're finding out, not which tools you'll run), and flip the last item done the moment you start writing the answer. When an emoji reaction alone is the best response, use the react tool. The moment you learn a durable fact (a person, decision, preference, project detail), save it with memory_write — memory is how you stay smart across threads — and when saving it IS the response, a react on that message acknowledges it better than a 'noted' reply.";
      const prompt = priorThreadId
        ? `${userText}\n\n${guidance}`
        : `${this.interactiveContext(identityId, event)}\n---\n${userText}\n\n${guidance}`;
      // The fancy "Marvin is thinking…" shimmer: assistant.threads.setStatus works on regular
      // channel threads for agent apps (probed live), with rotating loading lines. Set the instant
      // the turn starts. The stream itself opens LAZILY at first real content — an open-but-empty
      // stream renders a literal italic "Thinking…" placeholder bubble, exactly what we don't want.
      void this.d.adapter
        .setTypingStatus?.(anchorObj.venueId, convoThreadTs, "is thinking…", ["is thinking…", "is digging in…", "is working on it…", "is putting it together…"])
        .catch(() => {});
      const stream = new ReplyStream({
        adapter: this.d.adapter,
        venueId: anchorObj.venueId,
        threadTs: convoThreadTs,
        recipient,
        log: this.log,
        paceChars: 400, // word-boundary pieces give the streamed-in feel
      });
      // Everything codex SAYS is shown, in order, as it arrives — each completed agent message or
      // reply-tool call streams in as its own paragraph, like a person sending consecutive
      // messages. No held-reply heuristics: choosing which message "counts" demoted real replies
      // into cards and let harness babble win. Duplicate texts are skipped (the reply tool and the
      // final agent message often repeat each other).
      const appended: string[] = [];
      let deltaTail = ""; // newest in-flight delta text (fallback if the turn dies mid-message)
      const say = (text: string) => {
        const t = text.trim();
        if (!t || appended.includes(t)) return;
        appended.push(t);
        void stream.post(t);
      };
      let failureCause = ""; // the runtime's own words when a turn dies (quota messages read human)
      const onEvent = (e: AgentEvent) => {
        if (e.event === "turn_failed" && e.log) failureCause = e.log;
        if (typeof e.stream === "string" && e.stream.trim()) deltaTail = e.stream.trim();
        if (e.log) {
          // Tool calls and shell commands are machinery — no cards, no narration; the typing
          // shimmer covers "working" and the checklist tool carries the plan.
          if (e.log.startsWith("● ")) {
            const text = e.log.slice(2).trim();
            // A bare closer ("Done.") after something was already said adds nothing — drop it.
            if (!(appended.length > 0 && /^(done|all done|finished|completed?|ok(ay)?)[.! ]*$/i.test(text))) say(text);
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
        // The turn's anchor is the CONVERSATION thread — so a task created here homes to the thread
        // the user is in (its checklist + progress posts land there, not top-level in the channel).
        anchor: { venueId: anchorObj.venueId, threadRootId: convoThreadTs },
        principal: this.principalOf(event.principalId),
        originEventId: event.id,
        nudgeAfterMs: this.policy().tasks.nudgeAfterMs,
        // The reply tool speaks through the same streamed message (not a separate post).
        postMessage: async (_a, text) => {
          say(text);
          return { messageId: stream.messageId ?? "streaming" };
        },
        // The react tool targets the message that triggered this turn by default; explicit
        // { venueId, ts } reaches any message in scope (e.g. the one that held a saved fact).
        // A reaction may BE the whole reply (§6.1): the moment one lands with nothing said, the
        // "is thinking…" shimmer is a lie — it promises a message — so clear it right away. If
        // text follows anyway, the stream itself shows activity.
        react: async (emoji) => {
          await this.d.adapter.addReaction(event.venueId, event.ts, emoji);
          if (appended.length === 0) await this.d.adapter.setTypingStatus?.(anchorObj.venueId, convoThreadTs, "").catch(() => {});
        },
        reactTo: async (v, ts, emoji) => {
          await this.d.adapter.addReaction(v, ts, emoji);
          if (appended.length === 0) await this.d.adapter.setTypingStatus?.(anchorObj.venueId, convoThreadTs, "").catch(() => {});
        },
        // The model's plan (the checklist tool: high-level goals) renders as native cards on the
        // reply stream — buffered by ReplyStream until the first answer text materializes the
        // message, so a plan alone never creates a premature notification.
        renderChecklist: async (items) => stream.setCards(items),
        checklist: { messageId: null },
        effects,
      });
      const session = this.d.sessionFactory(tools, onEvent);
      await session.start(this.d.cwd);
      // Continuity (SPEC §5): resume the codex thread for THIS conversation thread (convoThreadTs is
      // where the reply streams, so keying on it keeps streaming + memory consistent — a follow-up in
      // the thread resumes the same conversation). Fall back to a fresh codex thread if resume fails
      // (rollout gone / version skew) so a bad resume never wedges the conversation.
      let threadId: string;
      try {
        threadId = priorThreadId ? await session.resumeThread(priorThreadId) : await session.startThread(this.d.cwd);
      } catch (e) {
        this.log.warn("thread resume failed — starting fresh", { venueId: anchorObj.venueId, threadTs: convoThreadTs, error: String(e) });
        threadId = await session.startThread(this.d.cwd);
      }
      setConversationThread(this.d.db, this.d.clock, identityId, anchorObj.venueId, convoThreadTs, threadId);
      try {
        const result = await runTurn({
          session,
          threadId,
          cwd: this.d.cwd,
          prompt,
          images,
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
        // Every turn owes a visible reply (SPEC §6.1 no dangling threads) — and a reaction IS one:
        // when the turn answered with an emoji, that settles it, no canned line on top. Only a turn
        // that said nothing AND reacted to nothing gets a minimal honest line (falling back to any
        // in-flight delta text first). The line lands after the turn already finished, so it must
        // read as settled — never a promise of upcoming work.
        const effectKinds = new Set(effects.map((e) => (e as { kind?: string }).kind));
        if (result.status !== "succeeded") {
          // §6.1 applies to failures most of all: the runtime died — say so, in its words. A dead
          // turn shows NO plan — a checked-off plan over a failure line is the exact lie we're
          // killing. A timeout is the most common cause: name it plainly.
          stream.clearCards();
          if (appended.length === 0) {
            const why = result.status === "timed_out" ? "it ran too long and timed out" : failureCause || "no reason given";
            say(`couldn't finish that one — ${why}. try me again${result.status === "timed_out" ? " (i may have been over-digging)" : ""}, or flag the operator if it keeps up.`);
          }
        } else {
          // Settle any plan item the model left open — only on success, never fabricated over a
          // failure (Slack paints a pending card on a stopped stream as an error).
          stream.settleCards();
          if (appended.length === 0 && !effectKinds.has("reacted")) {
            if (!deltaTail && !effectKinds.has("task_created")) this.log.error("turn succeeded with zero output — investigate the runtime", { identityId });
            say(deltaTail || (effectKinds.has("task_created") ? "Got it — I've picked that up as a task and I'm on it." : "hm, i came back empty on that one — that's a bug on my end, not an answer. poke me again or flag the operator."));
          }
        }
      } catch (e) {
        // §6.1 no dangling threads applies to FAILURES most of all: the person asked, the runtime
        // died, and silence (or a canned success line) would be a lie. Say what actually happened,
        // in the runtime's own words when they're human-readable (quota messages are).
        this.log.error("interactive turn failed", { identityId, error: String(e) });
        const cause = e instanceof Error ? e.message : String(e);
        stream.clearCards(); // no plan box on a hard failure
        say(`can't run right now — my agent runtime failed with: ${cause}`);
      } finally {
        void this.d.adapter.setTypingStatus?.(anchorObj.venueId, convoThreadTs, "").catch(() => {}); // clear the shimmer
        await stream.close();
        // Delivery guarantee: if the stream could not start at all, everything said still lands as
        // one plain post — logged loudly by ReplyStream, not a second UX path. (A react-only turn
        // said nothing — there's nothing to deliver.)
        if (!stream.opened && appended.length > 0) {
          await this.postMessage({ venueId: anchorObj.venueId, threadRootId: convoThreadTs }, appended.join("\n\n")).catch((e) => this.log.error("reply delivery failed entirely", { error: String(e) }));
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
      // Conversations WITH the agent are the highest-signal source of durable facts — distill them
      // along with overheard chatter, not just the chatter.
      const observed = distillableMessages(this.d.db, identityId, since).slice(-100); // cap the prompt
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
          prompt: `You are distilling durable memory for identity "${identityId}". Below are recent messages observed in your venues since the last sweep. Extract only DURABLE facts worth remembering — people and their roles, projects, decisions, terminology, preferences, recurring pain. Skip transient chatter and one-off task context. Use memory_write for each new fact; do NOT duplicate anything already in memory. If a message shows an existing memory is wrong or superseded, memory_retract it (and memory_write the correction). Post nothing.\n\nExisting memory:\n${existing}\n\nRecent messages:\n${messages}`,
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
      const chatter =
        observed
          .map((m) => `[${m.venueId} ts=${m.ts}${m.threadRootId ? ` thread=${m.threadRootId}` : ""}] ${m.principalId ?? "?"}: ${m.text}`)
          .join("\n") || "(no new messages since last tick)";

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
        // Reactions on specific overheard messages — ambient's lowest-noise output (not capped).
        reactTo: (v, ts, emoji) => this.d.adapter.addReaction(v, ts, emoji),
        effects,
      });
      const session = this.d.sessionFactory(tools, (e) => e.log && this.log.info("codex", { line: e.log }));
      await session.start(this.d.cwd);
      // Ambient continuity: sweeps within a day RESUME one codex thread per identity, so working
      // state carries across checks ("that's the 5th re-trigger", "already judged this noise") and
      // the prompt cache stays warm. Rotates daily (budget-timezone date in the continuity key) —
      // durable knowledge lives in memory/Linear, so the fresh morning thread loses nothing and a
      // long-lived context can't rot unbounded.
      const dayKey = new Date(this.d.clock()).toLocaleDateString("en-CA", { timeZone: this.policy().budget.timezone });
      const priorThreadId = getConversationThread(this.d.db, identityId, "__ambient__", dayKey);
      let threadId: string;
      try {
        threadId = priorThreadId ? await session.resumeThread(priorThreadId) : await session.startThread(this.d.cwd);
      } catch (e) {
        this.log.warn("ambient thread resume failed — starting fresh", { identityId, error: String(e) });
        threadId = await session.startThread(this.d.cwd);
      }
      setConversationThread(this.d.db, this.d.clock, identityId, "__ambient__", dayKey, threadId);
      try {
        await runTurn({
          session,
          threadId,
          cwd: this.d.cwd,
          prompt: `${priorThreadId ? "Continuing today's ambient thread — your earlier checks and conclusions stand; don't re-litigate what you already dismissed, and use what you already counted.\n\n" : ""}You are "${identityId}", running an AMBIENT check over messages you passively overheard (nobody addressed you). Decide whether anything below is worth engaging with UNPROMPTED, then either post or do nothing.

What earns a post: someone shared a doc/link/decision you have relevant context on, a question you actually know the answer to, a bug report matching something you've seen, a blocker you can flag, a dropped thread worth reviving. Bias STRONGLY toward silence — most checks should end with NO post; when in doubt, stay quiet.

Channels are not all the same kind of place. Calibrate per venue using what your memory says a channel IS (an alert feed, a bug intake, a telemetry stream, general chat) and any guidance members gave you about how to treat it — what counts as "worth engaging" in one channel is noise in another.${standingInstructions(identity)}
To post, call \`reply\` with { venueId, threadRootId, text }: venueId is the channel the chatter came from${identity.ambient.enabledVenues.includes("*") ? "" : ` (allowed: ${identity.ambient.enabledVenues.join(", ")})`}; threadRootId targets the conversation — use the message's thread= value, or its ts= value to respond in a top-level message's thread; omit it only for a genuinely new top-level post. Be brief and low-key. Often the better move is no reply at all but a reaction: \`react\` with { emoji, venueId, ts } on the specific message (its ts= value). Choose an emoji that actually carries your meaning — your judgment, varied naturally, never the same stamp on everything — and remember a reaction IS a message: it clears the same bar as words, and most messages deserve neither.

This turn is speak-only: reads and posts, nothing else — your tools cannot file, edit, or change anything. Anything a reply itself accomplishes (including conventions a standing instruction names, like a "<@bot> ticket" reply another app acts on) is fair game; for work beyond a reply, propose it — a member's yes delegates it properly.

Your memory:
${memory}

Your open tasks:
${open}

Recent chatter:
${chatter}`,
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

    // The execution's ENTIRE user-facing life is ONE native streamed message in the task's home
    // thread: checklist items render as live task cards, interim replies and the terminal report
    // append as text — never a scatter of separate posts. Opened lazily at first output; posts to
    // OTHER venues (or if no stream can start, e.g. an old top-level-homed task with no thread)
    // still deliver via plain postMessage.
    const home = task.homeAnchor;
    const stream = new ReplyStream({ adapter: this.d.adapter, venueId: home.venueId, threadTs: home.threadRootId, recipient: task.sponsorId, log: this.log });

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
      postMessage: async (a, text) => {
        // Home-anchor posts flow into the execution's streamed message; anything else posts plainly.
        if (a.venueId === home.venueId && (a.threadRootId ?? home.threadRootId) === home.threadRootId) {
          const messageId = await stream.post(text);
          if (messageId) return { messageId };
        }
        return this.postMessage(a, text);
      },
      updateMessage: this.d.adapter.updateMessage ? (v, m, t) => this.d.adapter.updateMessage!(v, m, t) : undefined,
      // Checklist items render as native cards on the streamed message — buffered by ReplyStream
      // until the first text post materializes it (cards alone must not create the message).
      renderChecklist: async (items) => stream.setCards(items),
      buildPrompt: (turnNumber, guidance) => {
        const spec = getTask(this.d.db, taskId)?.spec ?? "";
        const note = guidance.length ? `\n\nNew guidance:\n${guidance.join("\n")}` : "";
        return turnNumber === 1
          ? `Work this task to a terminal state. If it has multiple stages, FIRST call \`checklist\` with your planned stages (all done:false), then update it as you complete each one. Every run ends with exactly one outcome tool: task_complete when done, task_fail if it can't be done, task_ask if blocked on a human, or set_wake to check back later. NOTHING you pass to a task tool is posted to Slack for you — reply is the only way the thread hears anything. Deliver your final user-facing message with reply (written the way your AGENTS.md "Reporting back" section says), THEN call the outcome tool; its report is just the terse ledger record. Same for questions: ask in the thread with reply before task_ask. A task must never end silently.\n\n${spec}${note}`
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
      .then((r) => {
        this.log.info("execution finished", { taskId, outcome: r.outcome, turnsRun: r.turnsRun });
        // A yield/park isn't a failure — settle deferred cards with the deferral spelled out
        // rather than letting Slack paint them as errors.
        if (r.outcome === "yielded" || r.outcome === "parked") {
          stream.settleCards((item) => `${item.text.slice(0, 230)} — ⏸ ${r.outcome === "parked" ? "parked" : "resumes on next check"}`);
        }
      })
      .catch((e) => this.log.error("execution threw", { taskId, error: String(e) }))
      // A finished execution freed a concurrency slot — re-tick so a deferred task fills it
      // immediately rather than waiting for the heartbeat. Close the streamed message either way
      // (awaited, so shutdown drain and idle() cover the close too).
      .finally(async () => {
        await stream.close();
        this.maybeTick();
      });

    this.track(this.executions, promise);
  }

  private track(set: Set<Promise<unknown>>, promise: Promise<unknown>): void {
    set.add(promise);
    void promise.finally(() => set.delete(promise));
  }
}
