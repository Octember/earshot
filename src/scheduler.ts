import { inject, singleton } from "tsyringe";
import { Debounced } from "./debounce";
import { Ear } from "./ear";
import { Execution } from "./execution";
import { Inboxes } from "./inboxes";
import { LEDGER, type Ledger } from "./ledger/db";
import { dispatchRunnable, msUntilNextWake, wakeDueTasks } from "./ledger/scheduler";
import { log } from "./log";
import { POLICY, type Policy } from "./policy";
import { Wake } from "./wake";

/** The one place that decides what runs next. Wake, Ear and Execution only run; they never schedule. */
@singleton()
export class Scheduler {
  private readonly inflight = new Set<Promise<unknown>>();
  private stopping = false;
  private heartbeat: ReturnType<typeof setTimeout> | null = null;
  private readonly wakes = new Debounced((id) => this.guard(this.runWake(id)));
  private readonly ears = new Debounced((id) => this.guard(this.runEar(id)));

  constructor(
    @inject(LEDGER) private readonly db: Ledger,
    @inject(POLICY) private readonly policy: Policy,
    private readonly inboxes: Inboxes,
    private readonly wake: Wake,
    private readonly ear: Ear,
    private readonly execution: Execution,
  ) {}

  start(): void {
    this.tick();
    this.beat();
  }

  wakeSoon(identityId: string): void {
    this.wakes.schedule(identityId, 0);
  }

  listenSoon(identityId: string, delayMs: number): void {
    this.ears.schedule(identityId, delayMs);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeat) clearTimeout(this.heartbeat);
    this.ears.flush();
    this.wakes.flush();
    while (this.inflight.size > 0) await Promise.allSettled(this.inflight);
  }

  private async runWake(identityId: string): Promise<void> {
    await this.wake.run(identityId);
    this.tick();
    if (this.inboxes.of(identityId).pending().length > 0) this.wakeSoon(identityId);
  }

  private async runEar(identityId: string): Promise<void> {
    if (await this.ear.run(identityId)) this.wakeSoon(identityId);
  }

  private async runExecution(taskId: string): Promise<void> {
    const settled = await this.execution.launch(taskId);
    if (settled) this.wakeSoon(settled);
    this.tick();
  }

  private beat(): void {
    if (this.stopping) return;
    this.heartbeat = setTimeout(
      () => {
        this.tick();
        this.beat();
      },
      msUntilNextWake(this.db, 60_000),
    );
  }

  private tick(): void {
    if (this.stopping) return;
    try {
      for (const identityId of wakeDueTasks(this.db)) this.wakeSoon(identityId);
      const { executions } = this.policy;
      for (const taskId of dispatchRunnable(this.db, {
        maxConcurrentPerIdentity: executions.max_concurrent_per_identity,
        maxConcurrentGlobal: executions.max_concurrent_global,
      }))
        void this.guard(this.runExecution(taskId));
    } catch (error) {
      log.error("tick failed", { error: String(error) });
    }
  }

  private guard(work: Promise<void>): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.inflight.add(work);
    return work.finally(() => {
      this.inflight.delete(work);
    });
  }
}
