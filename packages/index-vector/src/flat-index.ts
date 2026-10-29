import type { VectorIndex, VectorMatch } from './vector-index.js';

const INITIAL_SLOTS = 64;

/**
 * Exact nearest neighbours by a full scan (ADR-0008): cosine similarity as the
 * dot product of L2-normalised vectors, the filter applied during the scan, and
 * ties broken by id so every replica returns the same order. Vectors live in
 * one growing `Float32Array`; a removal moves the last vector into the gap.
 *
 * shortcut: O(n·d) per search, a few ms at 10K × 384; switch to HNSW past ~100K vectors per scope.
 */
export class FlatIndex<M> implements VectorIndex<M> {
  readonly dims: number;
  #data: Float32Array;
  readonly #ids: string[] = [];
  readonly #meta: M[] = [];
  readonly #slots = new Map<string, number>();

  constructor(dims: number) {
    this.dims = dims;
    this.#data = new Float32Array(INITIAL_SLOTS * dims);
  }

  get size(): number {
    return this.#ids.length;
  }

  upsert(id: string, vector: Float32Array, meta: M): void {
    if (vector.length !== this.dims)
      throw new RangeError(
        `expected ${String(this.dims)} dimensions, got ${String(vector.length)}`,
      );
    let slot = this.#slots.get(id);
    if (slot === undefined) {
      slot = this.#ids.length;
      if ((slot + 1) * this.dims > this.#data.length) {
        const grown = new Float32Array(this.#data.length * 2);
        grown.set(this.#data);
        this.#data = grown;
      }
      this.#ids.push(id);
      this.#meta.push(meta);
      this.#slots.set(id, slot);
    } else {
      this.#meta[slot] = meta;
    }
    this.#data.set(vector, slot * this.dims);
  }

  get(id: string): Float32Array | undefined {
    const slot = this.#slots.get(id);
    return slot === undefined
      ? undefined
      : this.#data.slice(slot * this.dims, (slot + 1) * this.dims);
  }

  remove(id: string): boolean {
    const slot = this.#slots.get(id);
    if (slot === undefined) return false;
    const last = this.#ids.length - 1;
    if (slot !== last) {
      const lastId = this.#ids[last] as string;
      this.#data.copyWithin(slot * this.dims, last * this.dims, (last + 1) * this.dims);
      this.#ids[slot] = lastId;
      this.#meta[slot] = this.#meta[last] as M;
      this.#slots.set(lastId, slot);
    }
    this.#ids.pop();
    this.#meta.pop();
    this.#slots.delete(id);
    return true;
  }

  search(query: Float32Array, k: number, filter?: (meta: M, id: string) => boolean): VectorMatch[] {
    if (query.length !== this.dims)
      throw new RangeError(`expected ${String(this.dims)} dimensions, got ${String(query.length)}`);
    // The best k so far, worst first.
    const best: VectorMatch[] = [];
    const data = this.#data;
    const dims = this.dims;
    for (let slot = 0; slot < this.#ids.length; slot++) {
      const id = this.#ids[slot] as string;
      if (filter && !filter(this.#meta[slot] as M, id)) continue;
      let score = 0;
      const base = slot * dims;
      for (let i = 0; i < dims; i++) score += (query[i] as number) * (data[base + i] as number);
      if (best.length === k && !better(score, id, best[0] as VectorMatch)) continue;
      // Insert in order; k is small (tens), so a sorted array beats a heap here.
      let at = 0;
      while (at < best.length && better(score, id, best[at] as VectorMatch)) at++;
      best.splice(at, 0, { id, score });
      if (best.length > k) best.shift();
    }
    return best.reverse();
  }
}

function better(score: number, id: string, than: VectorMatch): boolean {
  return score > than.score || (score === than.score && id < than.id);
}
