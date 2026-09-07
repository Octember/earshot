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
import type { MessageElement } from "@slack/web-api/dist/types/response/ConversationsRepliesResponse";
import { WebClient } from "@slack/web-api";
import { inject, instanceCachingFactory, registry, singleton } from "tsyringe";
import { DB, LedgerService, openDb } from "./ledger-service";
import { log } from "./log";
import { loadPolicy, POLICY, POLICY_PATH, type Policy } from "./policy";
import { Roster } from "./roster";
import { Scheduler } from "./scheduler";
import { BOT_USER_ID, TOOL, WORKSPACE } from "./tokens";

const HEARD_SUBTYPES = new Set<string | undefined>([
  undefined,
  "bot_message",
  "file_share",
  "thread_broadcast",
]);

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
    token: DB,
    useFactory: instanceCachingFactory(() => openDb(process.env.EARSHOT_DB ?? "./earshot.db")),
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
  ...[linearGraphqlTool(), githubApiTool(), notionApiTool(), opsReadTool(), dbReadTool()].map(
    (t) => ({ token: TOOL, useValue: t }),
  ),
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
    private readonly ledger: LedgerService,
    @inject(POLICY) private readonly policy: Policy,
    @inject(BOT_USER_ID) private readonly botUserId: string,
    private readonly web: WebClient,
    private readonly roster: Roster,
    private readonly scheduler: Scheduler,
  ) {}

  async start(): Promise<void> {
    await this.roster.load();
    this.scheduler.start();
    log.info("service started");
  }

  onInbound(event: MessageEvent): void {
    if (!HEARD_SUBTYPES.has(event.subtype)) return;
    const message: Pick<MessageElement, "user" | "bot_id" | "text" | "ts" | "thread_ts"> = event;
    if (message.user === this.botUserId) return;
    const text = message.text ?? "";
    const direct =
      !message.bot_id && (event.channel_type === "im" || text.includes(`<@${this.botUserId}>`));
    const threadTs = message.thread_ts ?? event.ts;
    if (!direct && this.ledger.muted(event.channel, threadTs)) return;
    this.ledger.heard(event.channel, threadTs, event.ts, direct);
    if (direct) {
      const title = text
        .replaceAll(/<@[^>]+>/g, "")
        .replaceAll(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      void this.web.agents.sessions.setStatus({
        channel_id: event.channel,
        thread_ts: threadTs,
        status: "processing",
        ...(title ? { title } : {}),
      });
      this.scheduler.wakeSoon();
    } else this.scheduler.listenSoon(this.policy.ear_debounce_ms);
  }
}
