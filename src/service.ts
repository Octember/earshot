import { flattenRegistries } from "./tools/catalog";
import type { TurnEffect } from "./schemas/effects";
import { buildEarPrompt, runEarSession } from "./service-ear-pass";
import {
  advanceJudged,
  drainOutStanceJudgments,
  hasUndelivered,
  hasUnjudged,
  unjudgedConversations,
} from "./ledger/conversations-delivery";
import { makeRefTable } from "./ledger/conversations-refs";
import type { TurnStatus } from "./ledger/schema";
import { isDirectAddress } from "./ledger/inbox";
import { runWake, scheduleWake } from "./service-wake";
import type { RawMessage } from "@bevyl-ai/agent-tools";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Anchor } from "./ledger/tasks-types";
import {
  dispatchRunnable,
  fireDueTimers,
  msUntilNextTimer,
  recoverFromRestart,
} from "./ledger/scheduler";
import { routeMessage } from "./adapter/router";
import type { IdentityConfig, Policy } from "./policy/schema";
import type { ToolCatalog } from "./policy/broker";
import type { Logger } from "./log";
import { distillRecentMemories } from "./service-distill";
import { maybeArmDistillation } from "./ledger/memory";
import { launchExecution } from "./service-execution";
import { refreshSoul } from "./service-soul";
import type { ServiceDeps } from "./service-util";
import { BUILTIN_REGISTRIES } from "./turn-runner/toolset-external";
import type { ToolRegistry } from "./tools/catalog-types";

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
    this.log = deps.logger;
    this.registries = [...BUILTIN_REGISTRIES, ...deps.registries];
    this.catalog = flattenRegistries(this.registries);
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
    refreshSoul(this);
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
    this.scheduleHeartbeat();
  }

  private scheduleHeartbeat(): void {
    if (this.stopping) return;
    const sleep = msUntilNextTimer(this.d.db, this.d.clock, this.d.heartbeatMs);
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
    const fired = fireDueTimers(this.d.db, this.d.clock);
    for (const timer of fired) {
      if (timer.kind === "distillation" && timer.applied) {
        distillRecentMemories(this, timer.identityId);
      }
    }

    const policy = this.policy();
    const dispatched = dispatchRunnable(this.d.db, this.d.clock, {
      maxConcurrentPerIdentity: policy.executions.maxConcurrentPerIdentity,
      maxConcurrentGlobal: policy.executions.maxConcurrentGlobal,
      newExecutionId: () => this.d.newId(),
    });
    for (const taskId of dispatched) launchExecution(this, taskId);

    if (++this.ticksSinceCheckpoint >= 300) {
      this.ticksSinceCheckpoint = 0;
      try {
        this.d.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch (error) {
        this.log.warn("wal checkpoint failed", { error: String(error) });
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeat) clearTimeout(this.heartbeat);
    this.d.adapter.stop();
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
      if (this.wakes.size === 0 && this.executions.size === 0) break;
      await Promise.allSettled([...this.wakes, ...this.executions]);
    }
    this.log.info("service stopped");
  }

  reloadPolicy(): void {
    const result = this.d.policyStore.reload();
    if (result.ok) this.log.info("policy reloaded");
    else
      this.log.error("policy reload rejected — keeping last-known-good", { errors: result.errors });
  }

  private onInbound(msg: RawMessage): void {
    const event = routeMessage(this.d.db, this.d.clock, msg, {
      botPrincipalId: this.d.botPrincipalId,
      policy: this.policy(),
      newEventId: () => this.d.newId(),
      onUnboundVenue: (venueId) => {
        this.log.warn("message from unbound venue", { venueId });
      },
    });
    if (!event) return;
    if (event.kind === "addressed_message" && event.payload.addressMode !== "thread_follow") {
      this.openSession(msg.venueId, msg.threadRootTs ?? msg.ts, event.payload.text);
      scheduleWake(this, event.identityId, 0);
    }
    scheduleEar(this, event.identityId);
  }

  identityById(id: string): IdentityConfig | undefined {
    return this.policy().identities.find((identity) => identity.id === id);
  }

  async postMessage(anchor: Anchor, text: string): Promise<{ messageId: string }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        return await this.d.adapter.postMessage(anchor.venueId, anchor.threadRootId, text);
      } catch (error) {
        lastError = error;
        if (attempt < 5)
          await new Promise<void>((resolve) => {
            setTimeout(resolve, Math.min(500 * 2 ** (attempt - 1), 30_000));
          });
      }
    }
    this.log.error("OUTBOUND DELIVERY FAILED — operator must convey this manually", {
      anchor,
      text,
      error: String(lastError),
    });
    return { messageId: "undelivered" };
  }

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

  track(set: Set<Promise<unknown>>, promise: Promise<unknown>): void {
    set.add(promise);
    void promise.finally(() => {
      set.delete(promise);
    });
  }
}

function scheduleEar(host: Service, identityId: string): void {
  if (host.stopping) return;
  if (host.earDebounce.has(identityId)) return;
  const identity = host.identityById(identityId);
  host.earDebounce.set(
    identityId,
    setTimeout(() => {
      host.earDebounce.delete(identityId);
      if (!host.stopping) runEarPass(host, identityId);
    }, identity?.ambient.eventDebounceMs ?? 20_000),
  );
}

function runEarPass(host: Service, identityId: string): void {
  if (host.earRunning.has(identityId)) {
    host.earRerun.add(identityId);
    return;
  }
  host.earRunning.add(identityId);
  const promise = (async () => {
    drainOutStanceJudgments(host.d.db, host.d.clock, identityId);
    const convos = unjudgedConversations(host.d.db, identityId);
    if (convos.length === 0) return;
    const effects: TurnEffect[] = [];
    let needWake = false;
    const refs = makeRefTable();
    const prompt = buildEarPrompt(host, identityId, convos, refs);
    let status: TurnStatus = "failed";
    try {
      status = await runEarSession(host, identityId, prompt, effects, refs, () => {
        needWake = true;
      });
    } catch (error) {
      host.log.error("ear pass threw", { identityId, error: String(error) });
    } finally {
      for (const convo of convos)
        advanceJudged(host.d.db, host.d.clock, identityId, convo, convo.messages.at(-1)!.rowid);
    }
    if (status !== "succeeded") {
      const hasDirect = convos.some((convo) =>
        convo.messages.some((message) => isDirectAddress(message)),
      );
      const hasExternal = convos.some((convo) =>
        convo.messages.some((message) => message.kind === "external_signal"),
      );
      if (!needWake && (hasDirect || hasExternal)) {
        host.log.warn("ear pass did not succeed — waking for direct or worker traffic", {
          identityId,
          status,
          hasDirect,
          hasExternal,
        });
        needWake = true;
      } else if (!needWake) {
        host.log.warn("ear pass did not succeed — failing closed", { identityId, status });
      }
    }
    if (needWake) runWake(host, identityId);
  })().finally(() => {
    host.earRunning.delete(identityId);
    const again = host.earRerun.delete(identityId);
    if (!host.stopping && again) runEarPass(host, identityId);
  });
  host.track(host.wakes, promise);
}
