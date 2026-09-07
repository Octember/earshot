import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderBatch } from "./render";
import { log } from "./log";
import { codexSession } from "./main-codex";
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
  const convos = admitted(host, identityId, inbox.unjudged());
  if (convos.length === 0) return;
  const prompt = await renderBatch(host, identityId, convos, "she");
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
  const cwd = join(`${host.cwd}-ear`, identityId);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(cwd, "AGENTS.md"),
    composeEarInstructions(
      host.botPrincipalId,
      identityId,
      host.identityById(identityId)?.persona,
      readMemory(host, identityId),
    ),
  );
  const session = codexSession(
    [verdict],
    (agentEvent) => {
      if (agentEvent.log) log.info("ear", { line: agentEvent.log });
    },
    {
      ...host.policy.models.low,
      turnTimeoutMs: host.policy.turns.interactive_timeout_ms,
      stallTimeoutMs: host.policy.turns.stall_timeout_ms,
    },
  );
  let ok = false;
  try {
    await session.start(cwd);
    await session.runTurn(await session.startThread(cwd), cwd, prompt, `ear:${identityId}`);
    ok = true;
  } catch (error) {
    log.warn("ear pass failed — waking with the batch unjudged", {
      identityId,
      error: String(error),
    });
  } finally {
    session.stop();
    for (const convo of convos) for (const h of convo.heard) h.judged = true;
  }
  if (!ok || convos.some((convo) => convo.wakeWhy !== null)) host.resident.schedule(identityId, 0);
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
  identityId: string,
  persona: string | undefined,
  memory: string,
): string {
  return `${EAR_SOUL}\n\n## Who you listen for (${identityId})\n\nIn the room she is <@${botPrincipalId}>. A message speaking to <@${botPrincipalId}> is speaking to her; a line from any other id is someone else's voice, never hers.${persona?.trim() ? `\n\n${persona.trim()}` : ""}${memory.trim() ? `\n\nWhat she knows:\n${memory.trim()}` : ""}`;
}
