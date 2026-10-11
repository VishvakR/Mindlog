import type { Clock } from '../clock/clock.js';
import type { MindlogError } from '../errors/mindlog-error.js';
import { mindlogError } from '../errors/mindlog-error.js';
import type { Random } from '../random/random.js';
import type { Result } from '../result/result.js';
import { err, ok } from '../result/result.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_BYTES = 10;
const MAX_TIME = (1n << 48n) - 1n;
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * Monotonic ULID generator (48-bit ms timestamp + 80 random bits, Crockford
 * base32). Ids sort by creation time; within one millisecond, or if the clock
 * steps backwards, the random part is incremented so ids still strictly increase.
 * Time and randomness come from ports, so ids are reproducible in simulation.
 */
export class UlidGenerator {
  readonly #clock: Clock;
  readonly #random: Random;
  #lastTime = -1n;
  readonly #lastRandom = new Uint8Array(RANDOM_BYTES);

  constructor(clock: Clock, random: Random) {
    this.#clock = clock;
    this.#random = random;
  }

  next(): string {
    const now = this.#clock.now();
    if (now > this.#lastTime) {
      this.#lastTime = now;
      this.#random.fillBytes(this.#lastRandom);
    } else if (!incrementBigEndian(this.#lastRandom)) {
      // 2^80 ids in one millisecond: borrow the next millisecond.
      this.#lastTime += 1n;
      this.#random.fillBytes(this.#lastRandom);
    }
    if (this.#lastTime > MAX_TIME || this.#lastTime < 0n) {
      throw new RangeError(`ULID timestamp out of range: ${this.#lastTime}`);
    }
    return encodeTime(this.#lastTime) + encodeRandom(this.#lastRandom);
  }
}

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

/** Millisecond timestamp embedded in a ULID. */
export function ulidTime(id: string): Result<bigint, MindlogError> {
  if (!isUlid(id)) return err(mindlogError('INVALID_ARGUMENT', `not a ULID: "${id}"`));
  let time = 0n;
  for (let i = 0; i < TIME_CHARS; i++) {
    time = time * 32n + BigInt(ALPHABET.indexOf(id.charAt(i)));
  }
  return ok(time);
}

function encodeTime(time: bigint): string {
  let out = '';
  let t = time;
  for (let i = 0; i < TIME_CHARS; i++) {
    out = ALPHABET.charAt(Number(t % 32n)) + out;
    t /= 32n;
  }
  return out;
}

/** 80 bits → 16 base32 chars, 5 bits at a time from the most significant end. */
function encodeRandom(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET.charAt((buffer >>> bits) & 31);
    }
  }
  return out;
}

/** Adds one in place; returns false on overflow (all bytes were 0xff). */
function incrementBigEndian(bytes: Uint8Array): boolean {
  for (let i = bytes.length - 1; i >= 0; i--) {
    const byte = bytes[i] ?? 0;
    if (byte < 0xff) {
      bytes[i] = byte + 1;
      return true;
    }
    bytes[i] = 0;
  }
  return false;
}
