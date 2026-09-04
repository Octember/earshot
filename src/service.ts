import { flattenRegistries } from "./tools/catalog";
import type { TurnEffect } from "./schemas/effects";
import { buildEarPrompt, runEarSession } from "./service-ear-pass";
import {
  hasUndelivered,
  hasUnjudged,
  markJudged,
  unjudgedConversations,
} from "./ledger/conversations-delivery";
import { makeRefTable } from "./ledger/conversations-refs";
import type { TurnStatus } from "./ledger/schema";
import { runWake } from "./service-wake";
import { Debounced } from "./service-debounce";
import type { MessageEvent } from "@slack/types";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  dispatchRunnable,
  msUntilNextWake,
  recoverFromRestart,
  wakeDueTasks,
} from "./ledger/scheduler";
import { routeMessage } from "./adapter/router";
import type { IdentityConfig, Policy } from "./policy/schema";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { Logger } from "./log";
import { launchExecution } from "./service-execution";
import { refreshSoul } from "./service-soul";
import type { ServiceDeps } from "./service-util";
import { BUILTIN_GROUPS } from "./turn-runner/toolset-external";
import type { ToolGroup } from "./tools/catalog-types";

export class Service {
  readonly d: ServiceDeps;
  readonly log: Logger;
  readonly external: DynamicTool[];
  readonly groups: ToolGroup[];
  readonly inflight = new Set<Promise<unknown>>();
  readonly resident: Debounced;
  readonly ear: Debounced;
  stopping = false;
  private heartbeat: ReturnType<typeof setTimeout> | null = null;
  private ticksSinceCheckpoint = 0;

  constructor(deps: ServiceDeps) {
    this.d = deps;
    this.log = deps.logger;
    this.groups = [
      ...BUILTIN_GROUPS,
      ...deps.registries.map((registry) => ({ ...registry, tools: Object.keys(registry.tools) })),
    ];
    this.external = flattenRegistries(deps.registries);
    const stopping = () => this.stopping;
    const track = (promise: Promise<unknown>) => {
      this.track(promise);
    };
    this.resident = new Debounced((id) => runWake(this, id), stopping, track);
    this.ear = new Debounced((id) => runEarPass(this, id), stopping, track);
  }

  policy(): Policy {
    return this.d.policyStore.current();
  }

  async start(): Promise<void> {
    const recovery = recoverFromRestart(
      this.d.db,
      this.d.clock,
      this.policy().executions.maxAttempts,
    );
    if (recovery.reopened.length > 0 || recovery.failed.length > 0)
      this.log.info("restart recovery", recovery);
    refreshSoul(this);
    this.log.info("service started");
    for (const identity of this.policy().identities) {
      if (hasUndelivered(this.d.db, identity.id)) this.resident.schedule(identity.id, 1500);
      if (hasUnjudged(this.d.db, identity.id)) this.scheduleEar(identity.id);
    }
    this.scheduleHeartbeat();
  }

  private scheduleHeartbeat(): void {
    if (this.stopping) return;
    const sleep = msUntilNextWake(this.d.db, this.d.clock, this.d.heartbeatMs);
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
    for (const identityId of wakeDueTasks(this.d.db, this.d.clock))
      this.resident.schedule(identityId, 0);

    const policy = this.policy();
    const dispatched = dispatchRunnable(this.d.db, this.d.clock, {
      maxConcurrentPerIdentity: policy.executions.maxConcurrentPerIdentity,
      maxConcurrentGlobal: policy.executions.maxConcurrentGlobal,
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
    this.ear.flush();
    this.resident.flush();
    while (this.inflight.size > 0) await Promise.allSettled(this.inflight);
    this.log.info("service stopped");
  }

  reloadPolicy(): void {
    const result = this.d.policyStore.reload();
    if (result.ok) this.log.info("policy reloaded");
    else
      this.log.error("policy reload rejected — keeping last-known-good", { errors: result.errors });
  }

  onInbound(msg: MessageEvent): void {
    const event = routeMessage(this.d.db, this.d.clock, msg, {
      botUserId: this.d.botPrincipalId,
      botName: this.d.botName,
      nameOf: this.d.nameOf,
      policy: this.policy(),
      onUnboundVenue: (venueId) => {
        this.log.warn("message from unbound venue", { venueId });
      },
    });
    if (!event) return;
    const mode = event.addressMode;
    if (mode === "mention" || mode === "dm") {
      const title = event.text
        .replaceAll(/<@[^>]+>/g, "")
        .replaceAll(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      void this.d.web.agents.sessions
        .setStatus({
          channel_id: event.venueId,
          thread_ts: event.threadRootId ?? event.ts,
          status: "processing",
          ...(title ? { title } : {}),
        })
        .catch(() => {});
      this.resident.schedule(event.identityId, 0);
    }
    this.scheduleEar(event.identityId);
  }

  identityById(id: string): IdentityConfig | undefined {
    return this.policy().identities.find((identity) => identity.id === id);
  }

  workspaceFor(identityId: string): string {
    const dir = join(this.d.cwd, identityId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  track(promise: Promise<unknown>): void {
    this.inflight.add(promise);
    void promise.finally(() => {
      this.inflight.delete(promise);
    });
  }

  scheduleEar(identityId: string): void {
    this.ear.schedule(identityId, this.identityById(identityId)?.ambient.eventDebounceMs ?? 20_000);
  }
}

async function runEarPass(host: Service, identityId: string): Promise<void> {
  const convos = unjudgedConversations(host.d.db, host.d.clock, identityId);
  if (convos.length === 0) return;
  const effects: TurnEffect[] = [];
  const refs = makeRefTable();
  const prompt = buildEarPrompt(host, identityId, convos, refs);
  let status: TurnStatus = "failed";
  try {
    status = await runEarSession(host, identityId, prompt, effects, refs);
  } catch (error) {
    host.log.error("ear pass threw", { identityId, error: String(error) });
  } finally {
    markJudged(host.d.db, host.d.clock, convos);
  }
  if (status !== "succeeded")
    host.log.warn("ear pass did not succeed — waking with the batch unjudged", {
      identityId,
      status,
    });
  const woke = effects.some(
    (effect) => effect.kind === "ear_verdict" && effect.decision === "wake",
  );
  if (woke || status !== "succeeded") host.resident.schedule(identityId, 0);
}
