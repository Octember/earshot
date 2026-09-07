import { inject, singleton } from "tsyringe";
import { Debounced } from "./debounce";
import { Ear } from "./ear";
import { Execution } from "./execution";
import { Inbox } from "./inbox";
import { LEDGER, type Ledger } from "./ledger/db";
import {
  dispatchRunnable,
  msUntilNextWake,
  recoverFromRestart,
  wakeDueTasks,
} from "./ledger/scheduler";
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
    private readonly inbox: Inbox,
    private readonly wake: Wake,
    private readonly ear: Ear,
    private readonly execution: Execution,
  ) {}

  start(): void {
    recoverFromRestart(this.db, this.policy.executions.max_attempts);
    this.tick();
    this.beat();
  }

  wakeSoon(identityId: string): void {
    if (this.stopping) return;
    this.wakes.schedule(identityId, 0);
  }

  listenSoon(identityId: string, delayMs: number): void {
    if (this.stopping) return;
    this.ears.schedule(identityId, delayMs);
  }

  /** Pending ear and wake timers run now (nothing heard is dropped); then nothing new starts. */
  async stop(): Promise<void> {
    this.ears.flush();
    this.wakes.flush();
    this.stopping = true;
    if (this.heartbeat) clearTimeout(this.heartbeat);
    while (this.inflight.size > 0) await Promise.allSettled(this.inflight);
  }

  private async runWake(identityId: string): Promise<void> {
    await this.wake.run(identityId);
    this.tick();
    if (this.inbox.pending(identityId).length > 0) this.wakeSoon(identityId);
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
    this.inflight.add(work);
    return work.finally(() => {
      this.inflight.delete(work);
    });
  }
}
