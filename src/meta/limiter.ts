import { setTimeout as sleep } from "node:timers/promises";

/**
 * Bounds in-flight work to `maxConcurrency` and (optionally) spaces starts by
 * `minIntervalMs`, so the scaled extraction can fan out without bursting past
 * Meta's rate limits. Executor-free: tracks live promises in a Set and waits on
 * `Promise.race` when full.
 */
export class Limiter {
  private inflight = new Set<Promise<unknown>>();
  private lastStart = 0;

  constructor(
    private maxConcurrency = 1,
    private minIntervalMs = 0,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.inflight.size >= this.maxConcurrency) await Promise.race(this.inflight);
    if (this.minIntervalMs > 0) {
      const wait = this.lastStart + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
    }
    this.lastStart = Date.now();
    const p = fn();
    const tracked = p.finally(() => {
      this.inflight.delete(tracked);
    });
    this.inflight.add(tracked);
    return p;
  }
}
