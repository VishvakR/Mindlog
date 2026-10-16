import type { Scheduler } from './ports.js';

/** Real timers. `defer` uses setImmediate so it keeps the caller's async context (traces). */
export class SystemScheduler implements Scheduler {
  every(ms: number, fn: () => void): () => void {
    const timer = setInterval(fn, ms);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  }

  defer(fn: () => void): void {
    setImmediate(fn);
  }
}
