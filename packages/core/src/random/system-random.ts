import { fillFromUint32, toUnitFloat } from './fill.js';
import type { Random } from './random.js';

const POOL_SIZE = 256;

/** Cryptographically secure randomness from `crypto.getRandomValues`, pooled. */
export class SystemRandom implements Random {
  readonly #pool = new Uint32Array(POOL_SIZE);
  #index = POOL_SIZE;

  nextUint32(): number {
    if (this.#index === POOL_SIZE) {
      globalThis.crypto.getRandomValues(this.#pool);
      this.#index = 0;
    }
    return this.#pool[this.#index++] ?? 0;
  }

  next(): number {
    return toUnitFloat(this.nextUint32(), this.nextUint32());
  }

  fillBytes(target: Uint8Array): void {
    fillFromUint32(target, () => this.nextUint32());
  }
}
