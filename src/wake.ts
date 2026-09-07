import { inject, injectAll, singleton } from "tsyringe";
import { WebClient } from "@slack/web-api";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import { Acts } from "./acts";
import { Codex } from "./codex";
import { convoKey, Inbox } from "./inbox";
import { LEDGER, type Ledger } from "./ledger/db";
import { markTasksSeen, unseenTaskUpdates } from "./ledger/tasks-query";
import { log } from "./log";
import { POLICY, type Policy } from "./policy";
import { PromptRenderer } from "./prompt-renderer";
import { Soul } from "./soul";
import { TOOL } from "./tokens";
import { taskCancelTool, taskCreateTool, taskQueryTool, taskSteerTool } from "./tools-tasks";
import { reactTool, replyTool, stepBackTool } from "./tools-presence";
import { Workspaces } from "./workspaces";

@singleton()
export class Wake {
  constructor(
    @inject(LEDGER) private readonly db: Ledger,
    @inject(POLICY) private readonly policy: Policy,
    private readonly codex: Codex,
    private readonly web: WebClient,
    @injectAll(TOOL) private readonly tools: DynamicTool[],
    private readonly inbox: Inbox,
    private readonly workspaces: Workspaces,
    private readonly prompts: PromptRenderer,
    private readonly soul: Soul,
  ) {}

  async run(): Promise<void> {
    const convos = this.inbox.pending();
    if (convos.length === 0) return;
    this.soul.refresh();

    const direct = convos.filter((convo) => convo.heard.some((h) => h.direct));
    const acts = new Acts(this.web, this.db, this.inbox);
    const taskUpdates = unseenTaskUpdates(this.db);
    const prompt = await this.prompts.wake(convos, taskUpdates);
    const tools = [
      taskCreateTool(this.db, acts),
      taskSteerTool(this.db, acts),
      taskCancelTool(this.db, acts),
      replyTool(acts),
      reactTool(acts),
      stepBackTool(this.db, acts),
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
        if (acts.done.size > 0 || attempt >= turns.max_retries) break;
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
        void this.web.agents.sessions
          .setStatus({
            channel_id: convo.channel,
            thread_ts: convo.threadTs,
            status: acts.answered.has(convoKey(convo.channel, convo.threadTs))
              ? "active"
              : "closed",
          })
          .catch(() => {});
      }
      this.inbox.take(convos);
      if (failure === null) markTasksSeen(this.db, taskUpdates);
    }
  }
}
