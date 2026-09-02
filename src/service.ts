// Long-running service: boots once, drives ledger/scheduler/turns/adapter concurrently.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Anchor } from "./ledger/tasks";
import {
  fireDueTimers,
  dispatchRunnable,
  recoverFromRestart,
  msUntilNextTimer,
} from "./ledger/scheduler";
import { hasUndelivered, hasUnjudged, drainOutStanceJudgments } from "./ledger/conversations";
import { checkpointWal } from "./ledger/db";
import { deliverPost } from "./adapter/outbound";
import { routeMessage } from "./adapter/router";
import type { IdentityConfig, Policy } from "./policy/schema";
import type { ToolCatalog } from "./policy/broker";
import { createLogger, type Logger } from "./log";
import { scheduleEar, runEarPass } from "./service-ear";
import { scheduleWake, runWake } from "./service-wake";
import { distillRecentMemories } from "./service-distill";
import { maybeArmDistillation } from "./ledger/memory";
import {
  launchExecution,
  deliverWorkerReport as emitWorkerReport,
  type ExecutionHost,
} from "./service-execution";
import { refreshSoul, type SoulHost } from "./service-soul";
import { type ServiceDeps, type ServiceHost } from "./service-util";
import { BUILTIN_REGISTRIES } from "./turn-runner/toolset";
import type { ToolRegistry } from "./tools/catalog";
import type { ExecutionOutcome } from "./turn-runner/execution-loop";

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
      distillRunning: new Set(),
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
      drainOutStanceJudgments(this.d.db, this.d.clock, identity.id);
      if (hasUndelivered(this.d.db, identity.id)) scheduleWake(this.host, identity.id, 1500);
      if (hasUnjudged(this.d.db, identity.id)) scheduleEar(this.host, identity.id);
      maybeArmDistillation(
        this.d.db,
        this.d.clock,
        identity.id,
        this.policy().memory.recentCharBudget,
      );
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
    const fired = fireDueTimers(this.d.db, this.d.clock, {
      parkAfterMs: this.policy().tasks.parkAfterMs,
    });
    for (const timer of fired) {
      if (timer.kind === "distillation" && timer.applied) {
        distillRecentMemories(this.host, timer.identityId);
      }
    }

    const result = dispatchRunnable(this.d.db, this.d.clock, {
      maxConcurrentPerIdentity: this.policy().executions.maxConcurrentPerIdentity,
      maxConcurrentGlobal: this.policy().executions.maxConcurrentGlobal,
      newExecutionId: () => this.d.newId(),
    });
    for (const taskId of result.dispatched) this.launchExecution(taskId);

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
    await this.idle();
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
        this.openSession(
          result.event.venueId,
          result.event.threadRootId ?? result.event.ts,
          result.event.text,
        );
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

  // §5.2: a direct address opens the surface's native session, titled by the ask itself; her
  // delivered answer closes it.
  private openSession(venueId: string, threadTs: string, askText: string): void {
    const title = askText
      .replaceAll(/<@[^>]+>/g, "")
      .replaceAll(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    void this.d.adapter
      .setSessionStatus?.(venueId, threadTs, "processing", title || undefined)
      .catch(() => {});
  }

  private workspaceFor(identityId: string): string {
    const dir = join(this.d.cwd, identityId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private soulHost(): SoulHost {
    return {
      d: this.d,
      log: this.log,
      catalog: this.catalog,
      registries: this.registries,
      policy: () => this.policy(),
      workspaceFor: (identityId) => this.workspaceFor(identityId),
    };
  }

  private executionHost(): ExecutionHost {
    return {
      ...this.soulHost(),
      host: this.host,
      identityById: (id) => this.identityById(id),
      deliverWorkerReport: (taskId, outcome) => {
        this.deliverWorkerReport(taskId, outcome);
      },
      track: (set, promise) => {
        this.track(set, promise);
      },
      maybeTick: () => {
        this.maybeTick();
      },
      executions: this.executions,
    };
  }

  private launchExecution(taskId: string): void {
    launchExecution(this.executionHost(), taskId);
  }

  private deliverWorkerReport(taskId: string, outcome: ExecutionOutcome): void {
    emitWorkerReport({ d: this.d, log: this.log, host: this.host }, taskId, outcome);
  }

  private refreshSoul(): void {
    refreshSoul(this.soulHost());
  }

  private track(set: Set<Promise<unknown>>, promise: Promise<unknown>): void {
    set.add(promise);
    void promise.finally(() => {
      set.delete(promise);
    });
  }
}
