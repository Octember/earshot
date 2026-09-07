import { inject, singleton } from "tsyringe";
import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import { tasks } from "./ledger/schema";
import { Codex } from "./codex";
import { Voice } from "./voice";
import { DB, LedgerService, type Db } from "./ledger-service";
import { PromptRenderer } from "./prompt-renderer";
import { Workspaces } from "./workspaces";

@singleton()
export class Wake {
  constructor(
    @inject(DB) private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly codex: Codex,
    private readonly voice: Voice,
    private readonly workspaces: Workspaces,
    private readonly prompts: PromptRenderer,
  ) {}

  async run(): Promise<void> {
    const convos = this.db.query.conversations.findMany().sync();
    const settled = this.db.query.tasks
      .findMany({
        where: and(
          or(eq(tasks.status, "done"), eq(tasks.waitingOn, "human")),
          or(isNull(tasks.seenAt), gt(tasks.updatedAt, tasks.seenAt)),
        ),
        orderBy: asc(tasks.updatedAt),
      })
      .sync();
    if (convos.length === 0 && settled.length === 0) return;
    const prompt = await this.prompts.wake(convos, settled);
    this.ledger.forgetAll();
    this.voice.begin();
    try {
      await this.codex.resident().runOnce(this.workspaces.home, prompt, "resident");
      this.ledger.markTasksSeen(settled);
    } finally {
      this.voice.close(convos.filter((convo) => convo.direct));
    }
  }
}
