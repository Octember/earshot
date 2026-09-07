import { inject, injectAll, singleton } from "tsyringe";
import { WebClient } from "@slack/web-api";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import { Codex } from "./codex";
import { convoKey } from "./inbox";
import { Inboxes } from "./inboxes";
import { LEDGER, type Ledger } from "./ledger/db";
import { markTasksSeen, unseenTaskUpdates } from "./ledger/tasks-query";
import { log } from "./log";
import { POLICY, type Policy } from "./policy";
import { Acts } from "./acts";
import { LEGEND, Renderer } from "./render";
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
    private readonly inboxes: Inboxes,
    private readonly workspaces: Workspaces,
    private readonly renderer: Renderer,
    private readonly soul: Soul,
  ) {}

  async run(identityId: string): Promise<void> {
    const identity = this.policy.identities.find((i) => i.id === identityId);
    if (!identity) return;
    const inbox = this.inboxes.of(identityId);
    const convos = this.inboxes.admitted(identityId, inbox.pending());
    if (convos.length === 0) return;
    this.soul.refresh();

    const direct = convos.filter((convo) => convo.heard.some((h) => h.direct));
    const acts = new Acts(this.web, this.db, inbox, identityId);
    const taskUpdates = unseenTaskUpdates(this.db, identityId);
    const rendered = await this.renderer.batch(identityId, convos, "you");
    const tasksSection =
      taskUpdates.length > 0
        ? `\n\nTasks:\n${taskUpdates
            .map(
              (task) =>
                `- <#${task.homeVenueId}>${task.homeThreadRootId ? ` thread=${task.homeThreadRootId}` : ""} · ${task.id} "${task.title}" · ${task.status === "done" ? `${task.outcome}: ${task.report}` : `waiting on a human: ${task.waitingWhy}`}`,
            )
            .join("\n")}`
        : "";
    const prompt = `${LEGEND}${rendered}${tasksSection}`;
    const tools = [
      taskCreateTool(this.db, identity, acts),
      taskSteerTool(this.db, identity, acts),
      taskCancelTool(this.db, identity, acts),
      replyTool(identity, acts),
      reactTool(identity, acts),
      stepBackTool(this.db, identity, acts),
      taskQueryTool(this.db, identity),
      ...this.tools,
    ];
    const { turns } = this.policy;
    const cwd = this.workspaces.for(identityId);

    let failure: string | null = null;
    try {
      for (let attempt = 0; ; attempt++) {
        const session = this.codex.resident(tools);
        try {
          await session.start(cwd);
          await session.runTurn(
            await session.startThread(cwd),
            cwd,
            prompt,
            `resident:${identityId}`,
          );
          failure = null;
          break;
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        } finally {
          session.stop();
        }
        if (acts.done.size > 0 || attempt >= turns.max_retries) break;
        log.warn("resident wake died before acting — retrying", { identityId, attempt, failure });
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
      inbox.take(convos);
      if (failure === null) markTasksSeen(this.db, taskUpdates);
    }
  }
}
