import { inject, singleton } from "tsyringe";
import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import { tasks } from "./ledger/schema";
import { Codex } from "./codex";
import { Voice } from "./voice";
import { DB, LedgerService, type Db } from "./ledger-service";
import { now } from "./clock";
import { log } from "./log";
import { POLICY, type Policy } from "./policy";
import { PromptRenderer } from "./prompt-renderer";
import { Workspaces } from "./workspaces";

@singleton()
export class Wake {
  constructor(
    @inject(DB) private readonly db: Db,
    private readonly ledger: LedgerService,
    @inject(POLICY) private readonly policy: Policy,
    private readonly codex: Codex,
    private readonly voice: Voice,
    private readonly workspaces: Workspaces,
    private readonly prompts: PromptRenderer,
  ) {}

  async run(): Promise<void> {
    const started = now();
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

    const direct = convos.filter((convo) => convo.direct);
    const failure = await this.attempt(prompt, started);
    try {
      if (failure === null) this.ledger.markTasksSeen(settled);
      else await this.apologize(direct, failure);
    } finally {
      this.voice.close(direct);
    }
  }

  private async attempt(prompt: string, started: string): Promise<string | null> {
    const { turns } = this.policy;
    for (let attempt = 0; ; attempt++) {
      const failure = await this.turn(prompt);
      const acted = this.voice.acted || this.ledger.changedSince(started);
      if (failure === null || acted || attempt >= turns.max_retries) return failure;
      log.warn("resident wake died before acting — retrying", { attempt, failure });
      await Bun.sleep(turns.backoff_ms * 2 ** attempt);
    }
  }

  private async turn(prompt: string): Promise<string | null> {
    try {
      await this.codex.resident().runOnce(this.workspaces.home, prompt, "resident");
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private apologize(direct: { channel: string; threadTs: string }[], failure: string) {
    const text = `can't run right now — ${failure}. try me again, or flag the operator if it keeps up.`;
    const unanswered = direct.filter((convo) => !this.voice.answered(convo));
    const posts = unanswered.map((convo) => this.voice.post(convo.channel, convo.threadTs, text));
    return Promise.all(posts);
  }
}
