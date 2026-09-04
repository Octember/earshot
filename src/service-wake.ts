import type { Anchor } from "./ledger/tasks-types";
import { markTasksSeen, unseenTaskUpdates } from "./ledger/tasks-query";
import { homeAnchor } from "./ledger/tasks-types";
import { outOf } from "./ledger/stance";
import { convoKey, type Conversation } from "./inbox";
import type { Service } from "./service";
import { answeredKeys, postReply, type WakePostContext } from "./service-wake-post";
import { LEGEND, renderBatch } from "./render";
import { buildToolset } from "./turn-runner/toolset";
import { runTurn, type TurnStatus } from "./turn-runner/turn";
import { refreshSoul } from "./service-soul";
import type { AgentEvent } from "@bevyl-ai/agent-tools";

export function admitted(
  host: Service,
  identityId: string,
  convos: Conversation[],
): { heard: { convo: Conversation; out: string | null }[]; dropped: Conversation[] } {
  const heard: { convo: Conversation; out: string | null }[] = [];
  const dropped: Conversation[] = [];
  for (const convo of convos) {
    const out = outOf(host.d.db, identityId, convo.channel, convo.threadTs);
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
  const postCtx: WakePostContext = {
    host,
    identityId,
    inbox,
    startSeq: inbox.tail,
    effects: [],
    moved: new Set(),
    done: new Set(),
  };
  const taskUpdates = unseenTaskUpdates(host.d.db, identityId);
  const rendered = await renderBatch(host.render, heard, { selfLabel: "you", mark: " → you" });
  const tasksSection =
    taskUpdates.length > 0
      ? `\n\nTasks:\n${taskUpdates
          .map((task) => {
            const home = homeAnchor(task);
            return `- <#${home.venueId}>${home.threadRootId ? ` thread=${home.threadRootId}` : ""} · ${task.id} "${task.title}" · ${task.status === "done" ? `${task.outcome}: ${task.report}` : `waiting on a human: ${task.waitingWhy}`}`;
          })
          .join("\n")}`
      : "";
  const prompt = `${LEGEND}${rendered}${tasksSection}`;

  const tools = buildToolset({
    db: host.d.db,
    clock: host.d.clock,
    identity,
    turnKind: "resident",
    external: host.external,
    parkAfterMs: host.policy().tasks.parkAfterMs,
    post: postCtx,
    effects: postCtx.effects,
  });

  let status: TurnStatus = "failed";
  try {
    const attempt = await runResidentAttempts(host, identityId, prompt, tools, postCtx);
    status = attempt.status;
    await postFailureFallbacks(postCtx, direct, status, attempt.failureCause);
  } finally {
    const answered = answeredKeys(postCtx);
    for (const convo of direct) {
      const key = convoKey(convo.channel, convo.threadTs);
      void host.d.web.agents.sessions
        .setStatus({
          channel_id: convo.channel,
          thread_ts: convo.threadTs,
          status: answered.has(key) ? "active" : "closed",
        })
        .catch(() => {});
    }
    inbox.take(convos);
    if (status === "succeeded") markTasksSeen(host.d.db, taskUpdates);
  }
  host.maybeTick();
  if (inbox.pending().length > 0) host.resident.schedule(identityId, 0);
}

async function runResidentAttempts(
  host: Service,
  identityId: string,
  prompt: string,
  tools: ReturnType<typeof buildToolset>,
  postCtx: WakePostContext,
): Promise<{ status: TurnStatus; failureCause: string }> {
  const turns = host.policy().turns;
  const cwd = host.workspaceFor(identityId);
  let status: TurnStatus = "failed";
  let failureCause = "";
  for (let attempt = 0; attempt <= turns.maxRetries; attempt++) {
    const session = host.d.sessionFactory(tools, (agentEvent: AgentEvent) => {
      if (agentEvent.log) host.log.info("codex", { line: agentEvent.log });
    });
    try {
      await session.start(cwd);
      const result = await runTurn({
        session,
        threadId: await session.startThread(cwd),
        cwd,
        prompt,
        title: `resident:${identityId}`,
        timeoutMs: turns.interactiveTimeoutMs,
        stallTimeoutMs: turns.stallTimeoutMs,
      });
      status = result.status;
      failureCause = result.cause ?? "";
    } catch (error) {
      status = "failed";
      failureCause = error instanceof Error ? error.message : String(error);
    } finally {
      session.stop();
    }
    if (status === "succeeded" || postCtx.effects.length > 0) break;
    host.log.warn("resident wake died before acting — retrying", {
      identityId,
      attempt,
      status,
      cause: failureCause,
    });
    if (attempt < turns.maxRetries)
      await new Promise<void>((resolve) => {
        setTimeout(resolve, turns.backoffMs * 2 ** attempt);
      });
  }
  return { status, failureCause };
}

async function postFailureFallbacks(
  postCtx: WakePostContext,
  direct: Conversation[],
  status: TurnStatus,
  failureCause: string,
): Promise<void> {
  if (status === "succeeded" || direct.length === 0) return;
  const text = `can't run right now — ${failureCause || (status === "timed_out" ? "it ran out of time" : "my agent runtime failed")}. try me again, or flag the operator if it keeps up.`;
  const answered = answeredKeys(postCtx);
  for (const convo of direct) {
    const key = convoKey(convo.channel, convo.threadTs);
    if (answered.has(key)) continue;
    const anchor: Anchor = { venueId: convo.channel, threadRootId: convo.threadTs };
    postCtx.moved.add(key);
    await postReply(postCtx, anchor, text);
  }
}
