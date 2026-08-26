import { openItems, closeAttentionItemsForThread } from "./ledger/attention";
import { messagesAfter } from "./ledger/inbox";
import {
  consumeJudgment,
  getConversationJudgment,
  pendingConversations,
  hasUndelivered,
  renderConversation,
  recordAct,
  setActTs,
  deleteAct,
  saveDraft,
  peekDrafts,
  markDraftsConsumed,
  engage,
  stanceOf,
  convoKey,
  makeRefTable,
  recentIdenticalPost,
} from "./ledger/conversations";
import type { Anchor } from "./ledger/tasks";
import type { TurnStatus } from "./ledger/turns";
import { runTurn } from "./turn-runner/turn";
import { buildToolset } from "./turn-runner/toolset";
import { ReplyStream } from "./adapter/reply-stream";
import type { AgentEvent } from "./turn-runner/types";
import { isDirectAddress, type ServiceHost } from "./service-util";

const ATTENTION_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const ATTENTION_PROMPT_CAP = 5;
// §14.2 restart-duplicate window: identical words from another wake → skip send, use landed id.
const POST_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

export function scheduleWake(host: ServiceHost, identityId: string, delayMs: number): void {
  if (host.stopping) return;
  if (delayMs <= 0) {
    const prior = host.residentDebounce.get(identityId);
    if (prior) {
      clearTimeout(prior);
      host.residentDebounce.delete(identityId);
    }
    runWake(host, identityId);
    return;
  }
  if (host.residentDebounce.has(identityId)) return; // first arm wins — the burst rides one wake
  host.residentDebounce.set(
    identityId,
    setTimeout(() => {
      host.residentDebounce.delete(identityId);
      if (!host.stopping) runWake(host, identityId);
    }, delayMs),
  );
}

export function runWake(host: ServiceHost, identityId: string): void {
  if (host.residentRunning.has(identityId)) {
    host.residentRerun.add(identityId);
    return;
  }
  host.residentRunning.add(identityId);
  const promise = (async () => {
    const identity = host.identityById(identityId);
    if (!identity) return;
    const convos = pendingConversations(host.d.db, identityId);
    if (convos.length === 0) return;
    const pending = convos.flatMap((convo) => convo.messages).toSorted((a, b) => a.rowid - b.rowid);
    const wakeId = host.d.newId();
    const addressed = pending.filter((message) => message.kind === "addressed_message");
    // §14.2 duties (fallback, answered gate, typing) only for mention/DM, not thread-follow.
    const direct = pending.filter((message) => isDirectAddress(message));
    const gatingMsg = addressed.at(-1) ?? pending.at(-1)!;
    const streams = new Map<string, ReplyStream>();
    const streamFor = (anchor: Anchor): ReplyStream => {
      const convoKeyStr = convoKey(anchor.venueId, anchor.threadRootId);
      let stream = streams.get(convoKeyStr);
      if (!stream) {
        const recipient =
          pending
            .toReversed()
            .find(
              (message) =>
                message.principalId &&
                convoKey(message.venueId ?? "", message.threadRootId ?? message.ts) === convoKeyStr,
            )?.principalId ?? null;
        stream = new ReplyStream({
          adapter: host.d.adapter,
          venueId: anchor.venueId,
          threadTs: anchor.threadRootId,
          recipient,
          log: host.log,
        });
        streams.set(convoKeyStr, stream);
      }
      return stream;
    };
    const effects: unknown[] = [];
    let failureCause = "";
    // §5.5: no direct address → buffer replies until turn end; withhold if newer addressed traffic.
    const batchTail = pending.at(-1)!.rowid;
    const buffered: { anchor: Anchor; text: string }[] = [];
    const directConvos = new Set(
      direct.flatMap((message) => [
        convoKey(message.venueId ?? "", message.threadRootId ?? message.ts),
        ...(message.threadRootId ? [] : [convoKey(message.venueId ?? "", null)]),
      ]),
    );
    const bufferReply = (anchor: Anchor, text: string): boolean => {
      if (directConvos.has(convoKey(anchor.venueId, anchor.threadRootId))) return false;
      buffered.push({ anchor, text });
      return true;
    };
    const flushBuffered = async (turnStatus: TurnStatus): Promise<void> => {
      const toFlush = buffered.splice(0); // each retry attempt re-decides from scratch
      if (turnStatus !== "succeeded") return; // a dead wake's half-sent words never post (same rule as clearCards)
      for (const pendingReply of toFlush) {
        const moved = messagesAfter(host.d.db, identityId, batchTail).some(
          (message) =>
            message.kind === "addressed_message" &&
            (message.venueId ?? "") === pendingReply.anchor.venueId &&
            (pendingReply.anchor.threadRootId === null
              ? message.threadRootId === null
              : (message.threadRootId ?? message.ts) === pendingReply.anchor.threadRootId),
        );
        if (moved) {
          saveDraft(
            host.d.db,
            host.d.clock,
            identityId,
            pendingReply.anchor.venueId,
            pendingReply.anchor.threadRootId,
            pendingReply.text,
          );
          effects.push({
            kind: "withheld",
            anchor: pendingReply.anchor,
            text: pendingReply.text,
          });
          continue;
        }
        const act = recordAct(host.d.db, host.d.clock, identityId, wakeId, {
          kind: "posted",
          venueId: pendingReply.anchor.venueId,
          threadRootId: pendingReply.anchor.threadRootId,
          ts: null,
          text: pendingReply.text,
        });
        if (!act.inserted) continue; // an earlier attempt of this wake already sent it
        if (
          recentIdenticalPost(
            host.d.db,
            host.d.clock,
            identityId,
            pendingReply.anchor.venueId,
            pendingReply.anchor.threadRootId,
            pendingReply.text,
            wakeId,
            POST_DEDUPE_WINDOW_MS,
            { unlessNewerEventArrived: true },
          )
        ) {
          deleteAct(host.d.db, wakeId, act.actKey); // a prior wake landed these exact words (§14.2 restart-duplicate)
          answeredConvos.add(
            convoKey(pendingReply.anchor.venueId, pendingReply.anchor.threadRootId),
          );
          continue;
        }
        let result: { messageId: string };
        try {
          const streamedId = await streamFor(pendingReply.anchor).post(pendingReply.text);
          result = streamedId
            ? { messageId: streamedId }
            : await host.postMessage(pendingReply.anchor, pendingReply.text);
        } catch (error) {
          deleteAct(host.d.db, wakeId, act.actKey);
          throw error;
        }
        if (result.messageId === "undelivered") {
          deleteAct(host.d.db, wakeId, act.actKey);
          saveDraft(
            host.d.db,
            host.d.clock,
            identityId,
            pendingReply.anchor.venueId,
            pendingReply.anchor.threadRootId,
            pendingReply.text,
          );
          effects.push({
            kind: "withheld",
            anchor: pendingReply.anchor,
            text: pendingReply.text,
          });
          continue;
        }
        setActTs(
          host.d.db,
          wakeId,
          act.actKey,
          result.messageId,
          pendingReply.anchor.threadRootId ?? result.messageId,
        );
        engage(
          host.d.db,
          host.d.clock,
          identityId,
          pendingReply.anchor.venueId,
          pendingReply.anchor.threadRootId ?? result.messageId,
        );
        closeAttentionItemsForThread(
          host.d.db,
          host.d.clock,
          identityId,
          pendingReply.anchor.venueId,
          pendingReply.anchor.threadRootId ?? null,
          "answered in thread",
        );
        effects.push({ kind: "posted", anchor: pendingReply.anchor, text: pendingReply.text });
      }
    };
    // §14.2 answered gate is per conversation, not wake-scoped.
    const answeredConvos = new Set<string>();
    const checklist = new Map<string, string>();
    const makeTools = () =>
      buildToolset({
        db: host.d.db,
        clock: host.d.clock,
        identity,
        turnKind: "resident",
        catalog: host.catalog,
        anchor: null,
        principal: host.principalOf(gatingMsg.principalId),
        resolvePrincipal: (id) => host.principalOf(id),
        nudgeAfterMs: host.policy().tasks.nudgeAfterMs,
        outwardScopeId: wakeId,
        permalink: (venueId, ts) => host.d.adapter.permalink?.(venueId, ts),
        postMessage: async (anchor, text) => {
          const act = recordAct(host.d.db, host.d.clock, identityId, wakeId, {
            kind: "posted",
            venueId: anchor.venueId,
            threadRootId: anchor.threadRootId,
            ts: null,
            text,
          });
          if (!act.inserted) return { messageId: "already-sent-this-wake" }; // a retry attempt re-issuing the identical post is a no-op
          const landed = recentIdenticalPost(
            host.d.db,
            host.d.clock,
            identityId,
            anchor.venueId,
            anchor.threadRootId,
            text,
            wakeId,
            POST_DEDUPE_WINDOW_MS,
            { unlessNewerEventArrived: true },
          );
          if (landed) {
            deleteAct(host.d.db, wakeId, act.actKey); // first wake's act already carries the words in the tail
            answeredConvos.add(convoKey(anchor.venueId, anchor.threadRootId));
            return { messageId: "already-landed" };
          }
          let result: { messageId: string };
          try {
            const streamedId = await streamFor(anchor).post(text);
            result = streamedId ? { messageId: streamedId } : await host.postMessage(anchor, text);
          } catch (error) {
            deleteAct(host.d.db, wakeId, act.actKey); // intent must not outlive a failed call
            throw error;
          }
          if (result.messageId === "undelivered") {
            deleteAct(host.d.db, wakeId, act.actKey);
            return result;
          }
          setActTs(
            host.d.db,
            wakeId,
            act.actKey,
            result.messageId,
            anchor.threadRootId ?? result.messageId,
          );
          engage(
            host.d.db,
            host.d.clock,
            identityId,
            anchor.venueId,
            anchor.threadRootId ?? result.messageId,
          );
          answeredConvos.add(convoKey(anchor.venueId, anchor.threadRootId));
          closeAttentionItemsForThread(
            host.d.db,
            host.d.clock,
            identityId,
            anchor.venueId,
            anchor.threadRootId ?? null,
            "answered in thread",
          );
          return result;
        },
        updateMessage: host.d.adapter.updateMessage
          ? (venueId, messageId, text) => host.d.adapter.updateMessage!(venueId, messageId, text)
          : undefined,
        renderChecklist: async (items, seat) => streamFor(seat).setCards(items),
        // React carries §14.2 answered mark + optimistic attention close for the target's conversation.
        reactTo: async (venueId, ts, emoji, threadRootId) => {
          const residence = threadRootId ?? ts;
          const act = recordAct(host.d.db, host.d.clock, identityId, wakeId, {
            kind: "reacted",
            venueId,
            threadRootId,
            ts,
            text: emoji,
          });
          if (!act.inserted) return; // already reacted in an earlier attempt of this wake
          try {
            await host.d.adapter.addReaction(venueId, ts, emoji);
          } catch (error) {
            deleteAct(host.d.db, wakeId, act.actKey); // a failed call is not "already reacted"
            throw error;
          }
          answeredConvos.add(convoKey(venueId, residence));
          closeAttentionItemsForThread(
            host.d.db,
            host.d.clock,
            identityId,
            venueId,
            residence,
            "reacted in thread",
          );
        },
        checklist,
        effects,
        // via='search' refs bounce once with the card (peek — must not advance watermarks).
        refs,
        renderConversationCard: (target: { venueId: string; threadRootId: string | null }) =>
          renderConversation(host.d.db, identityId, target, {
            newMessages: [],
            judgment:
              getConversationJudgment(host.d.db, identityId, target.venueId, target.threadRootId) ??
              undefined,
            stance: stanceOf(host.d.db, identityId, target.venueId, target.threadRootId),
            selfLabel: "you",
            beforeRowid: Number.MAX_SAFE_INTEGER,
            refs,
          }),
        bufferReply,
      });
    host.refreshSoul(); // a fresh thread must open with current memory + standing instructions
    // Peek judgment during assembly; commit consume+watermark in finally after the wake (re-deliver on crash).
    const refs = makeRefTable();
    const rendered = convos
      .map((convo) =>
        renderConversation(host.d.db, identityId, convo, {
          newMessages: convo.messages,
          mark: (message) => (isDirectAddress(message) ? "[to you] " : ""),
          judgment:
            getConversationJudgment(host.d.db, identityId, convo.venueId, convo.threadRootId) ??
            undefined,
          stance: convo.stance,
          selfLabel: "you",
          beforeRowid: convo.messages[0]!.rowid - 1,
          refs,
        }),
      )
      .join("\n\n");
    // §5.5 withheld replies surface on the next wake; via='search' so speak starts with the card.
    const heldDrafts = peekDrafts(host.d.db, identityId);
    const draftSection =
      heldDrafts.length > 0
        ? `\n\n[drafted last wake but not sent — the conversation had moved on; decide fresh what (if anything) to say]\n${heldDrafts.map((draft) => `- [${refs.mint({ venueId: draft.venueId, threadRootId: draft.threadRootId, via: "search" })}] to <#${draft.venueId}>${draft.threadRootId ? ` thread=${draft.threadRootId}` : ""}: ${draft.text}`).join("\n")}`
        : "";
    const owed = openItems(host.d.db, identityId);
    const owedSection =
      owed.length > 0
        ? `\n\n[still owed]\n${owed
            .slice(0, ATTENTION_PROMPT_CAP)
            .map((item) => {
              const overdue =
                Date.parse(host.d.clock()) - Date.parse(item.openedAt) > ATTENTION_MAX_AGE_MS;
              return `- [${refs.mint({ venueId: item.venueId, threadRootId: item.threadRootId, via: "search" })}] <#${item.venueId}>${item.threadRootId ? ` thread=${item.threadRootId}` : ""}: ${item.what}${overdue ? " (open a long time — settle it or drop it)" : ""}`;
            })
            .join(
              "\n",
            )}${owed.length > ATTENTION_PROMPT_CAP ? `\n(+${owed.length - ATTENTION_PROMPT_CAP} newer ones not shown — they surface as these settle)` : ""}`
        : "";
    const prompt = `${rendered}${draftSection}${owedSection}`;
    let status: TurnStatus = "failed";
    // Snapshot policy once — in-flight work finishes under the policy it started with.
    const turns = host.policy().turns;
    const onResidentEvent = (agentEvent: AgentEvent) => {
      if (agentEvent.event === "turn_failed" && agentEvent.log) failureCause = agentEvent.log;
      if (agentEvent.log) host.log.info("codex", { line: agentEvent.log });
    };
    try {
      // §14.2: retry a dead wake (fresh session) only while it has touched nothing.
      for (let attempt = 0; attempt <= turns.maxRetries; attempt++) {
        failureCause = "";
        const session = host.d.sessionFactory(makeTools(), onResidentEvent);
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
            effects,
            tokensUsed: () => 0,
            spendAmount: () => 0,
            envelope: {
              timeoutMs: turns.interactiveTimeoutMs,
              tokenCeiling: turns.interactiveTokenCeiling,
            },
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
        host.log.error("resident wake attempt did not succeed", {
          identityId,
          attempt,
          status,
          cause: failureCause,
        });
        if (effects.length > 0) break;
        if (attempt < turns.maxRetries) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, turns.backoffMs * 2 ** attempt);
          });
        }
      }
      // §14.2 carve-out: direct address and model died before answering → post fallback.
      if (status !== "succeeded" && direct.length > 0) {
        const owedConvos = new Map<string, { anchor: Anchor; aliases: string[] }>();
        for (const message of direct) {
          const anchor: Anchor = {
            venueId: message.venueId ?? "",
            threadRootId: message.threadRootId ?? message.ts,
          };
          const convoKeyStr = convoKey(anchor.venueId, anchor.threadRootId);
          if (!owedConvos.has(convoKeyStr))
            owedConvos.set(convoKeyStr, {
              anchor,
              aliases: [
                convoKeyStr,
                ...(message.threadRootId ? [] : [convoKey(anchor.venueId, null)]),
              ],
            });
        }
        const why =
          failureCause ||
          (status === "timed_out" ? "it ran out of time" : "my agent runtime failed");
        const fallbackText = `can't run right now — ${why}. try me again, or flag the operator if it keeps up.`;
        for (const { anchor, aliases } of owedConvos.values()) {
          if (aliases.some((alias) => answeredConvos.has(alias))) continue;
          const fallbackAct = recordAct(host.d.db, host.d.clock, identityId, wakeId, {
            kind: "posted",
            venueId: anchor.venueId,
            threadRootId: anchor.threadRootId,
            ts: null,
            text: fallbackText,
          });
          if (
            fallbackAct.inserted &&
            recentIdenticalPost(
              host.d.db,
              host.d.clock,
              identityId,
              anchor.venueId,
              anchor.threadRootId,
              fallbackText,
              wakeId,
              POST_DEDUPE_WINDOW_MS,
              { unlessNewerEventArrived: false },
            )
          ) {
            deleteAct(host.d.db, wakeId, fallbackAct.actKey); // a crash-looping boot must not stack apologies
          } else if (fallbackAct.inserted) {
            try {
              const result = await host.postMessage(anchor, fallbackText);
              if (result.messageId === "undelivered")
                deleteAct(host.d.db, wakeId, fallbackAct.actKey);
              else setActTs(host.d.db, wakeId, fallbackAct.actKey, result.messageId);
            } catch {
              deleteAct(host.d.db, wakeId, fallbackAct.actKey);
            }
          }
        }
      }
    } finally {
      for (const stream of streams.values()) {
        if (status === "succeeded") stream.settleCards();
        else if (stream.opened) stream.failCards();
        else stream.clearCards();
        await stream.close().catch(() => {});
      }
      // Commit consume+watermark after the wake; crash mid-wake re-delivers the batch.
      for (const convo of convos)
        consumeJudgment(host.d.db, host.d.clock, identityId, convo, convo.messages.at(-1)!.rowid);
      if (status === "succeeded" && heldDrafts.length > 0)
        markDraftsConsumed(
          host.d.db,
          host.d.clock,
          identityId,
          heldDrafts.map((draft) => draft.id),
        );
      for (const message of direct) {
        void host.d.adapter
          .setTypingStatus?.(message.venueId ?? "", message.threadRootId ?? message.ts ?? "", "")
          .catch(() => {});
      }
    }
    host.maybeTick(); // the wake may have created tasks — dispatch without waiting for the heartbeat
  })().finally(() => {
    host.residentRunning.delete(identityId);
    const again = host.residentRerun.delete(identityId);
    if (!host.stopping && (again || hasUndelivered(host.d.db, identityId)))
      runWake(host, identityId);
  });
  host.track(host.wakes, promise);
}
