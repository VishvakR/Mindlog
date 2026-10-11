import type { DomainEvent, DomainEventType, EventOf } from './events.js';

/** Receives one event type. A returned promise is awaited only for error reporting. */
export type Handler<T extends DomainEventType> = (event: EventOf<T>) => void | Promise<void>;

export type Unsubscribe = () => void;

/**
 * Event bus port (PLAN 4.3). `publish` delivers synchronously to the handlers
 * subscribed at that moment, in subscription order; a failing handler never
 * stops the others or the publisher.
 */
export interface EventBus {
  publish(event: DomainEvent): void;
  subscribe<T extends DomainEventType>(type: T, handler: Handler<T>): Unsubscribe;
}
