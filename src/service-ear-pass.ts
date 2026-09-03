import type { TurnEffect } from "./schemas/effects";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openItems } from "./ledger/attention";
import { wakeWhyOf } from "./ledger/conversations-judgment";
import { renderConversation } from "./ledger/conversations-render";
import type { PendingConversation } from "./ledger/conversations-stance";
import type { RefTable } from "./ledger/conversations-refs";
import { listedSection, venueCoords } from "./prompt/format";
import { coreWithinBudget, queryMemory } from "./ledger/memory";
import { runTurn } from "./turn-runner/turn";
import type { TurnStatus } from "./ledger/schema";
import type { AgentEvent } from "@bevyl-ai/agent-tools";
import { isDirectAddress } from "./ledger/inbox";
import type { Service } from "./service";
import { createVerdictTool } from "./service-ear-verdict";

function earWorkspaceFor(host: Service, identityId: string): string {
  const dir = join(host.d.earCwd ?? `${host.d.cwd}-ear`, identityId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function earMessageMark(message: Parameters<typeof isDirectAddress>[0]): string {
  if (isDirectAddress(message)) return "· wake ";
  if (message.payload.addressMode === "thread_follow") return "· thread ";
  return "";
}

export function buildEarPrompt(
  host: Service,
  identityId: string,
  convos: PendingConversation[],
  refs: RefTable,
): string {
  const cards = convos
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
  return `${cards}${listedSection("Debts", openItems(host.d.db, identityId), (item) => `- (${item.id}) ${venueCoords(item)} · ${item.what}`)}`;
}

export async function runEarSession(
  host: Service,
  identityId: string,
  prompt: string,
  effects: TurnEffect[],
  refs: RefTable,
  setNeedWake: () => void,
): Promise<TurnStatus> {
  const cwd = earWorkspaceFor(host, identityId);
  try {
    const identity = host.identityById(identityId);
    const { kept } = coreWithinBudget(
      queryMemory(host.d.db, identityId, { tier: "core" }),
      host.policy().memory.coreCharBudget,
    );
    writeFileSync(
      join(cwd, "AGENTS.md"),
      composeEarInstructions(host.d.botPrincipalId, {
        identity: identityId,
        persona: identity?.persona ?? null,
        facts: kept.map((m) => m.content),
      }),
    );
  } catch (error) {
    host.log.warn("could not write ear soul (AGENTS.md) — ear runs on codex default voice", {
      error: String(error),
    });
  }
  const verdictTool = createVerdictTool({ host, identityId, refs, effects, setNeedWake });
  const session = host.d.sessionFactory(
    [verdictTool],
    (agentEvent: AgentEvent) => {
      if (agentEvent.log) host.log.info("ear", { line: agentEvent.log });
    },
    host.policy().models.low,
  );
  try {
    await session.start(cwd);
    const threadId = await session.startThread(cwd);
    return (
      await runTurn({
        session,
        threadId,
        cwd,
        prompt,
        title: `ear:${identityId}`,
        db: host.d.db,
        clock: host.d.clock,
        turnId: host.d.newId(),
        identityId,
        kind: "attention",
        effects,
        timeoutMs: host.policy().turns.interactiveTimeoutMs,
      })
    ).status;
  } finally {
    session.stop();
  }
}

const EAR_SOUL = `# You are the ear.

You listen to a Slack workspace on behalf of a teammate (the mind) who does the talking. You are
not in the conversation. You never speak to the room, you never will, and nothing you write is a
message. Your entire job is three judgments about what you hear, made from outside:

1. **Is any of this hers?** Most chatter is people talking to each other, including most replies
   in threads she is part of. Something is hers when it asks her something, hands her work,
   reports something she is plainly the one to act on, moves a conversation she owes an answer
   in, or answers something she herself just said. Someone merely mentioning her name in
   passing is not an ask.
2. **Who owns the open calls?** When a message asks for a decision (permission, priority, what
   ships), note whose decision it actually is. That note travels with the wake so she never has
   to guess from inside the conversation.
3. **What does she still owe?** A direct ask of her that has no answer yet is a debt. Record it.
   On later listens, if you can see the debt was settled (she answered, she reacted, the asker
   withdrew, the moment passed), close it. If an earlier "answer" plainly did not address the
   ask, reopen it.

You report through the verdict tool, one verdict per conversation, and nothing else. Write every
line as if she may say it aloud in the room, because she may: plain words about who is talking to
whom and what is needed, never anything about tools, models, passes, or systems.

Needing someone is not needing her. When people are talking to each other, the conversation is
theirs: a question aimed at another teammate is that person's to answer even when she knows the
answer, and waking her into it costs the room more than it gives. The same boundary holds for
debts: record only asks aimed at her. What one teammate owes another is theirs, not hers to
carry or to chase. An ask to the room or a team belongs to whoever steps up or gets named, and
open work is not hers to claim unless a name or a standing rule makes it hers. Unfinished work
is not an unanswered ask: once she answered, was told it is not hers, or stepped away, that
debt is settled, and only a fresh ask aimed at her opens a new one.

Bias to hold. Most of what you hear needs nothing from her, and waking her for it costs the room
more than it gives. But a real ask with no answer is the one failure you exist to prevent: when
in doubt about an explicit request aimed at her, record the debt.

Words spoken to her are never yours to hold: when a message addresses her directly, wake her even
if it needs nothing, say so plainly, and let her choose how to receive it.`;

function composeEarInstructions(
  botPrincipalId: string,
  summary: { identity: string; persona: string | null; facts: string[] },
): string {
  const persona = summary.persona ? `\n\n${summary.persona.trim()}` : "";
  const facts =
    summary.facts.length > 0
      ? `\n\nWhat she knows:\n${summary.facts.map((fact) => `- ${fact}`).join("\n")}`
      : "";
  return `${EAR_SOUL}\n\n## Who you listen for (${summary.identity})\n\nIn the room she is <@${botPrincipalId}>. A message speaking to <@${botPrincipalId}> is speaking to her; a line from any other id is someone else's voice, never hers.${persona}${facts}`;
}
