import type { KvHeader } from '@mindlog/proto';
import type { MvccScanOptions } from '@mindlog/storage';
import { compareBytes } from '@mindlog/storage';
import { lastElement, tailElements } from '../../model/element-name.js';
import { Tag, elementKey, elementPrefix } from '../../model/kv-keys.js';
import type { Keyspace } from '../../model/keyspace.js';
import type { LexBound, ScoreBound } from './zset-bounds.js';
import { normaliseScore } from './zset-bounds.js';

export interface Scored {
  readonly member: Uint8Array;
  readonly score: number;
}

const EMPTY = new Uint8Array();
const encodeScore = (score: number): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, score);
  return out;
};
const decodeScore = (bytes: Uint8Array): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0);
const withEnd = (key: Uint8Array): Uint8Array => {
  const out = new Uint8Array(key.length + 1);
  out.set(key);
  out[key.length] = 0xff;
  return out;
};

/**
 * Sorted set over two element families (PLAN 5.2): `z` member → score for point
 * lookups and `Z` (score, member) for ordered ranges. Score order equals key
 * order because doubles use the tuple layer's IEEE total-order encoding.
 */
export class ZsetOps {
  constructor(
    private readonly ks: Keyspace,
    private readonly name: Uint8Array,
    readonly header: KvHeader,
  ) {}

  private memberKey(member: Uint8Array): Uint8Array {
    return elementKey(
      this.ks.tenant,
      this.name,
      this.header.generation,
      Tag.ZSET_BY_MEMBER,
      member,
    );
  }

  private scoreKey(score: number, member?: Uint8Array): Uint8Array {
    const rest = member === undefined ? [score] : [score, member];
    return elementKey(
      this.ks.tenant,
      this.name,
      this.header.generation,
      Tag.ZSET_BY_SCORE,
      ...rest,
    );
  }

  async score(member: Uint8Array): Promise<number | undefined> {
    const stored = await this.ks.context.view.get(this.memberKey(member));
    return stored ? decodeScore(stored) : undefined;
  }

  /** Sets a member's score; reports whether it was added, changed or unchanged. */
  async set(member: Uint8Array, raw: number): Promise<'added' | 'updated' | 'same'> {
    const score = normaliseScore(raw);
    const old = await this.score(member);
    if (old === score) return 'same';
    if (old !== undefined) this.ks.writer.delete(this.scoreKey(old, member));
    this.ks.writer.put(this.memberKey(member), encodeScore(score));
    this.ks.writer.put(this.scoreKey(score, member), EMPTY);
    if (old !== undefined) return 'updated';
    this.header.count++;
    return 'added';
  }

  async remove(member: Uint8Array): Promise<boolean> {
    const old = await this.score(member);
    if (old === undefined) return false;
    this.ks.writer.delete(this.memberKey(member));
    this.ks.writer.delete(this.scoreKey(old, member));
    this.header.count--;
    return true;
  }

  /** Members ordered by (score, member) within score bounds. */
  async *byScore(min: ScoreBound, max: ScoreBound, reverse = false): AsyncGenerator<Scored> {
    const prefix = elementPrefix(
      this.ks.tenant,
      this.name,
      this.header.generation,
      Tag.ZSET_BY_SCORE,
    );
    const lower = this.scoreKey(min.value);
    const options: MvccScanOptions = {
      reverse,
      ...(min.exclusive ? { after: lower } : { from: lower }),
      before: max.exclusive ? this.scoreKey(max.value) : withEnd(this.scoreKey(max.value)),
    };
    for await (const entry of this.ks.context.view.scan(prefix, options)) {
      const [score, member] = tailElements(entry.key, 3);
      if (typeof score === 'number' && member instanceof Uint8Array) yield { member, score };
    }
  }

  /** Every member in score order. */
  all(reverse = false): AsyncGenerator<Scored> {
    const unbounded = (value: number) => ({ value, exclusive: false });
    return this.byScore(unbounded(-Infinity), unbounded(Infinity), reverse);
  }

  /** Members in byte order within lex bounds (meaningful when scores are equal). */
  async *byLex(min: LexBound, max: LexBound, reverse = false): AsyncGenerator<Scored> {
    const prefix = elementPrefix(
      this.ks.tenant,
      this.name,
      this.header.generation,
      Tag.ZSET_BY_MEMBER,
    );
    const options: MvccScanOptions = { reverse };
    const lower =
      min.kind === 'value'
        ? min.exclusive
          ? { after: this.memberKey(min.value) }
          : { from: this.memberKey(min.value) }
        : {};
    const upper =
      max.kind === 'value'
        ? { before: max.exclusive ? this.memberKey(max.value) : withEnd(this.memberKey(max.value)) }
        : {};
    if (min.kind === 'max' || max.kind === 'min') return;
    for await (const entry of this.ks.context.view.scan(prefix, {
      ...options,
      ...lower,
      ...upper,
    })) {
      yield { member: lastElement(entry.key), score: decodeScore(entry.value) };
    }
  }

  /** 0-based rank in score order (or reversed), or undefined if absent. */
  async rank(member: Uint8Array, reverse = false): Promise<number | undefined> {
    if ((await this.score(member)) === undefined) return undefined;
    let rank = 0;
    for await (const entry of this.all(reverse)) {
      if (compareBytes(entry.member, member) === 0) return rank;
      rank++;
    }
    return undefined;
  }
}
