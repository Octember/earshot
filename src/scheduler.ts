import { homedir } from "node:os";
import { join } from "node:path";
import { SocketModeClient } from "@slack/socket-mode";
import type { MessageEvent } from "@slack/types";
import type { MessageElement } from "@slack/web-api/dist/types/response/ConversationsRepliesResponse";
import { WebClient } from "@slack/web-api";
import { and, asc, eq, gt, isNotNull, isNull, or } from "drizzle-orm";
import { inject, instanceCachingFactory, registry, singleton } from "tsyringe";
import { Codex } from "./codex";
import { Debounced } from "./debounce";
import { DB, LedgerService, openDb, type Db } from "./ledger-service";
import { conversations, tasks, type Conversation, type Task } from "./ledger/schema";
import { log } from "./log";
import { loadPolicy, POLICY, POLICY_PATH, type Policy } from "./policy";
import { PromptRenderer } from "./prompt-renderer";
import { BOT_USER_ID, requireEnv, WORKSPACE } from "./tokens";
import { Voice } from "./voice";
import { Workspaces } from "./workspaces";
import "./tools";

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
  private waking: Promise<void> | null = null;
  private wakeAgain = false;
  private readonly ears = new Debounced(() => this.listen());

  constructor(
    @inject(DB) private readonly db: Db,
    private readonly ledger: LedgerService,
    @inject(POLICY) private readonly policy: Policy,
    @inject(BOT_USER_ID) private readonly botUserId: string,
    private readonly codex: Codex,
    private readonly voice: Voice,
    private readonly workspaces: Workspaces,
    private readonly prompts: PromptRenderer,
  ) {
    this.tick();
    this.beat();
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
    if (direct) {
      this.voice.open({ channel: event.channel, threadTs });
      this.wakeSoon();
    } else this.ears.schedule(this.policy.ear_debounce_ms);
  }

  private wakeSoon(): void {
    if (this.waking) {
      this.wakeAgain = true;
      return;
    }
    this.waking = this.wake().finally(() => {
      this.waking = null;
      if (this.wakeAgain) {
        this.wakeAgain = false;
        this.wakeSoon();
      }
    });
  }

  private async wake(): Promise<void> {
    const convos = this.db.query.conversations.findMany().sync();
    const settled = this.db.query.tasks
      .findMany({
        where: and(
          or(eq(tasks.status, "done"), eq(tasks.waitingOn, "human")),
          or(isNull(tasks.seenAt), gt(tasks.updatedAt, tasks.seenAt)),
        ),
        orderBy: asc(tasks.updatedAt),
      })
      .sync();
    if (convos.length === 0 && settled.length === 0) return;
    const prompt = await this.prompts.wake(convos, settled);
    this.setup();
    await this.codex.resident().runOnce(this.workspaces.home, prompt, "resident");
    this.teardown(convos, settled);
  }

  private setup(): void {
    this.ledger.forgetAll();
    this.voice.begin();
  }

  private teardown(convos: Conversation[], settled: Task[]): void {
    this.ledger.markTasksSeen(settled);
    this.voice.close(convos.filter((convo) => convo.direct));
    this.tick();
  }

  private async listen(): Promise<void> {
    const convos = this.db.query.conversations
      .findMany({ where: eq(conversations.judged, false) })
      .sync();
    if (convos.length === 0) return;
    const prompt = await this.prompts.ear(convos);
    await this.codex.ear().runOnce(this.workspaces.ear, prompt, "ear");
    this.ledger.judged(convos);
    const woke = this.db.query.conversations
      .findFirst({ where: isNotNull(conversations.wakeWhy) })
      .sync();
    if (woke) this.wakeSoon();
  }

  private async execute(taskId: string): Promise<void> {
    const { executions } = this.policy;
    const task = () => this.db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }).sync();
    const first = task();
    if (first?.status !== "active") return;
    let turns = 0;
    await this.codex.worker(taskId, first.tier).runTurns(this.workspaces.home, taskId, () => {
      const t = task();
      return t?.status === "active" && turns++ < executions.max_turns ? t.spec : null;
    });
    if (task()?.status === "active")
      this.ledger.transition(taskId, {
        type: "wait",
        waitingOn: "timer",
        wakeAt: new Date(Date.now() + executions.backoff_ms).toISOString(),
      });
    const after = task();
    log.info("execution finished", {
      taskId,
      status: after?.status,
      outcome: after?.outcome,
      turns,
    });
    if (after?.status === "done" || after?.waitingOn === "human") this.wakeSoon();
    this.tick();
  }

  private beat(): void {
    setTimeout(() => {
      this.tick();
      this.beat();
    }, this.ledger.msUntilNextWake(60_000));
  }

  private tick(): void {
    if (this.ledger.wakeDueTasks()) this.wakeSoon();
    for (const taskId of this.ledger.dispatchRunnable(this.policy.executions.max_concurrent))
      void this.execute(taskId);
  }
}
