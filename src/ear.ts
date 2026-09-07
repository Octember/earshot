import { inject, singleton } from "tsyringe";
import { z } from "zod";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import { Codex } from "./codex";
import { eq } from "drizzle-orm";
import { conversations, type Conversation } from "./ledger/schema";
import { DB, LedgerService, type Db } from "./ledger-service";
import { log } from "./log";
import { PromptRenderer } from "./prompt-renderer";
import { Workspaces } from "./workspaces";

const Verdict = z.object({
  decision: z.enum(["hold", "wake"]),
  why: z.string(),
  channel: z.string(),
  thread_ts: z.string(),
});

function verdictTool(
  convos: Conversation[],
  wakeWhy: Map<string, string>,
): DynamicTool<z.infer<typeof Verdict>, string> {
  return {
    name: "verdict",
    description: "One verdict per conversation, with a brief why.",
    input: Verdict,
    async run({ decision, why, channel, thread_ts }) {
      const convo = convos.find((c) => c.channel === channel && c.threadTs === thread_ts);
      if (!convo)
        throw new Error(`no conversation at ${channel} thread=${thread_ts} in this batch`);
      if (decision === "wake") wakeWhy.set(convo.threadTs, why);
      return "noted";
    },
  };
}

@singleton()
export class Ear {
  constructor(
    private readonly codex: Codex,
    @inject(DB) private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly workspaces: Workspaces,
    private readonly prompts: PromptRenderer,
  ) {}

  async run(): Promise<boolean> {
    const convos = this.db.query.conversations
      .findMany({ where: eq(conversations.judged, false) })
      .sync();
    if (convos.length === 0) return false;
    const wakeWhy = new Map<string, string>();
    const prompt = await this.prompts.ear(convos);
    const cwd = this.workspaces.ear;
    const session = this.codex.ear([verdictTool(convos, wakeWhy)]);
    let ok = false;
    try {
      await session.start(cwd);
      await session.runTurn(await session.startThread(cwd), cwd, prompt, "ear");
      ok = true;
    } catch (error) {
      log.warn("ear pass failed — waking with the batch unjudged", { error: String(error) });
    } finally {
      session.stop();
      this.ledger.judged(convos, wakeWhy);
    }
    return !ok || wakeWhy.size > 0;
  }
}
