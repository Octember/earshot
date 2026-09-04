import { markTasksSeen, unseenTaskUpdates } from "./ledger/tasks-query";
import { outOf } from "./ledger/stance";
import { convoKey, type Conversation } from "./inbox";
import type { Service } from "./service";
import { postReply, type WakePostContext } from "./service-wake-post";
import { LEGEND, renderBatch } from "./render";
import { residentToolset } from "./turn-runner/toolset";
import { runTurn, type TurnStatus } from "./turn-runner/turn";
import { refreshSoul } from "./service-soul";
import type { AgentEvent, DynamicTool } from "@bevyl-ai/agent-tools";

export function admitted(
  host: Service,
  identityId: string,
  convos: Conversation[],
): { heard: { convo: Conversation; out: string | null }[]; dropped: Conversation[] } {
  const heard: { convo: Conversation; out: string | null }[] = [];
  const dropped: Conversation[] = [];
  for (const convo of convos) {
    const out = outOf(host.db, identityId, convo.channel, convo.threadTs);
    const engaged = convo.wakeWhy !== null || convo.heard.some((h) => h.direct);
    if (out !== null && !engaged) dropped.push(convo);
    else heard.push({ convo, out });
  }
  return { heard, dropped };
}

export async function runWake(host: Service, identityId: string): Promise<void> {
  const identity = host.identityById(identityId);
  if (!identity) return;
  const inbox = host.inboxOf(identityId);
  const { heard, dropped } = admitted(host, identityId, inbox.pending());
  inbox.take(dropped);
  if (heard.length === 0) return;
  refreshSoul(host);

  const convos = heard.map(({ convo }) => convo);
  const direct = convos.filter((convo) => convo.heard.some((h) => h.direct));
  const post: WakePostContext = {
    host,
    identityId,
    inbox,
    startSeq: inbox.tail,
    acts: new Set(),
    answered: new Set(),
    moved: new Set(),
  };
  const taskUpdates = unseenTaskUpdates(host.db, identityId);
  const rendered = await renderBatch(host, heard, { selfLabel: "you", mark: " → you" });
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
  const tools = residentToolset({ host, identity, post });

  let status: TurnStatus = "failed";
  try {
    const attempt = await runResidentAttempts(host, identityId, prompt, tools, post);
    status = attempt.status;
    if (status !== "succeeded" && direct.length > 0) {
      const text = `can't run right now — ${attempt.cause || "my agent runtime failed"}. try me again, or flag the operator if it keeps up.`;
      for (const convo of direct) {
        const key = convoKey(convo.channel, convo.threadTs);
        if (post.answered.has(key)) continue;
        post.moved.add(key);
        await postReply(post, { venueId: convo.channel, threadRootId: convo.threadTs }, text);
      }
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
    if (status === "succeeded") markTasksSeen(host.db, taskUpdates);
  }
  host.maybeTick();
  if (inbox.pending().length > 0) host.resident.schedule(identityId, 0);
}

async function runResidentAttempts(
  host: Service,
  identityId: string,
  prompt: string,
  tools: DynamicTool[],
  post: WakePostContext,
): Promise<{ status: TurnStatus; cause: string }> {
  const turns = host.policy.turns;
  const cwd = host.workspaceFor(identityId);
  let status: TurnStatus = "failed";
  let cause = "";
  for (let attempt = 0; attempt <= turns.max_retries; attempt++) {
    const session = host.sessionFactory(
      tools,
      (agentEvent: AgentEvent) => {
        if (agentEvent.log) host.log.info("codex", { line: agentEvent.log });
      },
      { turnTimeoutMs: turns.interactive_timeout_ms },
    );
    try {
      await session.start(cwd);
      const result = await runTurn({
        session,
        threadId: await session.startThread(cwd),
        cwd,
        prompt,
        title: `resident:${identityId}`,
        stallTimeoutMs: turns.stall_timeout_ms,
      });
      status = result.status;
      cause = result.cause ?? "";
    } catch (error) {
      status = "failed";
      cause = error instanceof Error ? error.message : String(error);
    } finally {
      session.stop();
    }
    if (status === "succeeded" || post.acts.size > 0) break;
    host.log.warn("resident wake died before acting — retrying", {
      identityId,
      attempt,
      status,
      cause,
    });
    if (attempt < turns.max_retries)
      await new Promise<void>((resolve) => {
        setTimeout(resolve, turns.backoff_ms * 2 ** attempt);
      });
  }
  return { status, cause };
}
