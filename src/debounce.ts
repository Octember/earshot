/** One run at a time per id; a schedule during a run queues exactly one more. */
export class Debounced {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Set<string>();
  private readonly rerun = new Set<string>();

  constructor(private readonly run: (id: string) => Promise<void>) {}

  schedule(id: string, delayMs: number): void {
    if (delayMs <= 0) {
      const prior = this.timers.get(id);
      if (prior) clearTimeout(prior);
      this.timers.delete(id);
      this.start(id);
      return;
    }
    if (this.timers.has(id)) return;
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        this.start(id);
      }, delayMs),
    );
  }

  flush(): void {
    for (const [id, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(id);
      this.start(id);
    }
  }

  private start(id: string): void {
    if (this.running.has(id)) {
      this.rerun.add(id);
      return;
    }
    this.running.add(id);
    void this.run(id).finally(() => {
      this.running.delete(id);
      if (this.rerun.delete(id)) this.start(id);
    });
  }
}
