import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderBatch } from "./render";
import { log } from "./log";
import type { Service } from "./service";
import { admitted } from "./service-wake";
import { readMemory } from "./soul";
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
  const verdict: DynamicTool<z.infer<typeof Verdict>, string> = {
    name: "verdict",
    description:
      "Report one judgment about one conversation. decision: 'hold' (nothing needed from her) or 'wake' (this is HERS and needs her now — why becomes her own first read of it). channel and thread_ts are the conversation header's coordinates. Every why must read naturally if said aloud in the room.",
    input: Verdict,
    async run({ decision, why, channel, thread_ts }) {
      const convo = inbox.convos.get(convoKey(channel, thread_ts));
      if (!convo)
        throw new Error(`no conversation at ${channel} thread=${thread_ts} in this batch`);
      if (decision === "wake") convo.wakeWhy = why;
      return "noted";
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
  const session = host.codex.ear([verdict]);
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

const EAR_SOUL = `You are the ear. You listen on behalf of a teammate who does the talking; you never speak to the room. Your one job: is any of this hers?

Hers: it asks her something, hands her work, reports something she is plainly the one to act on, moves a conversation she owes an answer in, or answers something she just said. Not hers: people talking to each other, a question aimed at another teammate even if she knows the answer, an ask to the room that someone else will take, open work no name or standing rule gives her. Mentioning her in passing is not an ask.

Report one verdict per conversation through the verdict tool. Write the why as if she may say it aloud: who is talking to whom and what is needed, never tools or systems. When a message asks for a decision, say whose decision it is.

Bias to hold. But an explicit request aimed at her with no answer is the one failure you exist to prevent: when in doubt, wake her.`;

function composeEarInstructions(
  botPrincipalId: string,
  identityId: string,
  persona: string | undefined,
  memory: string,
): string {
  return `${EAR_SOUL}\n\n## Who you listen for (${identityId})\n\nIn the room she is <@${botPrincipalId}>. A message speaking to <@${botPrincipalId}> is speaking to her; a line from any other id is someone else's voice, never hers.${persona?.trim() ? `\n\n${persona.trim()}` : ""}${memory.trim() ? `\n\nWhat she knows:\n${memory.trim()}` : ""}`;
}
