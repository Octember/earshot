import { markTasksSeen, unseenTaskUpdates } from "./ledger/tasks-query";
import { outOf } from "./ledger/stance";
import { convoKey, type Conversation } from "./inbox";
import { log } from "./log";
import { codexSession } from "./main-codex";
import type { Service } from "./service";
import { postReply, type WakePostContext } from "./service-wake-post";
import { LEGEND, renderBatch } from "./render";
import { taskCancelTool, taskCreateTool, taskQueryTool, taskSteerTool } from "./tools-tasks";
import { reactTool, replyTool, stepBackTool } from "./tools-presence";
import { refreshSoul } from "./soul";

export function admitted(
  host: Service,
  identityId: string,
  convos: Conversation[],
): Conversation[] {
  const dropped = convos.filter(
    (convo) =>
      convo.wakeWhy === null &&
      !convo.heard.some((h) => h.direct) &&
      outOf(host.db, identityId, convo.channel, convo.threadTs) !== null,
  );
  host.inboxOf(identityId).take(dropped);
  return convos.filter((convo) => !dropped.includes(convo));
}

export async function runWake(host: Service, identityId: string): Promise<void> {
  const identity = host.identityById(identityId);
  if (!identity) return;
  const inbox = host.inboxOf(identityId);
  const convos = admitted(host, identityId, inbox.pending());
  if (convos.length === 0) return;
  refreshSoul(host);

  const direct = convos.filter((convo) => convo.heard.some((h) => h.direct));
  const post: WakePostContext = {
    host,
    identityId,
    startSeq: inbox.seq,
    acts: new Set(),
    answered: new Set(),
    moved: new Set(),
  };
  const taskUpdates = unseenTaskUpdates(host.db, identityId);
  const rendered = await renderBatch(host, identityId, convos, "you");
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
    taskCreateTool(host, identity, post),
    taskSteerTool(host, identity, post),
    taskCancelTool(host, identity, post),
    replyTool(identity, post),
    reactTool(identity, post),
    stepBackTool(host, identity, post),
    taskQueryTool(host, identity),
    ...host.tools,
  ];
  const { turns } = host.policy;
  const cwd = host.workspaceFor(identityId);

  let failure: string | null = null;
  try {
    for (let attempt = 0; ; attempt++) {
      const session = codexSession(
        tools,
        (agentEvent) => {
          if (agentEvent.log) log.info("codex", { line: agentEvent.log });
        },
        { turnTimeoutMs: turns.interactive_timeout_ms, stallTimeoutMs: turns.stall_timeout_ms },
      );
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
      if (post.acts.size > 0 || attempt >= turns.max_retries) break;
      log.warn("resident wake died before acting — retrying", { identityId, attempt, failure });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, turns.backoff_ms * 2 ** attempt);
      });
    }
    if (failure !== null)
      for (const convo of direct) {
        const key = convoKey(convo.channel, convo.threadTs);
        if (post.answered.has(key)) continue;
        post.moved.add(key);
        await postReply(
          post,
          convo.channel,
          convo.threadTs,
          `can't run right now — ${failure}. try me again, or flag the operator if it keeps up.`,
        );
      }
  } finally {
    for (const convo of direct) {
      void host.web.agents.sessions
        .setStatus({
          channel_id: convo.channel,
          thread_ts: convo.threadTs,
          status: post.answered.has(convoKey(convo.channel, convo.threadTs)) ? "active" : "closed",
        })
        .catch(() => {});
    }
    inbox.take(convos);
    if (failure === null) markTasksSeen(host.db, taskUpdates);
  }
  host.tick();
  if (inbox.pending().length > 0) host.resident.schedule(identityId, 0);
}
