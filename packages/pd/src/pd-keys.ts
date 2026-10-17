import type { TupleElement } from '@mindlog/core';
import { rangeLocalKey, rangeLocalPrefix } from '@mindlog/statemachine';

/** The placement driver's own Raft group (ADR-0010). Data ranges start at 1. */
export const PD_RANGE_ID = 0n;

/** Ids from this value up are handed out by `PdAllocIds` (below: node.raftId and range 1). */
export const FIRST_ALLOCATED_ID = 1000n;

/** Stored end key standing for +infinity: encoded keys never start with 0xff. */
export const INFINITY = Uint8Array.of(0xff);

const key = (tag: string, ...rest: TupleElement[]): Uint8Array =>
  rangeLocalKey(PD_RANGE_ID, `pd-${tag}`, ...rest);

export const nextIdKey = (): Uint8Array => key('next-id');
export const tsoKey = (): Uint8Array => key('tso');
export const versionKey = (): Uint8Array => key('version');
export const nodeKey = (nodeId: bigint): Uint8Array => key('node', nodeId);
export const rangeKey = (rangeId: bigint): Uint8Array => key('range', rangeId);
/** Index of ranges by end key: the range holding K is the first entry with end > K. */
export const rangeEndKey = (endKey: Uint8Array, rangeId: bigint): Uint8Array =>
  key('range-end', endKey.length === 0 ? INFINITY : endKey, rangeId);
export const operatorKey = (id: bigint): Uint8Array => key('op', id);

export const nodePrefix = (): Uint8Array => rangeLocalPrefix(PD_RANGE_ID, 'pd-node');
export const rangePrefix = (): Uint8Array => rangeLocalPrefix(PD_RANGE_ID, 'pd-range');
export const rangeEndPrefix = (): Uint8Array => rangeLocalPrefix(PD_RANGE_ID, 'pd-range-end');
export const operatorPrefix = (): Uint8Array => rangeLocalPrefix(PD_RANGE_ID, 'pd-op');
