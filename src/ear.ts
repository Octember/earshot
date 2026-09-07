import { singleton } from "tsyringe";
import { z } from "zod";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import { Codex } from "./codex";
import { Inbox, type Conversation } from "./inbox";
import { log } from "./log";
import { PromptRenderer } from "./prompt-renderer";
import { Soul } from "./soul";
import { Workspaces } from "./workspaces";

const Verdict = z.object({
  decision: z.enum(["hold", "wake"]),
  why: z.string(),
  channel: z.string(),
  thread_ts: z.string(),
});

function verdictTool(convos: Conversation[]): DynamicTool<z.infer<typeof Verdict>, string> {
  return {
    name: "verdict",
    description:
      "One verdict for one conversation. decision: hold or wake. why: the brief reason; on wake it is her first read of the conversation. channel and thread_ts come from the conversation header.",
    input: Verdict,
    async run({ decision, why, channel, thread_ts }) {
      const convo = convos.find((c) => c.channel === channel && c.threadTs === thread_ts);
      if (!convo)
        throw new Error(`no conversation at ${channel} thread=${thread_ts} in this batch`);
      if (decision === "wake") convo.wakeWhy = why;
      return "noted";
    },
  };
}

@singleton()
export class Ear {
  constructor(
    private readonly codex: Codex,
    private readonly inbox: Inbox,
    private readonly workspaces: Workspaces,
    private readonly prompts: PromptRenderer,
    private readonly soul: Soul,
  ) {}

  /** True when something in the batch needs her. */
  async run(identityId: string): Promise<boolean> {
    const convos = this.inbox.unjudged(identityId);
    if (convos.length === 0) return false;
    this.soul.refresh();
    const prompt = await this.prompts.ear(identityId, convos);
    const cwd = this.workspaces.ear(identityId);
    const session = this.codex.ear([verdictTool(convos)]);
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
