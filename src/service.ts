import { budgetStatus } from "./policy/budget";
// Long-running service: boots once, drives ledger/scheduler/turns/adapter concurrently.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RawMessage } from "@bevyl-ai/agent-tools";
import type { Anchor } from "./ledger/tasks-types";
import {
  fireDueTimers,
  dispatchRunnable,
  recoverFromRestart,
  msUntilNextTimer,
} from "./ledger/scheduler";
import {
  hasUndelivered,
  hasUnjudged,
  drainOutStanceJudgments,
} from "./ledger/conversations-delivery";
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
import { launchExecution, deliverWorkerReport as emitWorkerReport } from "./service-execution";
import { refreshSoul as writeSouls } from "./service-soul";
import type { ServiceDeps } from "./service-util";
import { BUILTIN_REGISTRIES } from "./turn-runner/toolset-external";
import type { ToolRegistry } from "./tools/catalog-types";
import type { ExecutionOutcome } from "./turn-runner/execution-loop";

export class Service {
  readonly d: ServiceDeps;
  readonly log: Logger;
  readonly catalog: ToolCatalog;
  readonly registries: ToolRegistry[];
  readonly residentDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  readonly residentRunning = new Set<string>();
  readonly residentRerun = new Set<string>();
  readonly earDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  readonly earRunning = new Set<string>();
  readonly earRerun = new Set<string>();
  readonly distillRunning = new Set<string>();
  readonly wakes = new Set<Promise<unknown>>();
  readonly executions = new Set<Promise<unknown>>();
  stopping = false;
  private heartbeat: ReturnType<typeof setTimeout> | null = null;
  private ticksSinceCheckpoint = 0;

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
      drainOutStanceJudgments(this.d.db, this.d.clock, identity.id);
      if (hasUndelivered(this.d.db, identity.id)) scheduleWake(this, identity.id, 1500);
      if (hasUnjudged(this.d.db, identity.id)) scheduleEar(this, identity.id);
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

  maybeTick(): void {
    if (!this.stopping) {
      void this.tick().catch((error: unknown) => {
        this.log.error("tick failed", { error: String(error) });
      });
    }
  }

  async tick(): Promise<void> {
    if (this.stopping) return;
    const fired = fireDueTimers(this.d.db, this.d.clock, {
      parkAfterMs: this.policy().tasks.parkAfterMs,
    });
    for (const timer of fired) {
      if (timer.kind === "distillation" && timer.applied) {
        distillRecentMemories(this, timer.identityId);
      }
    }

    const policy = this.policy();
    const result = dispatchRunnable(this.d.db, this.d.clock, {
      maxConcurrentPerIdentity: policy.executions.maxConcurrentPerIdentity,
      maxConcurrentGlobal: policy.executions.maxConcurrentGlobal,
      hasBudgetHeadroom: (identityId) => {
        const identity = this.identityById(identityId);
        if (!identity) return false;
        return budgetStatus(
          this.d.db,
          this.d.clock,
          {
            timezone: policy.budget.timezone,
            identityMonthlyCap: identity.budget.monthlyCap,
            globalMonthlyCap: policy.budget.globalMonthlyCap,
            reserve: policy.budget.reserve,
          },
          identityId,
        ).hasHeadroom;
      },
      newExecutionId: () => this.d.newId(),
    });
    for (const taskId of result.dispatched) launchExecution(this, taskId);

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
        runEarPass(this, id);
      }
      for (const [id, timeout] of this.residentDebounce) {
        clearTimeout(timeout);
        this.residentDebounce.delete(id);
        runWake(this, id);
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

  ingest(msg: RawMessage): void {
    this.onInbound(msg);
  }

  wakeNow(identityId: string): void {
    runWake(this, identityId);
  }

  private onInbound(msg: RawMessage): void {
    const result = routeMessage(this.d.db, this.d.clock, msg, {
      botPrincipalId: this.d.botPrincipalId,
      policy: this.policy(),
      newEventId: () => this.d.newId(),
      onUnboundVenue: (venueId) => {
        this.log.warn("message from unbound venue", { venueId });
      },
    });
    if (result.kind === "addressed") {
      if (result.event.payload.addressMode !== "thread_follow") {
        this.openSession(msg.venueId, msg.threadRootTs ?? msg.ts, result.event.payload.text);
        scheduleWake(this, result.event.identityId, 0);
      }
      scheduleEar(this, result.event.identityId);
    } else if (result.kind === "observed") {
      scheduleEar(this, result.event.identityId);
    }
  }

  identityById(id: string): IdentityConfig | undefined {
    return this.policy().identities.find((identity) => identity.id === id);
  }

  principalOf(principalId: string | null): { id: string; isOperator: boolean } {
    return {
      id: principalId ?? "unknown",
      isOperator: this.policy().operatorPrincipals.includes(principalId ?? ""),
    };
  }

  postMessage(anchor: Anchor, text: string): Promise<{ messageId: string }> {
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
      .setSessionStatus(venueId, threadTs, "processing", title || undefined)
      .catch(() => {});
  }

  workspaceFor(identityId: string): string {
    const dir = join(this.d.cwd, identityId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  deliverWorkerReport(taskId: string, outcome: ExecutionOutcome): void {
    emitWorkerReport(this, taskId, outcome);
  }

  refreshSoul(): void {
    writeSouls(this);
  }

  track(set: Set<Promise<unknown>>, promise: Promise<unknown>): void {
    set.add(promise);
    void promise.finally(() => {
      set.delete(promise);
    });
  }
}
