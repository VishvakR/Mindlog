import type { Adjacency, GraphReader } from '@mindlog/index-graph';
import type { Bm25Stats, Posting, PostingReader } from '@mindlog/index-text';
import type { MemoryEntity, MemoryRecord } from '@mindlog/proto';
import type { ScopeReads } from './memory-reads.js';
import { memoryGraphOf } from './memory-reads.js';

/**
 * A branch as recall sees it (ADR-0013): its own space over main as of the
 * fork. The branch's records mask main's (a forgotten copy hides a main
 * memory); counts and postings add up; mentions and edges are the union.
 */
export class OverlayReads implements ScopeReads {
  readonly #branch: ScopeReads;
  readonly #main: ScopeReads;

  /** `main` reads at the fork version; `branch` reads the branch space. */
  constructor(branch: ScopeReads, main: ScopeReads) {
    this.#branch = branch;
    this.#main = main;
  }

  get at(): bigint | undefined {
    return undefined;
  }

  async record(id: string): Promise<MemoryRecord | undefined> {
    return (await this.#branch.record(id)) ?? this.#main.record(id);
  }

  /** Both spaces' records in id order; the branch's copy wins. */
  async *records(after?: string): AsyncGenerator<MemoryRecord> {
    const branch = this.#branch.records(after);
    const main = this.#main.records(after);
    let b = await branch.next();
    let m = await main.next();
    while (!b.done || !m.done) {
      if (b.done || (!m.done && m.value.id < b.value.id)) {
        yield m.value;
        m = await main.next();
        continue;
      }
      if (!m.done && m.value.id === b.value.id) m = await main.next();
      yield b.value;
      b = await branch.next();
    }
  }

  async entity(id: string): Promise<MemoryEntity | undefined> {
    return (await this.#branch.entity(id)) ?? this.#main.entity(id);
  }

  async mentions(entityId: string, limit = 1000): Promise<string[]> {
    const [b, m] = await Promise.all([
      this.#branch.mentions(entityId, limit),
      this.#main.mentions(entityId, limit),
    ]);
    return [...new Set([...b, ...m])].slice(0, limit);
  }

  postings(): PostingReader {
    const b = this.#branch.postings();
    const m = this.#main.postings();
    return {
      async stats(): Promise<Bm25Stats> {
        const [x, y] = await Promise.all([b.stats(), m.stats()]);
        return { docs: x.docs + y.docs, totalLength: x.totalLength + y.totalLength };
      },
      df: async (term) => (await b.df(term)) + (await m.df(term)),
      async *postings(term): AsyncGenerator<Posting & { id: string }> {
        yield* b.postings(term);
        yield* m.postings(term);
      },
    };
  }

  graph(): GraphReader {
    const b = this.#branch.graph();
    const m = this.#main.graph();
    return {
      async *neighbors(node): AsyncGenerator<Adjacency> {
        yield* b.neighbors(node);
        yield* m.neighbors(node);
      },
    };
  }

  memoryGraph(mentionLimit: number): GraphReader {
    return memoryGraphOf(this, mentionLimit);
  }
}
