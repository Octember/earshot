import { inject, injectAll, singleton } from "tsyringe";
import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import { tasks } from "./ledger/schema";
import { WebClient } from "@slack/web-api";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import { Codex } from "./codex";
import { Acts, convoKey } from "./acts";
import { DB, LedgerService, type Db } from "./ledger-service";
import { now } from "./clock";
import { log } from "./log";
import { POLICY, type Policy } from "./policy";
import { PromptRenderer } from "./prompt-renderer";
import { TOOL } from "./tokens";
import { taskCancelTool, taskCreateTool, taskQueryTool, taskSteerTool } from "./tools-tasks";
import { muteThreadTool, reactTool, replyTool } from "./tools-presence";
import { Workspaces } from "./workspaces";

@singleton()
export class Wake {
  constructor(
    @inject(DB) private readonly db: Db,
    private readonly ledger: LedgerService,
    @inject(POLICY) private readonly policy: Policy,
    private readonly codex: Codex,
    private readonly web: WebClient,
    @injectAll(TOOL) private readonly tools: DynamicTool[],
    private readonly workspaces: Workspaces,
    private readonly prompts: PromptRenderer,
  ) {}

  async run(): Promise<void> {
    const started = now();
    const convos = this.db.query.conversations.findMany().sync();
    if (convos.length === 0) return;
    this.ledger.forgetAll();

    const direct = convos.filter((convo) => convo.direct);
    const acts = new Acts(this.web, this.db, this.ledger);
    const taskUpdates = this.db.query.tasks
      .findMany({
        where: and(
          or(eq(tasks.status, "done"), eq(tasks.waitingOn, "human")),
          or(isNull(tasks.seenAt), gt(tasks.updatedAt, tasks.seenAt)),
        ),
        orderBy: asc(tasks.updatedAt),
      })
      .sync();
    const prompt = await this.prompts.wake(convos, taskUpdates);
    const tools = [
      taskCreateTool(this.ledger),
      taskSteerTool(this.ledger),
      taskCancelTool(this.ledger),
      replyTool(acts),
      reactTool(acts),
      muteThreadTool(this.ledger),
      taskQueryTool(this.db),
      ...this.tools,
    ];
    const { turns } = this.policy;
    const cwd = this.workspaces.home;

    let failure: string | null = null;
    try {
      for (let attempt = 0; ; attempt++) {
        const session = this.codex.resident(tools);
        try {
          await session.start(cwd);
          await session.runTurn(await session.startThread(cwd), cwd, prompt, "resident");
          failure = null;
          break;
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        } finally {
          session.stop();
        }
        if (acts.done.size > 0 || this.ledger.changedSince(started) || attempt >= turns.max_retries)
          break;
        log.warn("resident wake died before acting — retrying", { attempt, failure });
        await new Promise<void>((resolve) => {
          setTimeout(resolve, turns.backoff_ms * 2 ** attempt);
        });
      }
      if (failure !== null)
        for (const convo of direct) {
          const key = convoKey(convo.channel, convo.threadTs);
          if (acts.answered.has(key)) continue;
          acts.moved.add(key);
          await acts.reply(
            convo.channel,
            convo.threadTs,
            `can't run right now — ${failure}. try me again, or flag the operator if it keeps up.`,
          );
        }
    } finally {
      for (const convo of direct) {
        void this.web.agents.sessions.setStatus({
          channel_id: convo.channel,
          thread_ts: convo.threadTs,
          status: acts.answered.has(convoKey(convo.channel, convo.threadTs)) ? "active" : "closed",
        });
      }
      if (failure === null) this.ledger.markTasksSeen(taskUpdates);
    }
  }
}
