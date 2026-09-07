import { inject, singleton } from "tsyringe";
import { z } from "zod";
import { tool } from "@bevyl-ai/agent-tools";
import { Codex } from "./codex";
import { eq, isNotNull } from "drizzle-orm";
import { conversations } from "./ledger/schema";
import { DB, LedgerService, type Db } from "./ledger-service";
import { log } from "./log";
import { PromptRenderer } from "./prompt-renderer";
import { Workspaces } from "./workspaces";

const verdictTool = (ledger: LedgerService) =>
  tool(
    "verdict",
    "One verdict per conversation, with a brief why.",
    z.object({
      decision: z.enum(["hold", "wake"]),
      why: z.string(),
      channel: z.string(),
      thread_ts: z.string(),
    }),
    async ({ decision, why, channel, thread_ts }) => {
      if (decision === "wake" && !ledger.wakeFor(channel, thread_ts, why))
        throw new Error(`no conversation at ${channel} thread=${thread_ts} in this batch`);
      return "noted";
    },
  );

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
    const prompt = await this.prompts.ear(convos);
    let ok = false;
    try {
      await this.codex.ear(verdictTool(this.ledger)).runOnce(this.workspaces.ear, prompt, "ear");
      ok = true;
    } catch (error) {
      log.warn("ear pass failed — waking with the batch unjudged", { error: String(error) });
    } finally {
      this.ledger.judged(convos);
    }
    return (
      !ok ||
      this.db.query.conversations.findFirst({ where: isNotNull(conversations.wakeWhy) }).sync() !==
        undefined
    );
  }
}
