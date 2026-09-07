export class Debounced {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private rerun = false;

  constructor(private readonly run: () => Promise<void>) {}

  schedule(delayMs: number): void {
    if (delayMs <= 0) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.start();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.start();
    }, delayMs);
  }

  private start(): void {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    void this.run().finally(() => {
      this.running = false;
      if (this.rerun) {
        this.rerun = false;
        this.start();
      }
    });
  }
}
