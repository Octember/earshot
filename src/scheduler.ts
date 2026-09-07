import { inject, singleton } from "tsyringe";
import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import { Codex } from "./codex";
import { Debounced } from "./debounce";
import { Ear } from "./ear";
import { Execution } from "./execution";
import { DB, LedgerService, type Db } from "./ledger-service";
import { tasks, type Conversation, type Task } from "./ledger/schema";
import { POLICY, type Policy } from "./policy";
import { PromptRenderer } from "./prompt-renderer";
import { Voice } from "./voice";
import { Workspaces } from "./workspaces";

@singleton()
export class Scheduler {
  private readonly wakes = new Debounced(() => this.wake());
  private readonly ears = new Debounced(async () => {
    if (await this.ear.run()) this.wakeSoon();
  });

  constructor(
    @inject(DB) private readonly db: Db,
    private readonly ledger: LedgerService,
    @inject(POLICY) private readonly policy: Policy,
    private readonly codex: Codex,
    private readonly voice: Voice,
    private readonly workspaces: Workspaces,
    private readonly prompts: PromptRenderer,
    private readonly ear: Ear,
    private readonly execution: Execution,
  ) {
    this.tick();
    this.beat();
  }

  wakeSoon(): void {
    this.wakes.schedule(0);
  }

  listenSoon(delayMs: number): void {
    this.ears.schedule(delayMs);
  }

  private async wake(): Promise<void> {
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
    this.setup();
    await this.codex.resident().runOnce(this.workspaces.home, prompt, "resident");
    this.teardown(convos, settled);
  }

  private setup(): void {
    this.ledger.forgetAll();
    this.voice.begin();
  }

  private teardown(convos: Conversation[], settled: Task[]): void {
    this.ledger.markTasksSeen(settled);
    this.voice.close(convos.filter((convo) => convo.direct));
    this.tick();
  }

  private async execute(taskId: string): Promise<void> {
    if (await this.execution.launch(taskId)) this.wakeSoon();
    this.tick();
  }

  private beat(): void {
    setTimeout(() => {
      this.tick();
      this.beat();
    }, this.ledger.msUntilNextWake(60_000));
  }

  private tick(): void {
    if (this.ledger.wakeDueTasks()) this.wakeSoon();
    for (const taskId of this.ledger.dispatchRunnable(this.policy.executions.max_concurrent))
      void this.execute(taskId);
  }
}
