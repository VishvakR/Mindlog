import type { MemoryKind, MemoryLinkView, RememberInput, Trust } from '../types.js';
import type { RedactionKind } from './redact.js';

// The ingestion draft the stages fill in (PLAN 12.3).

export interface DraftFact {
  readonly text: string;
  readonly kind: MemoryKind;
  readonly relations: ReadonlyArray<{ subject: string; relation: string; object: string }>;
  readonly mentions: ReadonlyArray<{ name: string; type: string }>;
  readonly vector?: Float32Array;
  readonly importance: number;
  readonly links: readonly MemoryLinkView[];
  readonly trust: Trust;
}

/** What the ingestion stages fill in, in order (PLAN 12.3). */
export interface IngestDraft {
  readonly input: RememberInput;
  /** What stage 2 masks; empty when the tenant has no redaction policy. */
  readonly redact: readonly RedactionKind[];
  readonly text: string;
  readonly passages: readonly string[];
  readonly facts: readonly DraftFact[];
  readonly embeddingModel: string;
  /** Conflict detection results per fact, in order (stage 10). */
  readonly checks?: readonly Checked[];
}

/** A conflict the leader found for a new fact (ADR-0015). */
export interface DraftConflict {
  /** The existing memory. */
  readonly with: string;
  readonly scoreAB: number;
  readonly scoreBA: number;
  readonly status: 'open' | 'resolved';
  readonly policy: string;
  readonly modelId: string;
}

/** A fact checked against existing memory: what the checks change on it. */
export interface Checked {
  readonly fact: DraftFact;
  readonly conflicts: readonly DraftConflict[];
  /** Existing facts whose validity ends, and when (world time, ms). */
  readonly supersede: ReadonlyArray<{ readonly id: string; readonly validTo: number }>;
}
