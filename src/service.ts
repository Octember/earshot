import { runWake } from "./service-wake";
import { runEarPass } from "./service-ear-pass";
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
import type { IdentityConfig, Policy } from "./policy/schema";
import type { Logger } from "./log";
import { launchExecution } from "./service-execution";
import { refreshSoul } from "./service-soul";
import type { ServiceDeps } from "./service-util";
import { Inbox, textOf, userOf } from "./inbox";
import type { RenderDeps } from "./render";

function bindVenue(policy: Policy, venueId: string, isDm: boolean): string | null {
  for (const identity of policy.identities) {
    if (identity.venueIds.includes(venueId)) return identity.id;
  }
  if (isDm && policy.defaultDmIdentity) return policy.defaultDmIdentity;
  for (const identity of policy.identities) {
    if (identity.venueIds.includes("*")) return identity.id;
  }
  return null;
}

export class Service {
  readonly d: ServiceDeps;
  readonly log: Logger;
  readonly inflight = new Set<Promise<unknown>>();
  readonly resident: Debounced;
  readonly ear: Debounced;
  readonly render: RenderDeps;
  private readonly inboxes = new Map<string, Inbox>();
  stopping = false;
  private heartbeat: ReturnType<typeof setTimeout> | null = null;
  private ticksSinceCheckpoint = 0;

  constructor(deps: ServiceDeps) {
    this.d = deps;
    this.log = deps.logger;
    this.render = { web: deps.web, botUserId: deps.botPrincipalId, nameOf: deps.nameOf };
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

  inboxOf(identityId: string): Inbox {
    let inbox = this.inboxes.get(identityId);
    if (!inbox) {
      inbox = new Inbox();
      this.inboxes.set(identityId, inbox);
    }
    return inbox;
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

  onInbound(event: MessageEvent): void {
    const user = userOf(event);
    if (user === this.d.botPrincipalId) return;
    const policy = this.policy();
    const isDm = event.channel_type === "im";
    const identityId = bindVenue(policy, event.channel, isDm);
    if (!identityId) {
      this.log.warn("message from unbound venue", { venueId: event.channel });
      return;
    }
    const isBot =
      ("bot_id" in event && event.bot_id !== undefined) || event.subtype === "bot_message";
    const trusted = !isBot || policy.trustedBotPrincipals.includes(user ?? "");
    const text = textOf(event);
    const direct = trusted && (isDm || text.includes(`<@${this.d.botPrincipalId}>`));
    const convo = this.inboxOf(identityId).push(event, direct);
    if (direct) {
      const title = text
        .replaceAll(/<@[^>]+>/g, "")
        .replaceAll(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      void this.d.web.agents.sessions
        .setStatus({
          channel_id: convo.channel,
          thread_ts: convo.threadTs,
          status: "processing",
          ...(title ? { title } : {}),
        })
        .catch(() => {});
      this.resident.schedule(identityId, 0);
    } else {
      this.ear.schedule(
        identityId,
        this.identityById(identityId)?.ambient.eventDebounceMs ?? 20_000,
      );
    }
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
}
