import { defaultSleep } from '../http-exchange';

/**
 * Keeps calls to one service at least `intervalMs` apart, across all checks running in this
 * process (GDELT asks for one request every 5 seconds; Brave's free plan allows one per second).
 */
export class Throttle {
  private next = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  /** Resolves when the caller may send its request. */
  wait(): Promise<void> {
    const turn = this.queue.then(async () => {
      const delay = this.next - this.now();
      if (delay > 0) await this.sleep(delay);
      this.next = this.now() + this.intervalMs;
    });
    this.queue = turn.catch(() => undefined);
    return turn;
  }
}
