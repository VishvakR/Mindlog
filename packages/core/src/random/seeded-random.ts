import { fillFromUint32, toUnitFloat } from './fill.js';
import type { Random } from './random.js';

const MASK64 = (1n << 64n) - 1n;

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** SplitMix64 step, used only to expand a seed into generator state. */
function splitMix64(state: { x: bigint }): bigint {
  state.x = (state.x + 0x9e3779b97f4a7c15n) & MASK64;
  let z = state.x;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return z ^ (z >> 31n);
}

/**
 * Deterministic PRNG: xoshiro128** (Blackman & Vigna) seeded via SplitMix64.
 * Same seed, same sequence, on every platform. Not cryptographically secure.
 */
export class SeededRandom implements Random {
  readonly #s = new Uint32Array(4);

  constructor(seed: bigint) {
    this.seed(seed);
  }

  /** Builds a generator from raw xoshiro128** state (for reference vectors). */
  static fromState(state: readonly [number, number, number, number]): SeededRandom {
    const random = new SeededRandom(0n);
    random.#s.set(state);
    return random;
  }

  /** Restarts the sequence from `seed`. */
  seed(seed: bigint): void {
    const sm = { x: BigInt.asUintN(64, seed) };
    const a = splitMix64(sm);
    const b = splitMix64(sm);
    this.#s[0] = Number(a >> 32n);
    this.#s[1] = Number(a & 0xffffffffn);
    this.#s[2] = Number(b >> 32n);
    this.#s[3] = Number(b & 0xffffffffn);
    if (this.#s.every((w) => w === 0)) this.#s[0] = 1; // all-zero state is a fixed point
  }

  nextUint32(): number {
    const s = this.#s;
    const s0 = s[0] ?? 0;
    const s1 = s[1] ?? 0;
    const s2 = s[2] ?? 0;
    const s3 = s[3] ?? 0;
    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    const n2 = s2 ^ s0;
    const n3 = s3 ^ s1;
    s[0] = s0 ^ n3;
    s[1] = s1 ^ n2;
    s[2] = n2 ^ t;
    s[3] = rotl(n3 >>> 0, 11);
    return result;
  }

  next(): number {
    return toUnitFloat(this.nextUint32(), this.nextUint32());
  }

  fillBytes(target: Uint8Array): void {
    fillFromUint32(target, () => this.nextUint32());
  }
}
