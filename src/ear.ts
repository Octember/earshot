import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { inject, singleton } from "tsyringe";
import { z } from "zod";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import { Codex } from "./codex";
import { convoKey } from "./inbox";
import { Inboxes } from "./inboxes";
import { log } from "./log";
import { POLICY, type Policy } from "./policy";
import { Renderer } from "./render";
import { Soul } from "./soul";
import { BOT_USER_ID } from "./tokens";
import { Wake } from "./wake";
import { Workspaces } from "./workspaces";

const Verdict = z.object({
  decision: z.enum(["hold", "wake"]),
  why: z.string(),
  channel: z.string(),
  thread_ts: z.string(),
});

const EAR_SOUL = `You are the ear. You listen on behalf of a teammate who does the talking; you never speak to the room. Your one job: is any of this hers?

Hers: it asks her something, hands her work, reports something she is plainly the one to act on, moves a conversation she owes an answer in, or answers something she just said. Not hers: people talking to each other, a question aimed at another teammate even if she knows the answer, an ask to the room that someone else will take, open work no name or standing rule gives her. Mentioning her in passing is not an ask.

Report one verdict per conversation through the verdict tool. Write the why as if she may say it aloud: who is talking to whom and what is needed, never tools or systems. When a message asks for a decision, say whose decision it is.

Bias to hold. But an explicit request aimed at her with no answer is the one failure you exist to prevent: when in doubt, wake her.`;

@singleton()
export class Ear {
  constructor(
    @inject(POLICY) private readonly policy: Policy,
    @inject(BOT_USER_ID) private readonly botUserId: string,
    private readonly codex: Codex,
    private readonly inboxes: Inboxes,
    private readonly workspaces: Workspaces,
    private readonly renderer: Renderer,
    private readonly soul: Soul,
    private readonly wake: Wake,
  ) {}

  /** True when something in the batch is hers. */
  async run(identityId: string): Promise<boolean> {
    const inbox = this.inboxes.of(identityId);
    const convos = this.wake.admitted(identityId, inbox.unjudged());
    if (convos.length === 0) return false;
    const prompt = await this.renderer.batch(identityId, convos, "she");
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
    const cwd = this.workspaces.ear(identityId);
    const persona = this.policy.identities.find((i) => i.id === identityId)?.persona;
    const memory = this.soul.memory(identityId);
    writeFileSync(
      join(cwd, "AGENTS.md"),
      `${EAR_SOUL}\n\n## Who you listen for (${identityId})\n\nIn the room she is <@${this.botUserId}>. A message speaking to <@${this.botUserId}> is speaking to her; a line from any other id is someone else's voice, never hers.${persona?.trim() ? `\n\n${persona.trim()}` : ""}${memory.trim() ? `\n\nWhat she knows:\n${memory.trim()}` : ""}`,
    );
    const session = this.codex.ear([verdict]);
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
    return !ok || convos.some((convo) => convo.wakeWhy !== null);
  }
}
