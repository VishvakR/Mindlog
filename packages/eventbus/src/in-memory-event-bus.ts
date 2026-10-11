import type { Counter, Logger, Metrics } from '@mindlog/core';
import type { EventBus, Handler, Unsubscribe } from './event-bus.js';
import type { DomainEvent, DomainEventType } from './events.js';

export interface InMemoryEventBusDeps {
  readonly logger: Logger;
  readonly metrics: Metrics;
}

type AnyHandler = (event: DomainEvent) => void | Promise<void>;

/**
 * Synchronous in-process EventBus. Each publish delivers to a snapshot of the
 * current handlers; handler failures (thrown or rejected) are logged and
 * counted, never propagated to the publisher or the other handlers.
 */
export class InMemoryEventBus implements EventBus {
  readonly #handlers = new Map<DomainEventType, AnyHandler[]>();
  readonly #logger: Logger;
  readonly #published: Counter;
  readonly #failures: Counter;

  constructor(deps: InMemoryEventBusDeps) {
    this.#logger = deps.logger.child({ module: 'eventbus' });
    this.#published = deps.metrics.counter({
      name: 'mindlog_eventbus_events_published_total',
      help: 'Domain events published, by type',
      labelNames: ['type'],
    });
    this.#failures = deps.metrics.counter({
      name: 'mindlog_eventbus_handler_errors_total',
      help: 'Event handlers that threw or rejected, by event type',
      labelNames: ['type'],
    });
  }

  publish(event: DomainEvent): void {
    this.#published.inc(1, { type: event.type });
    const handlers = this.#handlers.get(event.type);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        const outcome = handler(event);
        if (outcome instanceof Promise) {
          outcome.catch((error: unknown) => {
            this.#reportFailure(event.type, error);
          });
        }
      } catch (error: unknown) {
        this.#reportFailure(event.type, error);
      }
    }
  }

  subscribe<T extends DomainEventType>(type: T, handler: Handler<T>): Unsubscribe {
    const entry = handler as AnyHandler;
    const list = this.#handlers.get(type) ?? [];
    this.#handlers.set(type, [...list, entry]);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.#handlers.get(type) ?? [];
      this.#handlers.set(
        type,
        current.filter((h) => h !== entry),
      );
    };
  }

  #reportFailure(type: DomainEventType, error: unknown): void {
    this.#failures.inc(1, { type });
    this.#logger.error('event handler failed', {
      eventType: type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
