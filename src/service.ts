// Long-running service: boots once, drives ledger/scheduler/turns/adapter concurrently.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getTask, liveExecutionId, type Anchor } from "./ledger/tasks";
import {
  fireDueTimers,
  dispatchRunnable,
  recoverFromRestart,
  msUntilNextTimer,
} from "./ledger/scheduler";
import { queryMemory, coreWithinBudget, decayRecentToArchive } from "./ledger/memory";
import { hasUndelivered, hasUnjudged, makeRefTable } from "./ledger/conversations";
import { desc, sql } from "drizzle-orm";
import { checkpointWal, orm } from "./ledger/db";
import { events } from "./ledger/schema";
import { runExecution, type ExecutionOutcome } from "./turn-runner/execution-loop";
import { lastAskQuestion } from "./ledger/turns";
import { buildToolset, BUILTIN_REGISTRIES } from "./turn-runner/toolset";
import { buildToolbox, renderToolbox, type ToolRegistry } from "./tools/catalog";
import { composeInstructions } from "./turn-runner/soul";
import { deliverPost } from "./adapter/outbound";
import { routeMessage } from "./adapter/router";
import type { IdentityConfig, Policy } from "./policy/schema";
import type { ToolCatalog } from "./policy/broker";
import { createLogger, type Logger } from "./log";
import { scheduleEar, runEarPass } from "./service-ear";
import { scheduleWake, runWake } from "./service-wake";
import { type ServiceDeps, type ServiceHost } from "./service-util";

export type { ServiceDeps } from "./service-util";

export class Service {
  private readonly d: ServiceDeps;
  private readonly log: Logger;
  private readonly catalog: ToolCatalog;
  private readonly registries: ToolRegistry[];
  private readonly host: ServiceHost;
  private heartbeat: ReturnType<typeof setTimeout> | null = null;
  private ticksSinceCheckpoint = 0;
  private executions = new Set<Promise<unknown>>();

  constructor(deps: ServiceDeps) {
    this.d = deps;
    this.log = deps.logger ?? createLogger();
    this.catalog = deps.catalog ?? {};
    this.registries = [...BUILTIN_REGISTRIES, ...(deps.registries ?? [])];
    this.host = {
      d: this.d,
      log: this.log,
      catalog: this.catalog,
      residentDebounce: new Map(),
      residentRunning: new Set(),
      residentRerun: new Set(),
      earDebounce: new Map(),
      earRunning: new Set(),
      earRerun: new Set(),
      wakes: new Set(),
      stopping: false,
      postMessage: (anchor, text) => this.postMessage(anchor, text),
      workspaceFor: (identityId) => this.workspaceFor(identityId),
      identityById: (id) => this.identityById(id),
      principalOf: (id) => this.principalOf(id),
      track: (set, promise) => {
        this.track(set, promise);
      },
      policy: () => this.policy(),
      refreshSoul: () => {
        this.refreshSoul();
      },
      maybeTick: () => {
        this.maybeTick();
      },
    };
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
      if (hasUndelivered(this.d.db, identity.id)) scheduleWake(this.host, identity.id, 1500);
      if (hasUnjudged(this.d.db, identity.id)) scheduleEar(this.host, identity.id);
    }
    if (this.d.heartbeatMs && this.d.heartbeatMs > 0) this.scheduleHeartbeat();
  }

  private scheduleHeartbeat(): void {
    if (this.host.stopping) return;
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
    if (!this.host.stopping) {
      void this.tick().catch((error: unknown) => {
        this.log.error("tick failed", { error: String(error) });
      });
    }
  }

  async tick(): Promise<void> {
    if (this.host.stopping) return;
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
      for (const [id, timeout] of this.host.earDebounce) {
        clearTimeout(timeout);
        this.host.earDebounce.delete(id);
        runEarPass(this.host, id);
      }
      for (const [id, timeout] of this.host.residentDebounce) {
        clearTimeout(timeout);
        this.host.residentDebounce.delete(id);
        runWake(this.host, id);
      }
      if (this.host.wakes.size === 0 && this.executions.size === 0) return;
      await Promise.allSettled([...this.host.wakes, ...this.executions]);
    }
  }

  async stop(): Promise<void> {
    this.host.stopping = true;
    if (this.heartbeat) clearTimeout(this.heartbeat);
    for (const timeout of this.host.residentDebounce.values()) clearTimeout(timeout);
    this.host.residentDebounce.clear();
    for (const timeout of this.host.earDebounce.values()) clearTimeout(timeout);
    this.host.earDebounce.clear();
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
    runWake(this.host, identityId);
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
        scheduleWake(this.host, result.event.identityId, 0);
      }
      scheduleEar(this.host, result.event.identityId);
    } else if (result.kind === "observed") {
      scheduleEar(this.host, result.event.identityId);
    }
  }

  private identityById(id: string): IdentityConfig | undefined {
    return this.policy().identities.find((identity) => identity.id === id);
  }

  private principalOf(principalId: string | null): { id: string; isOperator: boolean } {
    return {
      id: principalId ?? "unknown",
      isOperator: this.policy().operatorPrincipals.includes(principalId ?? ""),
    };
  }

  private postMessage(anchor: Anchor, text: string): Promise<{ messageId: string }> {
    return deliverPost(
      () => this.d.adapter.postMessage(anchor.venueId, anchor.threadRootId, text),
      {
        maxAttempts: 5,
        backoffMs: 500,
        maxBackoffMs: 30_000,
        onExhausted: (error) => {
          this.log.error("OUTBOUND DELIVERY FAILED — operator must convey this manually", {
            anchor,
            text,
            error: String(error),
          });
        },
      },
    ).then((result) => result ?? { messageId: "undelivered" });
  }

  private showThinking(venueId: string, threadTs: string): void {
    void this.d.adapter
      .setTypingStatus?.(venueId, threadTs, "is thinking…", [
        "is thinking…",
        "is digging in…",
        "is working on it…",
        "is putting it together…",
      ])
      .catch(() => {});
  }

  private workspaceFor(identityId: string): string {
    const dir = join(this.d.cwd, identityId);
    mkdirSync(dir, { recursive: true });
    return dir;
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
        this.log.warn("worker attempted to post — dropped (workers report to the mind)", {
          taskId,
          venueId: anchor.venueId,
          chars: text.length,
        });
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
        this.log.info("execution finished", {
          taskId,
          outcome: result.outcome,
          turnsRun: result.turnsRun,
          tier: task.tier,
        });
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
      outcome === "done"
        ? "finished"
        : outcome === "failed"
          ? "failed"
          : outcome === "parked"
            ? "was parked after repeated interruptions"
            : "is waiting on a human"
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
      if (prev?.text !== text) scheduleWake(this.host, task.identityId, 0);
    } catch (error) {
      this.log.error("worker report delivery failed", { taskId, error: String(error) });
    }
  }

  private refreshSoul(): void {
    try {
      for (const identity of this.policy().identities) {
        const decayed = decayRecentToArchive(
          this.d.db,
          this.d.clock,
          identity.id,
          this.policy().memory.recentMaxAgeMs,
        );
        if (decayed.length > 0)
          this.log.info("recent memory decayed to archive (§8.6)", {
            identityId: identity.id,
            decayed: decayed.length,
          });
        const { kept, dropped } = coreWithinBudget(
          queryMemory(this.d.db, identity.id, { tier: "core" }),
          this.policy().memory.coreCharBudget,
        );
        if (dropped.length > 0)
          this.log.warn(
            "core memory over budget — items truncated from the soul (§8.6 hygiene defect)",
            { identityId: identity.id, dropped: dropped.length },
          );
        const recent = coreWithinBudget(
          queryMemory(this.d.db, identity.id, { tier: "recent" }),
          this.policy().memory.recentCharBudget,
        );
        const knowledge = {
          identity: identity.id,
          facts: kept.map((memory) => ({ content: memory.content, asOf: memory.lastConfirmedAt })),
          dropped: dropped.length,
          recent: recent.kept.map((memory) => ({
            content: memory.content,
            asOf: memory.lastConfirmedAt,
          })),
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
        writeFileSync(
          path,
          composeInstructions(
            identity.persona ? [identity.persona] : [],
            [knowledge],
            [standing],
            [{ identity: identity.id, digest }],
          ),
        );
        this.log.info("soul written", {
          path,
          identity: identity.id,
          knowledgeItems: knowledge.facts.length,
          recentItems: knowledge.recent.length,
        });
      }
    } catch (error) {
      this.log.warn("could not write soul (AGENTS.md) — using codex default voice", {
        error: String(error),
      });
    }
  }

  private track(set: Set<Promise<unknown>>, promise: Promise<unknown>): void {
    set.add(promise);
    void promise.finally(() => {
      set.delete(promise);
    });
  }
}
