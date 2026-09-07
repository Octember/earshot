import { inject, singleton, type Disposable } from "tsyringe";
import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import { Codex } from "./codex";
import { Debounced } from "./debounce";
import { Ear } from "./ear";
import { Execution } from "./execution";
import { DB, LedgerService, type Db } from "./ledger-service";
import { tasks, type Conversation, type Task } from "./ledger/schema";
import { log } from "./log";
import { POLICY, type Policy } from "./policy";
import { PromptRenderer } from "./prompt-renderer";
import { Voice } from "./voice";
import { Workspaces } from "./workspaces";

@singleton()
export class Scheduler implements Disposable {
  private readonly inflight = new Set<Promise<unknown>>();
  private stopping = false;
  private heartbeat: ReturnType<typeof setTimeout> | null = null;
  private readonly wakes = new Debounced(() => this.guard(this.wake()));
  private readonly ears = new Debounced(() => this.guard(this.listen()));

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
  ) {}

  start(): void {
    this.tick();
    this.beat();
  }

  wakeSoon(): void {
    if (this.stopping) return;
    this.wakes.schedule(0);
  }

  listenSoon(delayMs: number): void {
    if (this.stopping) return;
    this.ears.schedule(delayMs);
  }

  async dispose(): Promise<void> {
    this.ears.flush();
    this.wakes.flush();
    this.stopping = true;
    if (this.heartbeat) clearTimeout(this.heartbeat);
    while (this.inflight.size > 0) await Promise.allSettled(this.inflight);
    log.info("service stopped");
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

  private async listen(): Promise<void> {
    if (await this.ear.run()) this.wakeSoon();
  }

  private async execute(taskId: string): Promise<void> {
    if (await this.execution.launch(taskId)) this.wakeSoon();
    this.tick();
  }

  private beat(): void {
    if (this.stopping) return;
    this.heartbeat = setTimeout(() => {
      this.tick();
      this.beat();
    }, this.ledger.msUntilNextWake(60_000));
  }

  private tick(): void {
    if (this.stopping) return;
    if (this.ledger.wakeDueTasks()) this.wakeSoon();
    for (const taskId of this.ledger.dispatchRunnable(this.policy.executions.max_concurrent))
      void this.guard(this.execute(taskId));
  }

  private guard(work: Promise<void>): Promise<void> {
    this.inflight.add(work);
    return work.finally(() => {
      this.inflight.delete(work);
    });
  }
}
