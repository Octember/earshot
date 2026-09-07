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
import { Workspaces } from "./workspaces";

const Verdict = z.object({
  decision: z.enum(["hold", "wake"]),
  why: z.string(),
  channel: z.string(),
  thread_ts: z.string(),
});

const EAR_SOUL = `Decide whether each conversation needs her attention, given her role and context. Default to hold; wake when something needs her response or action. Do not overlook unanswered requests directed at her.

Submit one verdict per conversation with a brief reason. You do not speak to the room.`;

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
  ) {}

  /** True when something in the batch needs her. */
  async run(identityId: string): Promise<boolean> {
    const inbox = this.inboxes.of(identityId);
    const convos = this.inboxes.admitted(identityId, inbox.unjudged());
    if (convos.length === 0) return false;
    const prompt = await this.renderer.batch(identityId, convos, "she");
    const verdict: DynamicTool<z.infer<typeof Verdict>, string> = {
      name: "verdict",
      description:
        "One verdict for one conversation. decision: hold or wake. why: the brief reason; on wake it is her first read of the conversation. channel and thread_ts come from the conversation header.",
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
      `${EAR_SOUL}\n\n## Her (${identityId})\n\nShe is <@${this.botUserId}>.${persona?.trim() ? `\n\n${persona.trim()}` : ""}${memory.trim() ? `\n\nHer context:\n${memory.trim()}` : ""}`,
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
