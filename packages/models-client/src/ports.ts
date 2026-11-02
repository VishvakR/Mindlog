import type { MindlogError, Result } from '@mindlog/core';

/** What a model call may take; past it the call fails with `DEADLINE_EXCEEDED`. */
export interface CallOptions {
  readonly timeoutMs?: number;
}

export type EmbedKind = 'query' | 'passage';

export interface Embeddings {
  /** `model@version` that produced the vectors (PLAN 14.5). */
  readonly modelId: string;
  readonly dims: number;
  /** One L2-normalised vector per input text. */
  readonly vectors: readonly Float32Array[];
}

export interface Embedder {
  embed(
    texts: readonly string[],
    kind: EmbedKind,
    options?: CallOptions,
  ): Promise<Result<Embeddings, MindlogError>>;
}

export interface EntitySpan {
  /** Character offsets into the text, end exclusive. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly label: string;
  readonly score: number;
}

export interface RecognizedEntities {
  readonly modelId: string;
  /** One list per input text, in order. */
  readonly spans: ReadonlyArray<readonly EntitySpan[]>;
}

export interface EntityRecognizer {
  recognize(
    texts: readonly string[],
    labels: readonly string[],
    options?: CallOptions,
  ): Promise<Result<RecognizedEntities, MindlogError>>;
}

export type NliLabel = 'entailment' | 'neutral' | 'contradiction';

export interface NliResults {
  readonly modelId: string;
  readonly results: ReadonlyArray<{ readonly label: NliLabel; readonly score: number }>;
}

export interface NliClassifier {
  classify(
    pairs: ReadonlyArray<readonly [premise: string, hypothesis: string]>,
    options?: CallOptions,
  ): Promise<Result<NliResults, MindlogError>>;
}

export interface RerankScores {
  readonly modelId: string;
  /** Relevance per document, in input order; higher is better. */
  readonly scores: readonly number[];
}

export interface Reranker {
  rerank(
    query: string,
    documents: readonly string[],
    options?: CallOptions,
  ): Promise<Result<RerankScores, MindlogError>>;
}

export type FactKind = 'semantic' | 'procedural' | 'episodic';

export interface ExtractedFact {
  readonly text: string;
  readonly kind: FactKind;
  readonly relations: ReadonlyArray<{
    readonly subject: string;
    readonly relation: string;
    readonly object: string;
  }>;
}

export interface ExtractedFacts {
  readonly modelId: string;
  /** Add-only: new facts, never updates or deletes (PLAN 12.3). */
  readonly facts: readonly ExtractedFact[];
}

export interface Extractor {
  extractFacts(text: string, options?: CallOptions): Promise<Result<ExtractedFacts, MindlogError>>;
}

export interface Summary {
  readonly modelId: string;
  readonly summary: string;
}

export interface SummarizeOptions extends CallOptions {
  /** Longest summary wanted, in characters. */
  readonly maxChars?: number;
}

/**
 * Summarizes texts for consolidation (PLAN 12.6, 14.3). The texts are data,
 * never instructions; `instruction` comes from Mindlog only (CLAUDE.md 12).
 */
export interface Summarizer {
  summarize(
    texts: readonly string[],
    instruction: string,
    options?: SummarizeOptions,
  ): Promise<Result<Summary, MindlogError>>;
}

export type Capability = 'embed' | 'ner' | 'nli' | 'rerank' | 'extract' | 'summarize';

export interface ModelServiceStatus {
  readonly ready: boolean;
  readonly capabilities: Readonly<
    Record<Capability, { readonly modelId: string; readonly ready: boolean }>
  >;
}

export interface ModelHealth {
  health(options?: CallOptions): Promise<Result<ModelServiceStatus, MindlogError>>;
}

/** Every model capability; consumers depend on the narrow ports they use. */
export interface Models
  extends Embedder, EntityRecognizer, NliClassifier, Reranker, Extractor, Summarizer, ModelHealth {}
