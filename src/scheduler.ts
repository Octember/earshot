import { inject, singleton, type Disposable } from "tsyringe";
import { Debounced } from "./debounce";
import { Ear } from "./ear";
import { Execution } from "./execution";
import { LedgerService } from "./ledger-service";
import { log } from "./log";
import { POLICY, type Policy } from "./policy";
import { Wake } from "./wake";

/** The one place that decides what runs next. Wake, Ear and Execution only run; they never schedule. */
@singleton()
export class Scheduler implements Disposable {
  private readonly inflight = new Set<Promise<unknown>>();
  private stopping = false;
  private heartbeat: ReturnType<typeof setTimeout> | null = null;
  private readonly wakes = new Debounced(() => this.guard(this.runWake()));
  private readonly ears = new Debounced(() => this.guard(this.runEar()));

  constructor(
    private readonly ledger: LedgerService,
    @inject(POLICY) private readonly policy: Policy,
    private readonly wake: Wake,
    private readonly ear: Ear,
    private readonly execution: Execution,
  ) {}

  start(): void {
    this.ledger.recoverFromRestart(this.policy.executions.max_attempts);
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

  /** Pending ear and wake timers run now (nothing heard is dropped); then nothing new starts. */
  async dispose(): Promise<void> {
    this.ears.flush();
    this.wakes.flush();
    this.stopping = true;
    if (this.heartbeat) clearTimeout(this.heartbeat);
    while (this.inflight.size > 0) await Promise.allSettled(this.inflight);
    log.info("service stopped");
  }

  private async runWake(): Promise<void> {
    await this.wake.run();
    this.tick();
  }

  private async runEar(): Promise<void> {
    if (await this.ear.run()) this.wakeSoon();
  }

  private async runExecution(taskId: string): Promise<void> {
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
    try {
      if (this.ledger.wakeDueTasks()) this.wakeSoon();
      for (const taskId of this.ledger.dispatchRunnable(this.policy.executions.max_concurrent))
        void this.guard(this.runExecution(taskId));
    } catch (error) {
      log.error("tick failed", { error: String(error) });
    }
  }

  private guard(work: Promise<void>): Promise<void> {
    this.inflight.add(work);
    return work.finally(() => {
      this.inflight.delete(work);
    });
  }
}
