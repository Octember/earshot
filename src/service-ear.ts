import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  openAttentionItem,
  closeAttentionItem,
  reopenAttentionItem,
  openItems,
} from "./ledger/attention";
import {
  recordHold,
  recordWakeWhy,
  getConversationJudgment,
  unjudgedConversations,
  advanceJudged,
  renderConversation,
  makeRefTable,
} from "./ledger/conversations";
import { composeEarInstructions } from "./turn-runner/ear-soul";
import { asString, isRecord } from "./guard";
import { queryMemory, coreWithinBudget } from "./ledger/memory";
import { runTurn } from "./turn-runner/turn";
import type { TurnStatus } from "./ledger/turns";
import type { DynamicTool } from "./turn-runner/types";
import { isDirectAddress, type ServiceHost } from "./service-util";
import { runWake } from "./service-wake";

function earWorkspace(host: ServiceHost): string {
  return host.d.earCwd ?? `${host.d.cwd}-ear`;
}

function earWorkspaceFor(host: ServiceHost, identityId: string): string {
  const dir = join(earWorkspace(host), identityId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function scheduleEar(host: ServiceHost, identityId: string): void {
  if (host.stopping) return;
  if (host.earDebounce.has(identityId)) return; // first arm wins — the burst rides one pass
  const identity = host.identityById(identityId);
  host.earDebounce.set(
    identityId,
    setTimeout(() => {
      host.earDebounce.delete(identityId);
      if (!host.stopping) runEarPass(host, identityId);
    }, identity?.ambient.eventDebounceMs ?? 20_000),
  );
}

function refreshEarSoul(host: ServiceHost): void {
  try {
    for (const identity of host.policy().identities) {
      const { kept } = coreWithinBudget(
        queryMemory(host.d.db, identity.id, { tier: "core" }),
        host.policy().memory.coreCharBudget,
      );
      const summary = {
        identity: identity.id,
        persona: identity.persona,
        facts: kept.map((memory) => memory.content),
      };
      writeFileSync(
        join(earWorkspaceFor(host, identity.id), "AGENTS.md"),
        composeEarInstructions(host.d.botPrincipalId, [summary]),
      );
    }
  } catch (error) {
    host.log.warn("could not write ear soul (AGENTS.md) — ear runs on codex default voice", {
      error: String(error),
    });
  }
}

export function runEarPass(host: ServiceHost, identityId: string): void {
  if (host.earRunning.has(identityId)) {
    host.earRerun.add(identityId);
    return;
  }
  host.earRunning.add(identityId);
  const promise = (async () => {
    const convos = unjudgedConversations(host.d.db, identityId);
    if (convos.length === 0) return;
    const open = openItems(host.d.db, identityId);
    const effects: unknown[] = [];
    let needWake = false;
    const refs = makeRefTable();
    const verdictTool: DynamicTool = {
      spec: {
        name: "verdict",
        description:
          "Report one judgment about one conversation. decision: 'hold' (nothing needed from her), 'wake' (this is HERS and needs her now — why becomes her own first read of it), 'open_ask' (a direct ask of her, never what one teammate owes another — record the debt; does not wake by itself), 'close_ask' / 'reopen_ask' (a recorded debt was settled / was not actually settled; pass itemId). Every why must read naturally if said aloud in the room.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["decision", "why"],
          properties: {
            decision: {
              type: "string",
              enum: ["hold", "wake", "open_ask", "close_ask", "reopen_ask"],
            },
            why: { type: "string" },
            ref: { type: "string", pattern: "^r\\d+$" },
            itemId: { type: "string" },
          },
        },
      },
      run: async (args: unknown) => {
        const rawArgs = isRecord(args) ? args : {};
        const decision = asString(rawArgs.decision);
        const why = asString(rawArgs.why);
        const ref = typeof rawArgs.ref === "string" ? rawArgs.ref : undefined;
        const itemId = typeof rawArgs.itemId === "string" ? rawArgs.itemId : undefined;
        const target = ref ? refs.get(ref) : undefined;
        if (ref && !target) {
          return {
            success: false,
            output: `"${ref}" is not a ref — copy the [rN] tag (like r3) from the start of the line you are judging; timestamps and channel ids are labels, not addresses`,
          };
        }
        if ((decision === "hold" || decision === "wake") && !target) {
          return {
            success: false,
            output: `${decision} needs ref — the [rN] tag of a line in the conversation being judged, so the judgment lands on its row`,
          };
        }
        const venueId = target?.venueId;
        const residenceRoot = target ? target.threadRootId : null;
        const askRoot = target ? (target.threadRootId ?? target.ts ?? null) : null;
        effects.push({
          kind: "ear_verdict",
          decision,
          why,
          venueId,
          threadRootId: residenceRoot,
        });
        if (decision === "hold") {
          if (venueId) recordHold(host.d.db, host.d.clock, identityId, venueId, residenceRoot, why);
        } else if (decision === "wake") {
          needWake = true;
          if (venueId)
            recordWakeWhy(host.d.db, host.d.clock, identityId, venueId, residenceRoot, why);
        } else if (decision === "open_ask") {
          if (!target || !venueId) {
            return {
              success: false,
              output:
                "open_ask needs ref — the [rN] tag of the ask itself (the message line), so the debt roots where its answer will land",
            };
          }
          openAttentionItem(host.d.db, host.d.clock, {
            id: host.d.newId(),
            identityId,
            venueId,
            threadRootId: askRoot,
            askTs: target.ts ?? null,
            what: why,
          });
        } else if (decision === "close_ask") {
          if (!itemId || !closeAttentionItem(host.d.db, host.d.clock, identityId, itemId, why))
            return { success: false, output: "no open item with that id" };
        } else if (
          decision === "reopen_ask" &&
          (!itemId || !reopenAttentionItem(host.d.db, identityId, itemId))
        ) {
          return {
            success: false,
            output:
              "nothing to reopen with that id: either it does not exist, or the operator settled it and that stays settled",
          };
        }
        return { success: true, output: "noted" };
      },
    };
    let status: TurnStatus = "failed";
    try {
      refreshEarSoul(host);
      const session = host.d.sessionFactory(
        [verdictTool],
        (agentEvent) => {
          if (agentEvent.log) host.log.info("ear", { line: agentEvent.log });
        },
        host.policy().models.low,
      );
      try {
        await session.start(earWorkspaceFor(host, identityId));
        const threadId = await session.startThread(earWorkspaceFor(host, identityId)); // fresh every pass — an observer never accumulates
        const cards = convos
          .map((convo) =>
            renderConversation(host.d.db, identityId, convo, {
              newMessages: convo.messages,
              mark: (message) =>
                isDirectAddress(message)
                  ? "[she was woken for this] "
                  : message.addressMode === "thread_follow"
                    ? "[a thread she is part of] "
                    : "",
              judgment:
                getConversationJudgment(host.d.db, identityId, convo.venueId, convo.threadRootId) ??
                undefined,
              stance: convo.stance,
              selfLabel: "she",
              beforeRowid: convo.messages[0]!.rowid - 1,
              refs,
            }),
          )
          .join("\n\n");
        const debts =
          open.length > 0
            ? `\n\nrecorded debts (close or reopen by itemId as the thread warrants):\n${open.map((item) => `- (${item.id}) <#${item.venueId}>${item.threadRootId ? ` thread=${item.threadRootId}` : ""}: ${item.what}`).join("\n")}`
            : "";
        status = (
          await runTurn({
            session,
            threadId,
            cwd: earWorkspaceFor(host, identityId),
            prompt: `${cards}${debts}`,
            title: `ear:${identityId}`,
            db: host.d.db,
            clock: host.d.clock,
            turnId: host.d.newId(),
            identityId,
            kind: "attention",
            effects,
            tokensUsed: () => 0,
            spendAmount: () => 0,
            envelope: {
              timeoutMs: host.policy().turns.interactiveTimeoutMs,
              tokenCeiling: host.policy().turns.interactiveTokenCeiling,
            },
          })
        ).status;
      } finally {
        session.stop();
      }
    } catch (error) {
      host.log.error("ear pass threw", { identityId, error: String(error) });
    } finally {
      // Per-conversation judged watermark — unrelated batches must not advance it.
      for (const convo of convos)
        advanceJudged(host.d.db, host.d.clock, identityId, convo, convo.messages.at(-1)!.rowid);
    }
    if (status !== "succeeded") {
      host.log.warn("ear pass did not succeed — failing open to a wake", { identityId, status });
      needWake = true;
    }
    if (needWake) runWake(host, identityId);
  })().finally(() => {
    host.earRunning.delete(identityId);
    const again = host.earRerun.delete(identityId);
    if (!host.stopping && again) runEarPass(host, identityId);
  });
  host.track(host.wakes, promise);
}
