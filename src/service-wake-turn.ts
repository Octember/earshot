import { refreshSoul } from "./service-soul";
import { peekDrafts } from "./ledger/conversations-acts";
import { convoKey, stanceOf, type PendingConversation } from "./ledger/conversations-stance";
import type { Event, TurnStatus } from "./ledger/schema";
import type { Anchor } from "./ledger/tasks-types";
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
): { prompt: string; heldDrafts: ReturnType<typeof peekDrafts>; taskUpdates: Task[] } {
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
  const heldDrafts = peekDrafts(host.d.db, identityId);
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
    listedSection("Unsent", heldDrafts, (draft) => refVenueLine(refs, draft, draft.text)),
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
  return { prompt, heldDrafts, taskUpdates };
}

export async function runResidentAttempts(
  state: WakeRunState,
): Promise<{ status: TurnStatus; failureCause: string }> {
  const { host, identityId, prompt, postCtx } = state;
  const turns = host.policy().turns;
  const flushBuffered = async (turnStatus: TurnStatus) => {
    const toFlush = state.buffered.splice(0);
    if (turnStatus !== "succeeded") return;
    for (const pendingReply of toFlush)
      await postReply(postCtx, pendingReply.anchor, pendingReply.text, {
        awaitingReply: pendingReply.awaitingReply,
        bufferedAfter: state.batchTail,
      });
  };
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
        beforeRecord: flushBuffered,
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
    const obligationsMet =
      postCtx.effects.length > 0 &&
      (state.direct.length === 0 ||
        [...directConvoKeys(state.direct)].every((key) => postCtx.answeredConvos.has(key)));
    if (obligationsMet) {
      host.log.info("resident wake delivered outward effects — treating as success", {
        identityId,
        attempt,
        priorStatus: status,
        effects: postCtx.effects.length,
      });
      status = "succeeded";
      break;
    }
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
  const { prompt, heldDrafts, taskUpdates } = buildWakePrompt(host, identityId, convos, refs);
  return {
    host,
    identityId,
    identity,
    convos,
    direct,
    batchTail: pending.at(-1)!.rowid,
    postCtx,
    buffered: [],
    refs,
    heldDrafts,
    taskUpdates,
    prompt,
  };
}

function buildResidentToolset(state: WakeRunState): ReturnType<typeof buildToolset> {
  const { host, identityId, identity, postCtx, buffered, refs } = state;
  const directConvos = directConvoKeys(state.direct);
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
    postMessage: (anchor, text, opts) =>
      postReply(postCtx, anchor, text, { awaitingReply: opts?.awaitingReply }),
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
    bufferReply: (anchor, text, awaitingReply) => {
      if (directConvos.has(convoKey(anchor.venueId, anchor.threadRootId))) return false;
      buffered.push({ anchor, text, ...(awaitingReply ? { awaitingReply } : {}) });
      return true;
    },
    recentCharBudget: host.policy().memory.recentCharBudget,
  });
}

type WakeRunState = {
  host: Service;
  identityId: string;
  identity: IdentityConfig;
  convos: PendingConversation[];
  direct: Event[];
  batchTail: number;
  postCtx: WakePostContext;
  buffered: { anchor: Anchor; text: string; awaitingReply?: boolean }[];
  refs: RefTable;
  heldDrafts: ReturnType<typeof peekDrafts>;
  taskUpdates: Task[];
  prompt: string;
};

function directConvoKeys(direct: Event[]): Set<string> {
  return new Set(
    direct.flatMap((message) => [
      convoKey(message.venueId, message.threadRootId ?? message.payload.ts),
      ...(message.threadRootId ? [] : [convoKey(message.venueId, null)]),
    ]),
  );
}
