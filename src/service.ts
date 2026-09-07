import {
  inject,
  injectAll,
  instanceCachingFactory,
  registry,
  singleton,
  type Disposable,
  type InjectionToken,
} from "tsyringe";
import {
  dbReadTool,
  githubApiTool,
  linearGraphqlTool,
  notionApiTool,
  opsReadTool,
  slackApiTool,
  type DynamicTool,
} from "@bevyl-ai/agent-tools";
import { runWake } from "./service-wake";
import { runEarPass } from "./service-ear-pass";
import { Debounced } from "./service-debounce";
import type { MessageEvent } from "@slack/types";
import { WebClient } from "@slack/web-api";
import { SocketModeClient } from "@slack/socket-mode";
import { homedir } from "node:os";
import { Roster } from "./roster";
import { Codex } from "./codex";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { LEDGER, openLedger, type Ledger } from "./ledger/db";
import {
  dispatchRunnable,
  msUntilNextWake,
  recoverFromRestart,
  wakeDueTasks,
} from "./ledger/scheduler";
import { POLICY, POLICY_PATH, loadPolicy, type IdentityConfig, type Policy } from "./policy";
import { log } from "./log";
import { launchExecution } from "./service-execution";
import { refreshSoul } from "./soul";
import { Inbox, textOf, userOf } from "./inbox";

export const TOOL: InjectionToken<DynamicTool> = Symbol("tool");
export const BOT_TOKEN: InjectionToken<string> = Symbol("botToken");
export const BOT_USER_ID: InjectionToken<string> = Symbol("botUserId");
export const WORKSPACE: InjectionToken<string> = Symbol("workspace");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

@registry([
  { token: BOT_TOKEN, useFactory: () => requireEnv("SLACK_BOT_TOKEN") },
  { token: BOT_USER_ID, useFactory: () => requireEnv("SLACK_BOT_USER_ID") },
  {
    token: WORKSPACE,
    useFactory: instanceCachingFactory(() => {
      const dir = process.env.EARSHOT_WORKSPACE ?? join(homedir(), "earshot-workspace");
      mkdirSync(dir, { recursive: true });
      return dir;
    }),
  },
  { token: POLICY_PATH, useFactory: () => process.env.EARSHOT_POLICY ?? "./policy.yaml" },
  { token: POLICY, useFactory: instanceCachingFactory((c) => loadPolicy(c.resolve(POLICY_PATH))) },
  {
    token: LEDGER,
    useFactory: instanceCachingFactory(() => openLedger(process.env.EARSHOT_DB ?? "./earshot.db")),
  },
  {
    token: WebClient,
    useFactory: instanceCachingFactory((c) => new WebClient(c.resolve(BOT_TOKEN))),
  },
  {
    token: SocketModeClient,
    useFactory: instanceCachingFactory(
      () => new SocketModeClient({ appToken: requireEnv("SLACK_APP_TOKEN") }),
    ),
  },
  { token: TOOL, useValue: linearGraphqlTool() },
  { token: TOOL, useValue: githubApiTool() },
  { token: TOOL, useValue: notionApiTool() },
  { token: TOOL, useValue: opsReadTool() },
  { token: TOOL, useValue: dbReadTool() },
  {
    token: TOOL,
    useFactory: instanceCachingFactory((c) =>
      slackApiTool(
        "slack_api",
        c.resolve(BOT_TOKEN),
        "Any Slack Web API method with its documented arguments; raw response back. Posting and reacting go through reply and react.",
      ),
    ),
  },
])
@singleton()
export class Service implements Disposable {
  readonly inflight = new Set<Promise<unknown>>();
  readonly resident: Debounced;
  readonly ear: Debounced;
  private readonly inboxes = new Map<string, Inbox>();
  stopping = false;
  private heartbeat: ReturnType<typeof setTimeout> | null = null;

  constructor(
    @inject(LEDGER) readonly db: Ledger,
    @inject(POLICY) readonly policy: Policy,
    readonly web: WebClient,
    readonly roster: Roster,
    readonly codex: Codex,
    @inject(BOT_USER_ID) readonly botPrincipalId: string,
    @inject(WORKSPACE) readonly cwd: string,
    @injectAll(TOOL) readonly tools: DynamicTool[],
  ) {
    this.resident = new Debounced(this, (id) => runWake(this, id));
    this.ear = new Debounced(this, (id) => runEarPass(this, id));
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
    await this.roster.load();
    recoverFromRestart(this.db, this.policy.executions.max_attempts);
    refreshSoul(this);
    log.info("service started");
    this.scheduleHeartbeat();
  }

  private scheduleHeartbeat(): void {
    if (this.stopping) return;
    this.heartbeat = setTimeout(
      () => {
        this.tick();
        this.scheduleHeartbeat();
      },
      msUntilNextWake(this.db, 60_000),
    );
  }

  tick(): void {
    if (this.stopping) return;
    try {
      for (const identityId of wakeDueTasks(this.db)) this.resident.schedule(identityId, 0);
      const dispatched = dispatchRunnable(this.db, {
        maxConcurrentPerIdentity: this.policy.executions.max_concurrent_per_identity,
        maxConcurrentGlobal: this.policy.executions.max_concurrent_global,
      });
      for (const taskId of dispatched) launchExecution(this, taskId);
    } catch (error) {
      log.error("tick failed", { error: String(error) });
    }
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    if (this.heartbeat) clearTimeout(this.heartbeat);
    this.ear.flush();
    this.resident.flush();
    while (this.inflight.size > 0) await Promise.allSettled(this.inflight);
    log.info("service stopped");
  }

  onInbound(event: MessageEvent): void {
    const user = userOf(event);
    if (user === this.botPrincipalId) return;
    const isDm = event.channel_type === "im";
    const identity = this.venueIdentity(event.channel, isDm);
    if (!identity) {
      log.warn("message from unbound venue", { venueId: event.channel });
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
