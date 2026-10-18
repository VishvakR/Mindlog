import type { MindlogError, Result } from '@mindlog/core';
import { crc32c, err, mindlogError, ok } from '@mindlog/core';
import type {
  Capability,
  EmbedKind,
  Embeddings,
  EntitySpan,
  ExtractedFacts,
  Models,
  ModelServiceStatus,
  NliLabel,
  NliResults,
  RecognizedEntities,
  RerankScores,
} from './ports.js';

const DIMS = 384;
const WORD = /\p{L}[\p{L}\p{N}'-]*/gu;
const SENTENCE = /[^.!?\n]+[.!?]*/g;
const CHIT_CHAT = /^(hi|hello|hey|thanks|thank you|ok|okay|bye)\b/i;
const PROCEDURAL = /^(always|never|make sure|remember to|don't|do not)\b/i;
const NEGATION = /\b(not|no|never|no longer)\b|n't\b/i;
const encoder = new TextEncoder();

function words(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []).filter((w) => w.length > 1 || w === 'i');
}

/**
 * Deterministic stand-in for the model service (tests, the simulator, the
 * demo without models): bag-of-words hash embeddings, capitalised-word
 * entities, negation NLI, word-overlap rerank and sentence facts.
 */
export class FakeModels implements Models {
  /** Answer every call with `UNAVAILABLE`, as a stopped service would. */
  down = false;
  /** Answer every call with this error instead. */
  failWith: MindlogError | undefined;
  /** Calls received, including failed ones. */
  calls = 0;

  #gate<T>(value: () => T): Promise<Result<T, MindlogError>> {
    this.calls++;
    if (this.down) return Promise.resolve(err(mindlogError('UNAVAILABLE', 'model service down')));
    if (this.failWith) return Promise.resolve(err(this.failWith));
    return Promise.resolve(ok(value()));
  }

  embed(texts: readonly string[], _kind: EmbedKind): Promise<Result<Embeddings, MindlogError>> {
    return this.#gate(() => ({
      modelId: 'fake-embed@1',
      dims: DIMS,
      vectors: texts.map((t) => {
        const v = new Float32Array(DIMS);
        for (const w of words(t)) {
          const i = crc32c(encoder.encode(w)) % DIMS;
          v[i] = (v[i] ?? 0) + 1;
        }
        let norm = 0;
        for (const x of v) norm += x * x;
        if (norm === 0) v[0] = 1;
        else for (let i = 0; i < DIMS; i++) v[i] = (v[i] ?? 0) / Math.sqrt(norm);
        return v;
      }),
    }));
  }

  recognize(
    texts: readonly string[],
    labels: readonly string[],
  ): Promise<Result<RecognizedEntities, MindlogError>> {
    return this.#gate(() => ({
      modelId: 'fake-ner@1',
      spans: texts.map((text) => {
        const spans: EntitySpan[] = [];
        for (const m of text.matchAll(/\p{Lu}\p{Ll}+/gu)) {
          // The first word of a sentence is capitalised anyway.
          const before = text.slice(0, m.index).trimEnd();
          if (before === '' || /[.!?]$/.test(before)) continue;
          spans.push({
            start: m.index,
            end: m.index + m[0].length,
            text: m[0],
            label: labels[0] ?? 'entity',
            score: 0.9,
          });
        }
        return spans;
      }),
    }));
  }

  classify(
    pairs: ReadonlyArray<readonly [string, string]>,
  ): Promise<Result<NliResults, MindlogError>> {
    return this.#gate(() => ({
      modelId: 'fake-nli@1',
      results: pairs.map(([premise, hypothesis]) => {
        const shared = words(premise).some((w) => words(hypothesis).includes(w));
        let label: NliLabel = 'neutral';
        if (premise.trim() === hypothesis.trim()) label = 'entailment';
        else if (shared && NEGATION.test(premise) !== NEGATION.test(hypothesis))
          label = 'contradiction';
        return { label, score: 0.9 };
      }),
    }));
  }

  rerank(query: string, documents: readonly string[]): Promise<Result<RerankScores, MindlogError>> {
    const q = new Set(words(query));
    return this.#gate(() => ({
      modelId: 'fake-rerank@1',
      scores: documents.map((d) => words(d).filter((w) => q.has(w)).length),
    }));
  }

  extractFacts(text: string): Promise<Result<ExtractedFacts, MindlogError>> {
    return this.#gate(() => ({
      modelId: 'fake-extract@1',
      facts: [...text.matchAll(SENTENCE)]
        .map((m) => m[0].trim())
        .filter((s) => s !== '' && !s.endsWith('?') && !CHIT_CHAT.test(s))
        .filter((s) => s.split(/\s+/).length >= 3)
        .map((s) => ({
          text: s,
          kind: PROCEDURAL.test(s) ? 'procedural' : 'semantic',
          relations: [],
        })),
    }));
  }

  health(): Promise<Result<ModelServiceStatus, MindlogError>> {
    const capability = (c: Capability) => ({ modelId: `fake-${c}@1`, ready: true });
    return this.#gate(() => ({
      ready: true,
      capabilities: {
        embed: capability('embed'),
        ner: capability('ner'),
        nli: capability('nli'),
        rerank: capability('rerank'),
        extract: capability('extract'),
      },
    }));
  }
}
