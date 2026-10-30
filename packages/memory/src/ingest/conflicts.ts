import type { NliResults } from '@mindlog/models-client';
import type { Trust } from '../types.js';

// Conflict detection decisions (PLAN 13.2, ADR-0015): pure, so they are unit-tested
// and every replica applies what the leader decided.

export const CONFLICT_POLICIES = [
  'quarantine_new',
  'newest_wins',
  'ask_human',
  'prefer_verified',
] as const;
export type ConflictPolicy = (typeof CONFLICT_POLICIES)[number];

export interface ConflictConfig {
  /** Contradiction probability that makes a conflict (θ_c, default 0.80). */
  readonly conflictThreshold: number;
  /** Entailment probability that makes a duplicate (default 0.90). */
  readonly duplicateThreshold: number;
  readonly conflictPolicy: ConflictPolicy;
  /** Existing facts compared with each new one, by similarity and by shared entity. */
  readonly conflictCandidates: number;
  /** Cosine a candidate needs to the new fact to be compared at all. */
  readonly conflictMinSimilarity: number;
}

/** World-time validity of a fact in ms; 0 is open. */
export interface Window {
  readonly validFrom: number;
  readonly validTo: number;
}

/**
 * Graphiti's temporal rule: two facts whose windows are both known and do not
 * overlap describe a change over time, not a contradiction.
 */
export function disjoint(a: Window, b: Window): boolean {
  if (a.validFrom === 0 || b.validFrom === 0) return false;
  const aEnds = a.validTo !== 0 && a.validTo <= b.validFrom;
  const bEnds = b.validTo !== 0 && b.validTo <= a.validFrom;
  return aEnds || bEnds;
}

/**
 * When a contradicting new fact starts after an open-ended older one, the
 * older one simply stopped being true then: its `validTo` (Graphiti's
 * `invalid_at`), else undefined.
 */
export function supersedes(existing: Window, incoming: Window): number | undefined {
  return existing.validFrom !== 0 &&
    existing.validTo === 0 &&
    incoming.validFrom > existing.validFrom
    ? incoming.validFrom
    : undefined;
}

export type PairVerdict =
  | { readonly kind: 'contradiction'; readonly scoreAB: number; readonly scoreBA: number }
  | { readonly kind: 'duplicate'; readonly score: number }
  | { readonly kind: 'independent' };

type Nli = NliResults['results'][number] | undefined;

const contradiction = (r: Nli): number => (r?.label === 'contradiction' ? r.score : 0);

/**
 * One (existing, new) pair from NLI in both directions: a contradiction when
 * either direction says so with probability ≥ θ_c, a duplicate when the
 * existing fact entails the new one with probability ≥ the duplicate threshold.
 */
export function verdict(ab: Nli, ba: Nli, config: ConflictConfig): PairVerdict {
  const scoreAB = contradiction(ab);
  const scoreBA = contradiction(ba);
  if (Math.max(scoreAB, scoreBA) >= config.conflictThreshold)
    return { kind: 'contradiction', scoreAB, scoreBA };
  if (ab?.label === 'entailment' && ab.score >= config.duplicateThreshold)
    return { kind: 'duplicate', score: ab.score };
  return { kind: 'independent' };
}

/** What a policy does with a conflict between an existing fact and a new one. */
export interface PolicyOutcome {
  /** Trust the new fact is stored with. */
  readonly trust: Trust;
  /** The existing fact's validity ends now (the new one wins). */
  readonly supersedeExisting: boolean;
  readonly status: 'open' | 'resolved';
}

export function applyPolicy(
  policy: ConflictPolicy,
  existing: Trust,
  incoming: Trust,
): PolicyOutcome {
  const newestWins: PolicyOutcome = {
    trust: incoming,
    supersedeExisting: true,
    status: 'resolved',
  };
  const quarantine: PolicyOutcome = {
    trust: 'quarantined',
    supersedeExisting: false,
    status: 'open',
  };
  switch (policy) {
    case 'newest_wins':
      return newestWins;
    case 'ask_human':
      return { trust: incoming, supersedeExisting: false, status: 'open' };
    case 'prefer_verified':
      if (existing === 'verified' && incoming !== 'verified') return quarantine;
      if (incoming === 'verified' && existing !== 'verified') return newestWins;
      return quarantine;
    case 'quarantine_new':
      return quarantine;
  }
}
