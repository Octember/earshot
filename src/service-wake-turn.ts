import { refreshSoul } from "./service-soul";
import { stanceOf, type PendingConversation } from "./ledger/conversations-stance";
import type { Event, TurnStatus } from "./ledger/schema";
import type { IdentityConfig } from "./policy/schema";
import { makeRefTable, type RefTable } from "./ledger/conversations-refs";
import type { Service } from "./service";
import { postReply, reactInWake, type WakePostContext } from "./service-wake-post";
import { wakeWhyOf } from "./ledger/conversations-judgment";
import { renderConversation } from "./ledger/conversations-render";
import { buildToolset } from "./turn-runner/toolset";
import { REF_LEGEND, listedSection, refVenueLine } from "./prompt/format";
import { openItems } from "./ledger/attention";
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
  const rendered = convos
    .map((convo) =>
      renderConversation(host.d.db, identityId, convo, {
        newMessages: convo.messages,
        mark: (message) => (isDirectAddress(message) ? "· you " : ""),
        wakeWhy: wakeWhyOf(host.d.db, identityId, convo),
        stance: convo.stance,
        selfLabel: "you",
        beforeRowid: convo.messages[0]!.rowid - 1,
        refs,
      }),
    )
    .join("\n\n");
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
    listedSection(
      "Open",
      openItems(host.d.db, identityId),
      (item) =>
        refVenueLine(
          refs,
          item,
          item.what,
          Date.parse(host.d.clock()) - Date.parse(item.openedAt) > 48 * 60 * 60 * 1000
            ? " · stale"
            : "",
        ),
      { cap: 5, overflow: (hidden) => `(+${hidden} more)` },
    ),
  ].join("");
  return { prompt, taskUpdates };
}

export async function runResidentAttempts(
  state: WakeRunState,
): Promise<{ status: TurnStatus; failureCause: string }> {
  const { host, identityId, prompt, postCtx } = state;
  const turns = host.policy().turns;
  let status: TurnStatus = "failed";
  let failureCause = "";
  const onEvent = (agentEvent: AgentEvent) => {
    if (agentEvent.event === "turn_failed" && agentEvent.log) failureCause = agentEvent.log;
    if (agentEvent.log) host.log.info("codex", { line: agentEvent.log });
  };

  for (let attempt = 0; attempt <= turns.maxRetries; attempt++) {
    failureCause = "";
    const session = host.d.sessionFactory(buildResidentToolset(state), onEvent);
    try {
      await session.start(host.workspaceFor(identityId));
      const threadId = await session.startThread(host.workspaceFor(identityId));
      const result = await runTurn({
        session,
        threadId,
        cwd: host.workspaceFor(identityId),
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
      if (!failureCause && result.cause) failureCause = result.cause;
    } catch (error) {
      status = "failed";
      failureCause = error instanceof Error ? error.message : String(error);
    } finally {
      session.stop();
    }
    if (status === "succeeded") break;
    host.log.error("resident wake attempt did not succeed", {
      identityId,
      attempt,
      status,
      cause: failureCause,
    });
    if (postCtx.effects.length > 0) break;
    if (attempt < turns.maxRetries) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, turns.backoffMs * 2 ** attempt);
      });
    }
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
    catalog: host.catalog,
    anchor: null,
    parkAfterMs: host.policy().tasks.parkAfterMs,
    outwardScopeId: postCtx.wakeId,
    permalink: (venueId, ts) => host.d.adapter.permalink(venueId, ts),
    postMessage: (anchor, text) => postReply(postCtx, anchor, text),
    reactTo: (venueId, ts, emoji, threadRootId) =>
      reactInWake(postCtx, venueId, ts, emoji, threadRootId),
    effects: postCtx.effects,
    refs,
    renderConversationCard: (target) =>
      renderConversation(host.d.db, identityId, target, {
        newMessages: [],
        wakeWhy: wakeWhyOf(host.d.db, identityId, target),
        stance: stanceOf(host.d.db, identityId, target.venueId, target.threadRootId),
        selfLabel: "you",
        beforeRowid: Number.MAX_SAFE_INTEGER,
        refs,
      }),
    recentCharBudget: host.policy().memory.recentCharBudget,
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
