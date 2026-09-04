import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderBatch } from "./render";
import { runTurn, type TurnStatus } from "./turn-runner/turn";
import type { AgentEvent } from "@bevyl-ai/agent-tools";
import type { Service } from "./service";
import { admitted } from "./service-wake";
import { readMemory } from "./service-soul";
import { convoKey } from "./inbox";
import { z } from "zod";
import type { DynamicTool } from "@bevyl-ai/agent-tools";

const Verdict = z.object({
  decision: z.enum(["hold", "wake"]),
  why: z.string(),
  channel: z.string(),
  thread_ts: z.string(),
});

export async function runEarPass(host: Service, identityId: string): Promise<void> {
  const inbox = host.inboxOf(identityId);
  const { heard, dropped } = admitted(host, identityId, inbox.unjudged());
  inbox.take(dropped);
  if (heard.length === 0) return;
  const prompt = await renderBatch(host.render, heard, { selfLabel: "she", mark: " → her" });
  const verdict: DynamicTool = {
    spec: {
      name: "verdict",
      description:
        "Report one judgment about one conversation. decision: 'hold' (nothing needed from her) or 'wake' (this is HERS and needs her now — why becomes her own first read of it). channel and thread_ts are the conversation header's coordinates. Every why must read naturally if said aloud in the room.",
      inputSchema: z.toJSONSchema(Verdict),
    },
    run: async (raw) => {
      const { decision, why, channel, thread_ts } = Verdict.parse(raw);
      const convo = inbox.convos.get(convoKey(channel, thread_ts));
      if (!convo)
        return {
          success: false,
          output: `no conversation at ${channel} thread=${thread_ts} in this batch`,
        };
      if (decision === "wake") convo.wakeWhy = why;
      return { success: true, output: "noted" };
    },
  };
  let status: TurnStatus = "failed";
  try {
    status = await runEarSession(host, identityId, prompt, verdict);
  } catch (error) {
    host.log.error("ear pass threw", { identityId, error: String(error) });
  } finally {
    for (const { convo } of heard) for (const h of convo.heard) h.judged = true;
  }
  if (status !== "succeeded")
    host.log.warn("ear pass did not succeed — waking with the batch unjudged", {
      identityId,
      status,
    });
  if (status !== "succeeded" || heard.some(({ convo }) => convo.wakeWhy !== null))
    host.resident.schedule(identityId, 0);
}

async function runEarSession(
  host: Service,
  identityId: string,
  prompt: string,
  verdict: DynamicTool,
): Promise<TurnStatus> {
  const cwd = join(`${host.d.cwd}-ear`, identityId);
  mkdirSync(cwd, { recursive: true });
  const identity = host.identityById(identityId);
  writeFileSync(
    join(cwd, "AGENTS.md"),
    composeEarInstructions(host.d.botPrincipalId, {
      identity: identityId,
      persona: identity?.persona ?? null,
      memory: readMemory(host, identityId),
    }),
  );
  const session = host.d.sessionFactory(
    [verdict],
    (agentEvent: AgentEvent) => {
      if (agentEvent.log) host.log.info("ear", { line: agentEvent.log });
    },
    { ...host.policy.models.low, turnTimeoutMs: host.policy.turns.interactive_timeout_ms },
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
        stallTimeoutMs: host.policy.turns.stall_timeout_ms,
      })
    ).status;
  } finally {
    session.stop();
  }
}

const EAR_SOUL = `# You are the ear.

You listen to a Slack workspace on behalf of a teammate (the mind) who does the talking. You are
not in the conversation. You never speak to the room, you never will, and nothing you write is a
message. Your entire job is one judgment about what you hear, made from outside: is any of this
hers?

Most chatter is people talking to each other. Something is hers when it asks her something, hands her work, reports something she is plainly
the one to act on, moves a conversation she owes an answer in, or answers something she herself
just said. Someone merely mentioning her name in passing is not an ask. When a message asks for
a decision (permission, priority, what ships), note whose decision it actually is; that note
travels with the wake so she never has to guess from inside the conversation.

You report through the verdict tool, one verdict per conversation, and nothing else. Write every
line as if she may say it aloud in the room, because she may: plain words about who is talking to
whom and what is needed, never anything about tools, models, passes, or systems.

Needing someone is not needing her. When people are talking to each other, the conversation is
theirs: a question aimed at another teammate is that person's to answer even when she knows the
answer, and waking her into it costs the room more than it gives. An ask to the room or a team
belongs to whoever steps up or gets named, and open work is not hers to claim unless a name or a
standing rule makes it hers.

Bias to hold. Most of what you hear needs nothing from her, and waking her for it costs the room
more than it gives. But a real ask with no answer is the one failure you exist to prevent: when
in doubt about an explicit request aimed at her, wake her.`;

function composeEarInstructions(
  botPrincipalId: string,
  summary: { identity: string; persona: string | null; memory: string },
): string {
  const persona = summary.persona ? `\n\n${summary.persona.trim()}` : "";
  const memory = summary.memory.trim() ? `\n\nWhat she knows:\n${summary.memory.trim()}` : "";
  return `${EAR_SOUL}\n\n## Who you listen for (${summary.identity})\n\nIn the room she is <@${botPrincipalId}>. A message speaking to <@${botPrincipalId}> is speaking to her; a line from any other id is someone else's voice, never hers.${persona}${memory}`;
}
