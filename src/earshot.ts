import { homedir } from "node:os";
import { join } from "node:path";
import {
  dbReadTool,
  githubApiTool,
  linearGraphqlTool,
  notionApiTool,
  opsReadTool,
  slackApiTool,
} from "@bevyl-ai/agent-tools";
import { SocketModeClient } from "@slack/socket-mode";
import type { MessageEvent } from "@slack/types";
import { WebClient } from "@slack/web-api";
import { inject, instanceCachingFactory, registry, singleton } from "tsyringe";
import { Inbox, textOf, userOf } from "./inbox";
import { LEDGER, openLedger } from "./ledger/db";
import { log } from "./log";
import { loadPolicy, POLICY, POLICY_PATH, type Policy } from "./policy";
import { Roster } from "./roster";
import { Scheduler } from "./scheduler";
import { BOT_USER_ID, TOOL, WORKSPACE } from "./tokens";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

@registry([
  { token: BOT_USER_ID, useFactory: () => requireEnv("SLACK_BOT_USER_ID") },
  {
    token: WORKSPACE,
    useFactory: () => process.env.EARSHOT_WORKSPACE ?? join(homedir(), "earshot-workspace"),
  },
  { token: POLICY_PATH, useFactory: () => process.env.EARSHOT_POLICY ?? "./policy.yaml" },
  { token: POLICY, useFactory: instanceCachingFactory((c) => loadPolicy(c.resolve(POLICY_PATH))) },
  {
    token: LEDGER,
    useFactory: instanceCachingFactory(() => openLedger(process.env.EARSHOT_DB ?? "./earshot.db")),
  },
  {
    token: WebClient,
    useFactory: instanceCachingFactory(() => new WebClient(requireEnv("SLACK_BOT_TOKEN"))),
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
    useFactory: instanceCachingFactory(() =>
      slackApiTool(
        "slack_api",
        requireEnv("SLACK_BOT_TOKEN"),
        "Any Slack Web API method with its documented arguments; raw response back. Posting and reacting go through reply and react.",
      ),
    ),
  },
])
@singleton()
export class Earshot {
  constructor(
    @inject(POLICY) private readonly policy: Policy,
    @inject(BOT_USER_ID) private readonly botUserId: string,
    private readonly web: WebClient,
    private readonly roster: Roster,
    private readonly inbox: Inbox,
    private readonly scheduler: Scheduler,
  ) {}

  async start(): Promise<void> {
    await this.roster.load();
    this.scheduler.start();
    log.info("service started");
  }

  onInbound(event: MessageEvent): void {
    const user = userOf(event);
    if (user === this.botUserId) return;
    const isDm = event.channel_type === "im";
    const isBot =
      ("bot_id" in event && event.bot_id !== undefined) || event.subtype === "bot_message";
    const trusted = !isBot || this.policy.trusted_bot_principals.includes(user ?? "");
    const text = textOf(event);
    const direct = trusted && (isDm || text.includes(`<@${this.botUserId}>`));
    const convo = this.inbox.push(event, direct);
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
      this.scheduler.wakeSoon();
    } else this.scheduler.listenSoon(this.policy.ambient.event_debounce_ms);
  }
}
