import { runWake } from "./service-wake";
import { runEarPass } from "./service-ear-pass";
import { Debounced } from "./service-debounce";
import type { MessageEvent } from "@slack/types";
import type { WebClient } from "@slack/web-api";
import type { AgentEvent, AppServerSession, DynamicTool } from "@bevyl-ai/agent-tools";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "./ledger/clock";
import type { Ledger } from "./ledger/db";
import {
  dispatchRunnable,
  msUntilNextWake,
  recoverFromRestart,
  wakeDueTasks,
} from "./ledger/scheduler";
import type { IdentityConfig, Policy } from "./policy";
import type { Logger } from "./log";
import { launchExecution } from "./service-execution";
import { refreshSoul } from "./service-soul";
import { Inbox, textOf, userOf } from "./inbox";

export type SessionFactory = (
  tools: DynamicTool[],
  onEvent?: (agentEvent: AgentEvent) => void,
  overrides?: {
    model?: string | undefined;
    effort?: string | undefined;
    turnTimeoutMs?: number | undefined;
  },
) => AppServerSession;

export class Service {
  readonly db: Ledger;
  readonly clock: Clock;
  policy: Policy;
  readonly web: WebClient;
  readonly nameOf: (principalId: string) => string | null;
  readonly botPrincipalId: string;
  readonly cwd: string;
  readonly tools: DynamicTool[];
  readonly sessionFactory: SessionFactory;
  readonly log: Logger;
  readonly inflight = new Set<Promise<unknown>>();
  readonly resident: Debounced;
  readonly ear: Debounced;
  private readonly inboxes = new Map<string, Inbox>();
  stopping = false;
  private heartbeat: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: {
    db: Ledger;
    clock: Clock;
    policy: Policy;
    web: WebClient;
    nameOf: (principalId: string) => string | null;
    botPrincipalId: string;
    cwd: string;
    tools: DynamicTool[];
    sessionFactory: SessionFactory;
    log: Logger;
  }) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.policy = deps.policy;
    this.web = deps.web;
    this.nameOf = deps.nameOf;
    this.botPrincipalId = deps.botPrincipalId;
    this.cwd = deps.cwd;
    this.tools = deps.tools;
    this.sessionFactory = deps.sessionFactory;
    this.log = deps.log;
    const stopping = () => this.stopping;
    const track = (promise: Promise<unknown>) => {
      this.track(promise);
    };
    this.resident = new Debounced((id) => runWake(this, id), stopping, track);
    this.ear = new Debounced((id) => runEarPass(this, id), stopping, track);
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
    const recovery = recoverFromRestart(this.db, this.clock, this.policy.executions.max_attempts);
    if (recovery.reopened.length > 0 || recovery.failed.length > 0)
      this.log.info("restart recovery", recovery);
    refreshSoul(this);
    this.log.info("service started");
    this.scheduleHeartbeat();
  }

  private scheduleHeartbeat(): void {
    if (this.stopping) return;
    this.heartbeat = setTimeout(
      () => {
        void this.tick()
          .catch((error: unknown) => {
            this.log.error("tick failed", { error: String(error) });
          })
          .finally(() => {
            this.scheduleHeartbeat();
          });
      },
      msUntilNextWake(this.db, this.clock, 60_000),
    );
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
    for (const identityId of wakeDueTasks(this.db, this.clock))
      this.resident.schedule(identityId, 0);
    const dispatched = dispatchRunnable(this.db, this.clock, {
      maxConcurrentPerIdentity: this.policy.executions.max_concurrent_per_identity,
      maxConcurrentGlobal: this.policy.executions.max_concurrent_global,
    });
    for (const taskId of dispatched) launchExecution(this, taskId);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeat) clearTimeout(this.heartbeat);
    this.ear.flush();
    this.resident.flush();
    while (this.inflight.size > 0) await Promise.allSettled(this.inflight);
    this.log.info("service stopped");
  }

  onInbound(event: MessageEvent): void {
    const user = userOf(event);
    if (user === this.botPrincipalId) return;
    const isDm = event.channel_type === "im";
    const identity = this.venueIdentity(event.channel, isDm);
    if (!identity) {
      this.log.warn("message from unbound venue", { venueId: event.channel });
      return;
    }
    const isBot =
      ("bot_id" in event && event.bot_id !== undefined) || event.subtype === "bot_message";
    const trusted = !isBot || this.policy.trusted_bot_principals.includes(user ?? "");
    const text = textOf(event);
    const direct = trusted && (isDm || text.includes(`<@${this.botPrincipalId}>`));
    const convo = this.inboxOf(identity.id).push(event, direct);
    if (direct) {
      const title = text
        .replaceAll(/<@[^>]+>/g, "")
        .replaceAll(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      void this.web.agents.sessions
        .setStatus({
          channel_id: convo.channel,
          thread_ts: convo.threadTs,
          status: "processing",
          ...(title ? { title } : {}),
        })
        .catch(() => {});
      this.resident.schedule(identity.id, 0);
    } else this.ear.schedule(identity.id, identity.ambient.event_debounce_ms);
  }

  private venueIdentity(venueId: string, isDm: boolean): IdentityConfig | undefined {
    const { identities, default_dm_identity } = this.policy;
    return (
      identities.find((identity) => identity.venue_ids.includes(venueId)) ??
      (isDm ? this.identityById(default_dm_identity ?? "") : undefined) ??
      identities.find((identity) => identity.venue_ids.includes("*"))
    );
  }

  identityById(id: string): IdentityConfig | undefined {
    return this.policy.identities.find((identity) => identity.id === id);
  }

  workspaceFor(identityId: string): string {
    const dir = join(this.cwd, identityId);
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
