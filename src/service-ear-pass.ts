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
} from "./ledger/conversations";
import type { PendingConversation } from "./ledger/conversations-stance";
import type { RefTable } from "./ledger/conversations";
import { composeEarInstructions } from "./turn-runner/ear-soul";
import { asString, isRecord } from "./guard";
import { queryMemory, coreWithinBudget } from "./ledger/memory";
import { runTurn } from "./turn-runner/turn";
import type { TurnStatus } from "./ledger/turns";
import type { DynamicTool, AgentEvent } from "./turn-runner/types";
import { isDirectAddress, type ServiceHost } from "./service-util";

export function earWorkspace(host: ServiceHost): string {
  return host.d.earCwd ?? `${host.d.cwd}-ear`;
}

export function earWorkspaceFor(host: ServiceHost, identityId: string): string {
  const dir = join(earWorkspace(host), identityId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function refreshEarSoul(host: ServiceHost): void {
  try {
    for (const identity of host.policy().identities) {
      const { kept } = coreWithinBudget(
        queryMemory(host.d.db, identity.id, { tier: "core" }),
        host.policy().memory.coreCharBudget,
      );
      writeFileSync(
        join(earWorkspaceFor(host, identity.id), "AGENTS.md"),
        composeEarInstructions(host.d.botPrincipalId, [
          { identity: identity.id, persona: identity.persona, facts: kept.map((m) => m.content) },
        ]),
      );
    }
  } catch (error) {
    host.log.warn("could not write ear soul (AGENTS.md) — ear runs on codex default voice", {
      error: String(error),
    });
  }
}

function earMessageMark(message: Parameters<typeof isDirectAddress>[0]): string {
  if (isDirectAddress(message)) return "[she was woken for this] ";
  if (message.addressMode === "thread_follow") return "[a thread she is part of] ";
  return "";
}

function renderEarCards(
  host: ServiceHost,
  identityId: string,
  convos: PendingConversation[],
  refs: RefTable,
): string {
  return convos
    .map((convo) =>
      renderConversation(host.d.db, identityId, convo, {
        newMessages: convo.messages,
        mark: earMessageMark,
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
}

function formatEarDebts(open: ReturnType<typeof openItems>): string {
  if (open.length === 0) return "";
  return `\n\nrecorded debts (close or reopen by itemId as the thread warrants):\n${open.map((item) => `- (${item.id}) <#${item.venueId}>${item.threadRootId ? ` thread=${item.threadRootId}` : ""}: ${item.what}`).join("\n")}`;
}

export function buildEarPrompt(
  host: ServiceHost,
  identityId: string,
  convos: PendingConversation[],
  refs: RefTable,
): string {
  return `${renderEarCards(host, identityId, convos, refs)}${formatEarDebts(openItems(host.d.db, identityId))}`;
}

type VerdictCtx = {
  host: ServiceHost;
  identityId: string;
  refs: RefTable;
  effects: unknown[];
  setNeedWake: () => void;
};

function applyHoldVerdict(
  ctx: VerdictCtx,
  venueId: string | undefined,
  root: string | null,
  why: string,
): void {
  if (venueId) recordHold(ctx.host.d.db, ctx.host.d.clock, ctx.identityId, venueId, root, why);
}

function applyWakeVerdict(
  ctx: VerdictCtx,
  venueId: string | undefined,
  root: string | null,
  why: string,
): void {
  ctx.setNeedWake();
  if (venueId) recordWakeWhy(ctx.host.d.db, ctx.host.d.clock, ctx.identityId, venueId, root, why);
}

function applyOpenAskVerdict(
  ctx: VerdictCtx,
  target: NonNullable<ReturnType<RefTable["get"]>>,
  venueId: string,
  why: string,
): { ok: true } | { ok: false; output: string } {
  openAttentionItem(ctx.host.d.db, ctx.host.d.clock, {
    id: ctx.host.d.newId(),
    identityId: ctx.identityId,
    venueId,
    threadRootId: target.threadRootId ?? target.ts ?? null,
    askTs: target.ts ?? null,
    what: why,
  });
  return { ok: true };
}

function applyCloseAskVerdict(
  ctx: VerdictCtx,
  itemId: string | undefined,
  why: string,
): { ok: true } | { ok: false; output: string } {
  if (
    !itemId ||
    !closeAttentionItem(ctx.host.d.db, ctx.host.d.clock, ctx.identityId, itemId, why)
  ) {
    return { ok: false, output: "no open item with that id" };
  }
  return { ok: true };
}

function applyReopenAskVerdict(
  ctx: VerdictCtx,
  itemId: string | undefined,
): { ok: true } | { ok: false; output: string } {
  if (!itemId || !reopenAttentionItem(ctx.host.d.db, ctx.identityId, itemId)) {
    return {
      ok: false,
      output:
        "nothing to reopen with that id: either it does not exist, or the operator settled it and that stays settled",
    };
  }
  return { ok: true };
}

function runVerdictDecision(
  ctx: VerdictCtx,
  decision: string,
  why: string,
  target: ReturnType<RefTable["get"]>,
  itemId: string | undefined,
): { ok: true } | { ok: false; output: string } {
  const venueId = target?.venueId;
  const residenceRoot = target ? target.threadRootId : null;
  ctx.effects.push({
    kind: "ear_verdict",
    decision,
    why,
    venueId,
    threadRootId: residenceRoot,
  });
  switch (decision) {
    case "hold":
      applyHoldVerdict(ctx, venueId, residenceRoot, why);
      return { ok: true };
    case "wake":
      applyWakeVerdict(ctx, venueId, residenceRoot, why);
      return { ok: true };
    case "open_ask":
      if (!target || !venueId) {
        return {
          ok: false,
          output:
            "open_ask needs ref — the [rN] tag of the ask itself (the message line), so the debt roots where its answer will land",
        };
      }
      return applyOpenAskVerdict(ctx, target, venueId, why);
    case "close_ask":
      return applyCloseAskVerdict(ctx, itemId, why);
    case "reopen_ask":
      return applyReopenAskVerdict(ctx, itemId);
    default:
      return { ok: false, output: `unknown decision: ${decision}` };
  }
}

export function createVerdictTool(ctx: VerdictCtx): DynamicTool {
  return {
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
      const target = ref ? ctx.refs.get(ref) : undefined;
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
      const outcome = runVerdictDecision(ctx, decision, why, target, itemId);
      return outcome.ok
        ? { success: true, output: "noted" }
        : { success: false, output: outcome.output };
    },
  };
}

export async function runEarSession(
  host: ServiceHost,
  identityId: string,
  prompt: string,
  effects: unknown[],
  refs: RefTable,
  setNeedWake: () => void,
): Promise<TurnStatus> {
  refreshEarSoul(host);
  const verdictTool = createVerdictTool({ host, identityId, refs, effects, setNeedWake });
  const session = host.d.sessionFactory(
    [verdictTool],
    (agentEvent: AgentEvent) => {
      if (agentEvent.log) host.log.info("ear", { line: agentEvent.log });
    },
    host.policy().models.low,
  );
  try {
    await session.start(earWorkspaceFor(host, identityId));
    const threadId = await session.startThread(earWorkspaceFor(host, identityId));
    return (
      await runTurn({
        session,
        threadId,
        cwd: earWorkspaceFor(host, identityId),
        prompt,
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
}

export function commitEarJudgments(
  host: ServiceHost,
  identityId: string,
  convos: PendingConversation[],
): void {
  for (const convo of convos) {
    advanceJudged(host.d.db, host.d.clock, identityId, convo, convo.messages.at(-1)!.rowid);
  }
}

export function loadEarBatch(host: ServiceHost, identityId: string): PendingConversation[] {
  return unjudgedConversations(host.d.db, identityId);
}
