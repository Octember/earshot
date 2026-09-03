import type { TurnEffect } from "./schemas/effects";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openItems } from "./ledger/attention";
import { wakeWhyOf } from "./ledger/conversations-judgment";
import { advanceJudged } from "./ledger/conversations-delivery";
import { renderConversation } from "./ledger/conversations-render";
import type { PendingConversation } from "./ledger/conversations-stance";
import type { RefTable } from "./ledger/conversations-refs";
import { composeEarInstructions } from "./turn-runner/ear-soul";
import { listedSection, venueCoords } from "./prompt/format";
import { queryMemory, coreWithinBudget } from "./ledger/memory";
import { runTurn } from "./turn-runner/turn";
import type { TurnStatus } from "./ledger/schema";
import type { AgentEvent } from "@bevyl-ai/agent-tools";
import { isDirectAddress } from "./ledger/inbox";
import type { Service } from "./service";
import { createVerdictTool } from "./service-ear-verdict";

export function earWorkspaceFor(host: Service, identityId: string): string {
  const dir = join(host.d.earCwd ?? `${host.d.cwd}-ear`, identityId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function refreshEarSoul(host: Service): void {
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
  if (isDirectAddress(message)) return "· wake ";
  if (message.payload.addressMode === "thread_follow") return "· thread ";
  return "";
}

function renderEarCards(
  host: Service,
  identityId: string,
  convos: PendingConversation[],
  refs: RefTable,
): string {
  return convos
    .map((convo) =>
      renderConversation(host.d.db, identityId, convo, {
        newMessages: convo.messages,
        mark: earMessageMark,
        wakeWhy: wakeWhyOf(host.d.db, identityId, convo),
        stance: convo.stance,
        selfLabel: "she",
        beforeRowid: convo.messages[0]!.rowid - 1,
        refs,
      }),
    )
    .join("\n\n");
}

export function buildEarPrompt(
  host: Service,
  identityId: string,
  convos: PendingConversation[],
  refs: RefTable,
): string {
  return `${renderEarCards(host, identityId, convos, refs)}${listedSection("Debts", openItems(host.d.db, identityId), (item) => `- (${item.id}) ${venueCoords(item)} · ${item.what}`)}`;
}

export async function runEarSession(
  host: Service,
  identityId: string,
  prompt: string,
  effects: TurnEffect[],
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
  host: Service,
  identityId: string,
  convos: PendingConversation[],
): void {
  for (const convo of convos) {
    advanceJudged(host.d.db, host.d.clock, identityId, convo, convo.messages.at(-1)!.rowid);
  }
}
