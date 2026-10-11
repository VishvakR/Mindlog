import type { ScopePath } from '@mindlog/core';
import type { Command } from '@mindlog/proto';

/**
 * Domain events (PLAN 4.4). They are emitted after a command is applied
 * locally and are facts about this node only: never a replication mechanism,
 * never an input to decisions replicas must agree on (CLAUDE.md §3.6).
 */
export type DomainEvent =
  | CommandApplied
  | MemoryCommitted
  | ConflictRaised
  | BranchMerged
  | RecordChanged
  | LeaderChanged
  | RangeSplit
  | ModelServiceHealth;

export type DomainEventType = DomainEvent['type'];

export type EventOf<T extends DomainEventType> = Extract<DomainEvent, { type: T }>;

/** A command was applied to a range's state machine. */
export interface CommandApplied {
  readonly type: 'CommandApplied';
  readonly rangeId: bigint;
  readonly index: bigint;
  readonly command: Command;
}

/** Memory records were committed in a scope. */
export interface MemoryCommitted {
  readonly type: 'MemoryCommitted';
  readonly scope: ScopePath;
  readonly ids: readonly string[];
}

/** A semantic conflict was recorded for review. */
export interface ConflictRaised {
  readonly type: 'ConflictRaised';
  readonly conflictId: string;
  readonly scope: ScopePath;
}

/** A memory branch was merged into its parent. */
export interface BranchMerged {
  readonly type: 'BranchMerged';
  readonly scope: ScopePath;
  readonly branch: string;
}

/** A full-stack collection record changed. */
export interface RecordChanged {
  readonly type: 'RecordChanged';
  readonly collection: string;
  readonly id: string;
  readonly op: 'create' | 'update' | 'delete';
}

/** This node observed a new leader (or none) for a range. */
export interface LeaderChanged {
  readonly type: 'LeaderChanged';
  readonly rangeId: bigint;
  readonly leader: string | null;
}

/** A range split into two. */
export interface RangeSplit {
  readonly type: 'RangeSplit';
  readonly parent: bigint;
  readonly left: bigint;
  readonly right: bigint;
}

/** The model sidecar became reachable or unreachable. */
export interface ModelServiceHealth {
  readonly type: 'ModelServiceHealth';
  readonly up: boolean;
}

// A record keyed by every event type, so adding an event without listing it fails to compile.
const EVENT_TYPES = {
  CommandApplied: true,
  MemoryCommitted: true,
  ConflictRaised: true,
  BranchMerged: true,
  RecordChanged: true,
  LeaderChanged: true,
  RangeSplit: true,
  ModelServiceHealth: true,
} as const satisfies Record<DomainEventType, true>;

export const DOMAIN_EVENT_TYPES = Object.keys(EVENT_TYPES) as readonly DomainEventType[];
