import type { ApplyHandler, BodyCase } from './apply-handler.js';

/** One handler per command body kind, registered by the composition root. */
export class ApplyHandlerRegistry {
  readonly #handlers = new Map<BodyCase, ApplyHandler>();

  register(handler: ApplyHandler): void {
    if (this.#handlers.has(handler.body)) {
      throw new Error(`an apply handler for '${handler.body}' is already registered`);
    }
    this.#handlers.set(handler.body, handler);
  }

  get(body: BodyCase): ApplyHandler | undefined {
    return this.#handlers.get(body);
  }

  list(): BodyCase[] {
    return [...this.#handlers.keys()];
  }
}
