import { hlcMs } from '@mindlog/memory';
import type { CommandApplied, EventBus, Unsubscribe } from '@mindlog/eventbus';

// Change streams (PLAN 6.3, 13.5): what memory commands changed, as events a
// subscriber can follow from a resumable cursor `rangeId:index`.

export const CHANGE_TYPES = [
  'memory.added',
  'memory.forgotten',
  'memory.evolved',
  'conflict.raised',
  'conflict.resolved',
  'branch.created',
  'branch.merged',
  'branch.dropped',
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export interface ChangeEvent {
  /** Resume after this event with `from: cursor`. */
  readonly cursor: string;
  readonly type: ChangeType;
  readonly tenant: string;
  readonly user: string;
  /** Set when the change happened on a branch (ADR-0013). */
  readonly branch?: string;
  /** Memory, conflict or branch ids, by type. */
  readonly ids: readonly string[];
  readonly principal: string;
  /** Physical time of the command (HLC). */
  readonly atMs: number;
}

/** The subscriber's cursor is older than what this node still holds: re-read state, then follow. */
export interface Resync {
  readonly type: 'resync';
}

export interface ChangeFilter {
  readonly tenant: string;
  readonly user: string;
}

/** The change events of one applied command; none for failed or repeated commands. */
export function changesOf(e: CommandApplied): ChangeEvent[] {
  const { command, result } = e;
  const body = command.body;
  if (e.duplicate || result.outcome.case === 'error' || body.case === undefined) return [];
  const done = result.outcome.case === 'memory' ? result.outcome.value.ids : [];
  const base = {
    cursor: `${String(e.rangeId)}:${String(e.index)}`,
    tenant: command.tenant,
    principal: command.principal,
    atMs: hlcMs(command.hlc),
    ...(command.branch && command.branch !== 'main' ? { branch: command.branch } : {}),
  };
  const out: ChangeEvent[] = [];
  const add = (type: ChangeType, user: string, ids: readonly string[]) => {
    if (ids.length > 0) out.push({ ...base, type, user, ids: [...ids] });
  };
  switch (body.case) {
    case 'memoryCommit': {
      const c = body.value;
      add('memory.added', c.user, done);
      add(
        'memory.evolved',
        c.user,
        c.supersede.map((s) => s.id),
      );
      add(
        'conflict.raised',
        c.user,
        c.conflicts.filter((x) => x.status === 'open').map((x) => x.id),
      );
      add(
        'conflict.resolved',
        c.user,
        c.conflicts.filter((x) => x.status !== 'open').map((x) => x.id),
      );
      break;
    }
    case 'memoryForget':
      add('memory.forgotten', body.value.user, done);
      break;
    case 'memoryTrust':
    case 'memoryMaintain':
      add('memory.evolved', body.value.user, done);
      break;
    case 'conflictResolve':
      add('conflict.resolved', body.value.user, [body.value.id]);
      add('memory.evolved', body.value.user, done);
      break;
    case 'branchCreate':
      add('branch.created', body.value.user, [body.value.name]);
      break;
    case 'branchMerge': {
      const m = body.value;
      add('branch.merged', m.user, [m.name]);
      add('memory.added', m.user, done);
      add(
        'conflict.raised',
        m.user,
        m.conflicts.filter((x) => x.status === 'open').map((x) => x.id),
      );
      break;
    }
    case 'branchDrop':
      add('branch.dropped', body.value.user, [body.value.name]);
      break;
    default:
  }
  return out;
}

interface Tail {
  readonly events: ChangeEvent[];
  /** Commands up to this index are no longer held (evicted, or before this node followed the range). */
  lostThrough: bigint;
}

type Listener = (event: ChangeEvent | Resync) => void;

const parseCursor = (c: string): { rangeId: string; index: bigint } | undefined => {
  const m = /^(\d+):(\d+)$/.exec(c);
  return m?.[1] && m[2] ? { rangeId: m[1], index: BigInt(m[2]) } : undefined;
};

/**
 * The change stream of the ranges this node holds a replica of: every replica
 * applies the same log, so any one of them serves it. Keeps the last
 * `tailSize` events per range for resuming; an older cursor gets `resync`.
 *
 * shortcut: resuming reads only the in-memory tail, not the Raft log, so a
 * restart or a long gap means resync; read the log when clients need longer gaps.
 */
export class ChangeFeed {
  readonly #tailSize: number;
  readonly #tails = new Map<string, Tail>();
  readonly #listeners = new Set<{ filter: ChangeFilter | undefined; listener: Listener }>();

  constructor(options: { tailSize?: number } = {}) {
    this.#tailSize = options.tailSize ?? 1000;
  }

  attach(bus: EventBus): Unsubscribe {
    return bus.subscribe('CommandApplied', (e) => {
      this.#append(e);
    });
  }

  #append(e: CommandApplied): void {
    const rangeId = String(e.rangeId);
    let tail = this.#tails.get(rangeId);
    if (!tail) {
      tail = { events: [], lostThrough: e.index - 1n };
      this.#tails.set(rangeId, tail);
    }
    for (const event of changesOf(e)) {
      tail.events.push(event);
      for (const s of this.#listeners)
        if (!s.filter || (s.filter.tenant === event.tenant && s.filter.user === event.user))
          s.listener(event);
    }
    while (tail.events.length > this.#tailSize) {
      const dropped = tail.events.shift();
      const at = dropped && parseCursor(dropped.cursor);
      if (at) tail.lostThrough = at.index;
    }
  }

  /** Every change on this node, for adapters that filter themselves (MCP notifications). */
  follow(listener: (event: ChangeEvent) => void): Unsubscribe {
    const entry = { filter: undefined, listener: listener as Listener };
    this.#listeners.add(entry);
    return () => {
      this.#listeners.delete(entry);
    };
  }

  /**
   * Follows the changes of a user scope. With `from`, first replays the held
   * events after that cursor, or sends `resync` if some were not held.
   */
  subscribe(filter: ChangeFilter, from: string | undefined, listener: Listener): Unsubscribe {
    if (from !== undefined) {
      const at = parseCursor(from);
      const tail = at && this.#tails.get(at.rangeId);
      if (!at || !tail || at.index < tail.lostThrough) listener({ type: 'resync' });
      else
        for (const event of tail.events) {
          const c = parseCursor(event.cursor);
          if (
            c &&
            c.index > at.index &&
            event.tenant === filter.tenant &&
            event.user === filter.user
          )
            listener(event);
        }
    }
    const entry = { filter, listener };
    this.#listeners.add(entry);
    return () => {
      this.#listeners.delete(entry);
    };
  }
}
