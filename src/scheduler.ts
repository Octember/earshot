import { homedir } from "node:os";
import { join } from "node:path";
import { SocketModeClient } from "@slack/socket-mode";
import type { MessageEvent } from "@slack/types";
import type { MessageElement } from "@slack/web-api/dist/types/response/ConversationsRepliesResponse";
import { WebClient } from "@slack/web-api";
import { and, asc, desc, eq } from "drizzle-orm";
import { inject, instanceCachingFactory, registry, singleton } from "tsyringe";
import { Codex } from "./codex";
import { Debounced } from "./debounce";
import { DB, LedgerService, openDb, UNSEEN, WANTED, type Db } from "./ledger-service";
import { conversations, tasks } from "./ledger/schema";
import { log } from "./log";
import { loadPolicy, POLICY, POLICY_PATH, type Policy } from "./policy";
import { PromptRenderer } from "./prompt-renderer";
import { BOT_USER_ID, requireEnv, WORKSPACE } from "./tokens";
import { Voice } from "./voice";

const BATCH = 8;

const HEARD_SUBTYPES = new Set<string | undefined>([
  undefined,
  "bot_message",
  "file_share",
  "thread_broadcast",
]);

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
])
@singleton()
export class Scheduler {
  private readonly overheard = new Debounced("triage", () => this.triage());
  private readonly replies = new Debounced("respond", () => this.respond());

  constructor(
    @inject(DB) private readonly db: Db,
    private readonly ledger: LedgerService,
    @inject(POLICY) private readonly policy: Policy,
    @inject(BOT_USER_ID) private readonly botUserId: string,
    private readonly codex: Codex,
    private readonly voice: Voice,
    private readonly prompts: PromptRenderer,
  ) {
    this.tick();
    this.beat();
    this.overheard.schedule(0);
  }

  heard(event: MessageEvent): void {
    if (!HEARD_SUBTYPES.has(event.subtype)) return;
    const message: Pick<MessageElement, "user" | "bot_id" | "text" | "ts" | "thread_ts"> = event;
    if (message.user === this.botUserId) return;
    const text = message.text ?? "";
    const direct =
      !message.bot_id && (event.channel_type === "im" || text.includes(`<@${this.botUserId}>`));
    const threadTs = message.thread_ts ?? event.ts;
    if (!direct && this.ledger.muted(event.channel, threadTs)) return;
    this.ledger.heard(event.channel, threadTs, event.ts, direct);
    this.overheard.schedule(direct ? 0 : this.policy.ear_debounce_ms);
  }

  private async respond(): Promise<void> {
    const convos = this.db.query.conversations
      .findMany({
        where: WANTED,
        orderBy: [desc(conversations.direct), asc(conversations.since)],
        limit: BATCH,
      })
      .sync();
    const settled = this.db.query.tasks
      .findMany({ where: UNSEEN, orderBy: asc(tasks.updatedAt) })
      .sync();
    if (convos.length === 0 && settled.length === 0) return;
    const prompt = await this.prompts.response(convos, settled);
    const direct = convos.filter((convo) => convo.direct);
    this.ledger.rendered(convos, settled);
    this.voice.begin(direct);
    try {
      await this.codex.respond(prompt);
    } finally {
      this.voice.close(direct);
    }
    this.tick();
  }

  private async triage(): Promise<void> {
    const unjudged = this.db.query.conversations
      .findMany({
        where: and(eq(conversations.direct, false), eq(conversations.woken, false)),
        orderBy: asc(conversations.since),
        limit: BATCH,
      })
      .sync();
    if (unjudged.length > 0) {
      await this.codex.triage(await this.prompts.overheard(unjudged));
      this.ledger.held(unjudged);
    }
    this.tick();
  }

  private async runWorker(taskId: string): Promise<void> {
    const { executions } = this.policy;
    const task = () => this.db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }).sync();
    const first = task();
    if (first?.status !== "active") return;
    let turns = 0;
    await this.codex
      .runWorker(taskId, first.tier, () => {
        const t = task();
        return t?.status === "active" && turns++ < executions.max_turns ? t.spec : null;
      })
      .catch((error: unknown) => {
        log.warn("worker turn failed", { taskId, error: String(error) });
        if (task()?.status === "active") this.ledger.interrupt(taskId);
      });
    if (task()?.status === "active")
      this.ledger.transition(taskId, {
        type: "finish",
        outcome: "failed",
        report: `The worker used all ${executions.max_turns} turns without finishing.`,
      });
    const after = task();
    log.info("worker finished", {
      taskId,
      status: after?.status,
      outcome: after?.outcome,
      turns,
    });
    this.tick();
  }

  private beat(): void {
    setTimeout(() => {
      this.tick();
      this.beat();
    }, this.ledger.msUntilNextWake(60_000));
  }

  private tick(): void {
    this.ledger.wakeDueTasks();
    if (this.ledger.wantsResponse()) this.replies.schedule(0);
    for (const taskId of this.ledger.dispatchRunnable(this.policy.executions.max_concurrent))
      void this.runWorker(taskId);
  }
}
