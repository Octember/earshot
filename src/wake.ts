import { inject, singleton } from "tsyringe";
import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import { tasks } from "./ledger/schema";
import { WebClient } from "@slack/web-api";
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
    private readonly web: WebClient,
    private readonly voice: Voice,
    private readonly workspaces: Workspaces,
    private readonly prompts: PromptRenderer,
  ) {}

  async run(): Promise<void> {
    const started = now();
    const convos = this.db.query.conversations.findMany().sync();
    const taskUpdates = this.db.query.tasks
      .findMany({
        where: and(
          or(eq(tasks.status, "done"), eq(tasks.waitingOn, "human")),
          or(isNull(tasks.seenAt), gt(tasks.updatedAt, tasks.seenAt)),
        ),
        orderBy: asc(tasks.updatedAt),
      })
      .sync();
    if (convos.length === 0 && taskUpdates.length === 0) return;
    this.ledger.forgetAll();

    const direct = convos.filter((convo) => convo.direct);
    this.voice.begin();
    const prompt = await this.prompts.wake(convos, taskUpdates);
    const { turns } = this.policy;
    const cwd = this.workspaces.home;

    let failure: string | null = null;
    try {
      for (let attempt = 0; ; attempt++) {
        const session = this.codex.resident();
        try {
          await session.start(cwd);
          await session.runTurn(await session.startThread(cwd), cwd, prompt, "resident");
          failure = null;
          break;
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        } finally {
          session.stop();
        }
        if (this.voice.acted || this.ledger.changedSince(started) || attempt >= turns.max_retries)
          break;
        log.warn("resident wake died before acting — retrying", { attempt, failure });
        await new Promise<void>((resolve) => {
          setTimeout(resolve, turns.backoff_ms * 2 ** attempt);
        });
      }
      if (failure !== null)
        for (const convo of direct) {
          if (this.voice.status(convo) === "active") continue;
          await this.voice.post(
            convo.channel,
            convo.threadTs,
            `can't run right now — ${failure}. try me again, or flag the operator if it keeps up.`,
          );
        }
    } finally {
      for (const convo of direct) {
        void this.web.agents.sessions.setStatus({
          channel_id: convo.channel,
          thread_ts: convo.threadTs,
          status: this.voice.status(convo),
        });
      }
      if (failure === null) this.ledger.markTasksSeen(taskUpdates);
    }
  }
}
