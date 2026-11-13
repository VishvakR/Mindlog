import type { Logger } from '@mindlog/core';

export interface Ticker {
  /** Stops the timer and waits for a tick in flight, so stores can close after it. */
  stop(): Promise<void>;
}

/**
 * Runs `tick` every `ms`, one at a time: a tick still running when the timer
 * fires again is not doubled, and a failed tick is logged, never left unhandled.
 */
export function ticker(
  name: string,
  tick: () => Promise<void>,
  ms: number,
  logger: Logger,
): Ticker {
  let running: Promise<void> | undefined;
  const timer = setInterval(() => {
    running ??= tick()
      .catch((e: unknown) => {
        logger.warn(`${name} tick failed`, { error: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        running = undefined;
      });
  }, ms);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
