import { refreshSoul } from "./service-soul";
import { outOf, type PendingConversation } from "./ledger/conversations-stance";
import type { Event, TurnStatus } from "./ledger/schema";
import type { IdentityConfig } from "./policy/schema";
import { makeRefTable, type RefTable } from "./ledger/conversations-refs";
import type { Service } from "./service";
import { postReply, reactInWake, type WakePostContext } from "./service-wake-post";
import { renderBatch, renderConversation } from "./ledger/conversations-render";
import { buildToolset } from "./turn-runner/toolset";
import { REF_LEGEND, listedSection, refVenueLine } from "./prompt/format";
import { unseenTaskUpdates } from "./ledger/tasks-query";
import { homeAnchor } from "./ledger/tasks-types";
import type { Task } from "./ledger/schema";
import { runTurn } from "./turn-runner/turn";
import type { AgentEvent } from "@bevyl-ai/agent-tools";
import { isDirectAddress } from "./ledger/inbox";

function buildWakePrompt(
  host: Service,
  identityId: string,
  convos: PendingConversation[],
  refs: RefTable,
): { prompt: string; taskUpdates: Task[] } {
  const rendered = renderBatch(host.d.db, identityId, convos, refs, {
    mark: (message) => (isDirectAddress(message) ? " → you" : ""),
    selfLabel: "you",
  });
  const taskUpdates = unseenTaskUpdates(host.d.db, identityId);
  const prompt = [
    rendered ? REF_LEGEND + rendered : rendered,
    listedSection("Tasks", taskUpdates, (task) =>
      refVenueLine(
        refs,
        homeAnchor(task),
        `${task.id} "${task.title}" · ${task.status === "done" ? `${task.outcome}: ${task.report}` : `waiting on a human: ${task.waitingWhy}`}`,
      ),
    ),
  ].join("");
  return { prompt, taskUpdates };
}

export async function runResidentAttempts(
  state: WakeRunState,
): Promise<{ status: TurnStatus; failureCause: string }> {
  const { host, identityId, prompt, postCtx } = state;
  const turns = host.policy().turns;
  const cwd = host.workspaceFor(identityId);
  let status: TurnStatus = "failed";
  let failureCause = "";
  for (let attempt = 0; attempt <= turns.maxRetries; attempt++) {
    const session = host.d.sessionFactory(buildResidentToolset(state), (agentEvent: AgentEvent) => {
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
        db: host.d.db,
        clock: host.d.clock,
        turnId: host.d.newId(),
        identityId,
        kind: "resident",
        effects: postCtx.effects,
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
    const acted = postCtx.effects.length > 0;
    if (acted || (status === "succeeded" && state.direct.length === 0)) break;
    host.log.warn("resident wake attempt owes an answer — retrying", {
      identityId,
      attempt,
      status,
      cause: failureCause,
    });
    if (status !== "succeeded" && attempt < turns.maxRetries)
      await new Promise<void>((resolve) => {
        setTimeout(resolve, turns.backoffMs * 2 ** attempt);
      });
  }
  return { status, failureCause };
}

export function prepareWakeRun(
  host: Service,
  identityId: string,
  identity: IdentityConfig,
  convos: PendingConversation[],
  pending: Event[],
  postCtx: WakePostContext,
): WakeRunState {
  refreshSoul(host);
  const refs = makeRefTable();
  const direct = pending.filter((message) => isDirectAddress(message));
  const { prompt, taskUpdates } = buildWakePrompt(host, identityId, convos, refs);
  return {
    host,
    identityId,
    identity,
    convos,
    direct,
    postCtx,
    refs,
    taskUpdates,
    prompt,
  };
}

function buildResidentToolset(state: WakeRunState): ReturnType<typeof buildToolset> {
  const { host, identityId, identity, postCtx, refs } = state;
  return buildToolset({
    db: host.d.db,
    clock: host.d.clock,
    identity,
    turnKind: "resident",
    external: host.external,
    anchor: null,
    parkAfterMs: host.policy().tasks.parkAfterMs,
    permalink: host.d.permalink,
    postMessage: (anchor, text) => postReply(postCtx, anchor, text),
    reactTo: (venueId, ts, emoji, threadRootId) =>
      reactInWake(postCtx, venueId, ts, emoji, threadRootId),
    effects: postCtx.effects,
    refs,
    renderConversationCard: (target) => {
      return renderConversation(host.d.db, identityId, target, {
        newMessages: [],
        out: outOf(host.d.db, identityId, target.venueId, target.threadRootId),
        selfLabel: "you",
        beforeRowid: Number.MAX_SAFE_INTEGER,
        refs,
      });
    },
  });
}

type WakeRunState = {
  host: Service;
  identityId: string;
  identity: IdentityConfig;
  convos: PendingConversation[];
  direct: Event[];
  postCtx: WakePostContext;
  refs: RefTable;
  taskUpdates: Task[];
  prompt: string;
};
