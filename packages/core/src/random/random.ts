/**
 * Randomness port (PLAN 4.3). Production uses SystemRandom; tests and the
 * simulator use SeededRandom so every run is reproducible from a seed.
 */
export interface Random {
  /** Uniform float in [0, 1) with 53 bits of precision. */
  next(): number;
  /** Uniform unsigned 32-bit integer. */
  nextUint32(): number;
  /** Fills `target` with uniform random bytes. */
  fillBytes(target: Uint8Array): void;
}
