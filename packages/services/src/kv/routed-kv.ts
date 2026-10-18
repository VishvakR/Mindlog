import type { Clock, MindlogError, Result } from '@mindlog/core';
import { MindlogErrorCode, err, mindlogError, ok } from '@mindlog/core';
import type { KvCommandRegistry } from '@mindlog/kv';
import {
  KvReadExecutor,
  decodeCursor,
  encodeCursor,
  isWrite,
  replies,
  watchVersion,
} from '@mindlog/kv';
import type { KvReply } from '@mindlog/proto';
import type { CommandStamper } from '@mindlog/statemachine';
import { MvccReader } from '@mindlog/storage';
import type { Caller, Placement, RangeCall, RangeRouter, RangeTarget } from './range-router.js';

const CODES = new Set<string>(Object.values(MindlogErrorCode));
const knownCode = (code: string): MindlogErrorCode =>
  CODES.has(code) ? (code as MindlogErrorCode) : 'INTERNAL';

const decoder = new TextDecoder();
const nameOf = (argv: readonly Uint8Array[]): string =>
  argv[0] ? decoder.decode(argv[0]).toUpperCase() : '';

/** Commands whose keys may be spread over ranges: each range runs its part (not atomic across ranges). */
const FAN_OUT = new Set(['MGET', 'EXISTS', 'TOUCH', 'DEL', 'UNLINK']);
/** Keyless reads that cover the whole keyspace. */
const SCATTER = new Set(['DBSIZE', 'KEYS', 'SCAN']);

const asError = (e: MindlogError): KvReply => replies.error(e.code, e.message);

export interface RoutedKvDeps {
  readonly registry: KvCommandRegistry;
  readonly router: RangeRouter;
  readonly stamper: CommandStamper;
  readonly clock: Clock;
}

/**
 * The request path when there are many ranges (ADR-0029): finds each command's
 * range, runs it on the local replica or forwards it, fans out the commands that
 * allow it, scatters the ones that cover the keyspace, and refuses the rest
 * when their keys are in different ranges.
 */
export class RoutedKv {
  readonly #d: RoutedKvDeps;

  constructor(deps: RoutedKvDeps) {
    this.#d = deps;
  }

  /** A single data command (not MULTI/EXEC/WATCH). */
  async command(caller: Caller, argv: readonly Uint8Array[]): Promise<KvReply> {
    const name = nameOf(argv);
    const command = argv[0] ? this.#d.registry.get(argv[0]) : undefined;
    if (command) {
      const arityOk =
        command.arity >= 0 ? argv.length === command.arity : argv.length >= -command.arity;
      if (!arityOk) return replies.errors.arity(command.name);
    }
    if (SCATTER.has(name)) return this.#scatter(caller, name, argv);
    const keys = this.#d.registry.keysOf(argv);
    if (keys.length === 0) {
      const target = this.#d.router.any();
      return target
        ? this.runLocal(target, caller, { kind: 'command', argv })
        : replies.error('UNAVAILABLE', 'this node holds no range yet');
    }
    const placed = await this.#d.router.place(caller.tenant, keys);
    if (!placed.ok) return asError(placed.error);
    const ranges = new Set(placed.value.map((p) => p.rangeId));
    if (ranges.size === 1) {
      const only = placed.value[0] as Placement;
      return this.#on(only, caller, { kind: 'command', argv });
    }
    if (FAN_OUT.has(name)) return this.#fanOut(caller, name, argv, keys, placed.value);
    return replies.error('CROSS_RANGE', "Keys in request don't hash to the same slot");
  }

  /** EXEC: one batch on the single range that holds every key (and watched key). */
  async batch(
    caller: Caller,
    writes: ReadonlyArray<readonly Uint8Array[]>,
    watches: ReadonlyArray<{ readonly key: Uint8Array; readonly version: bigint }>,
  ): Promise<KvReply> {
    const keys = [
      ...watches.map((w) => w.key),
      ...writes.flatMap((argv) => this.#d.registry.keysOf(argv)),
    ];
    if (keys.length === 0) {
      const target = this.#d.router.any();
      return target
        ? this.runLocal(target, caller, { kind: 'batch', writes, watches })
        : replies.error('UNAVAILABLE', 'this node holds no range yet');
    }
    const placed = await this.#d.router.place(caller.tenant, keys);
    if (!placed.ok) return asError(placed.error);
    if (new Set(placed.value.map((p) => p.rangeId)).size > 1)
      return replies.error('CROSS_RANGE', "Keys in request don't hash to the same slot");
    return this.#on(placed.value[0] as Placement, caller, { kind: 'batch', writes, watches });
  }

  /** The MVCC versions WATCH records, one per key, read behind a linearizable barrier. */
  async versions(
    caller: Caller,
    keys: readonly Uint8Array[],
  ): Promise<Result<bigint[], MindlogError>> {
    const placed = await this.#d.router.place(caller.tenant, keys);
    if (!placed.ok) return placed;
    const out: bigint[] = [];
    for (const [i, placement] of placed.value.entries()) {
      const key = keys[i] as Uint8Array;
      const reply = await this.#on(placement, caller, { kind: 'watch', keys: [key] });
      const item = reply.kind.case === 'array' ? reply.kind.value.items[0] : undefined;
      if (reply.kind.case === 'error')
        return err(mindlogError(knownCode(reply.kind.value.code), reply.kind.value.message));
      out.push(item?.kind.case === 'integer' ? item.kind.value : 0n);
    }
    return ok(out);
  }

  /** Executes a call that another node forwarded here for `rangeId`. */
  async forwarded(rangeId: bigint, caller: Caller, call: RangeCall): Promise<KvReply> {
    const target = this.#d.router.local(rangeId);
    if (!target)
      return replies.error('RANGE_MOVED', `this node holds no replica of range ${rangeId}`);
    return this.runLocal(target, caller, call);
  }

  /** Runs a call on this node's replica of the range. */
  async runLocal(target: RangeTarget, caller: Caller, call: RangeCall): Promise<KvReply> {
    if (call.kind === 'watch') {
      const ready = await target.readBarrier.read('linearizable');
      if (!ready.ok) return asError(ready.error);
      const reader = new MvccReader(target.reader);
      const versions = await Promise.all(
        call.keys.map((key) => watchVersion(reader, caller.tenant, key)),
      );
      return replies.array(versions.map((v) => replies.integer(v)));
    }
    if (call.kind === 'batch')
      return this.#propose(target, caller, {
        case: 'kvBatch',
        value: {
          writes: call.writes.map((argv) => ({ argv: [...argv] })),
          watches: [...call.watches],
        },
      });
    const command = call.argv[0] ? this.#d.registry.get(call.argv[0]) : undefined;
    const reads = new KvReadExecutor(this.#d.registry, target.reader);
    if (!command) return reads.execute(caller.tenant, call.argv, this.#d.clock.now());
    if (!isWrite(command)) {
      const ready = await target.readBarrier.read('lease');
      if (!ready.ok) return asError(ready.error);
      return reads.execute(caller.tenant, call.argv, this.#d.clock.now());
    }
    return this.#propose(target, caller, { case: 'kvWrite', value: { argv: [...call.argv] } });
  }

  async #on(placement: Placement, caller: Caller, call: RangeCall): Promise<KvReply> {
    if (placement.local) return this.runLocal(placement.local, caller, call);
    const reply = await this.#d.router.forward(placement, caller, call);
    return reply.ok ? reply.value : asError(reply.error);
  }

  async #propose(
    target: RangeTarget,
    caller: Caller,
    body: Parameters<CommandStamper['stamp']>[2],
  ): Promise<KvReply> {
    const command = this.#d.stamper.stamp(caller.tenant, caller.principal, body);
    const proposal = await target.proposer.propose(command);
    if (!proposal.ok) return asError(proposal.error);
    const outcome = proposal.value.result.outcome;
    if (outcome.case === 'kv') return outcome.value;
    if (outcome.case === 'error')
      return replies.error(knownCode(outcome.value.code), outcome.value.message);
    return replies.error('INTERNAL', 'empty command result');
  }

  /** MGET and the counting commands: each range runs its keys; results go back in input order. */
  async #fanOut(
    caller: Caller,
    name: string,
    argv: readonly Uint8Array[],
    keys: readonly Uint8Array[],
    placed: readonly Placement[],
  ): Promise<KvReply> {
    const groups = new Map<bigint, { placement: Placement; indexes: number[] }>();
    for (const [i, p] of placed.entries()) {
      const group = groups.get(p.rangeId) ?? { placement: p, indexes: [] };
      group.indexes.push(i);
      groups.set(p.rangeId, group);
    }
    const results = await Promise.all(
      [...groups.values()].map(async (g) => ({
        g,
        reply: await this.#on(g.placement, caller, {
          kind: 'command',
          argv: [argv[0] as Uint8Array, ...g.indexes.map((i) => keys[i] as Uint8Array)],
        }),
      })),
    );
    for (const { reply } of results) if (reply.kind.case === 'error') return reply;
    if (name === 'MGET') {
      const merged: KvReply[] = new Array<KvReply>(keys.length);
      for (const { g, reply } of results) {
        const items = reply.kind.case === 'array' ? reply.kind.value.items : [];
        g.indexes.forEach((original, j) => {
          merged[original] = items[j] ?? replies.nil();
        });
      }
      return replies.array(merged);
    }
    let total = 0n;
    for (const { reply } of results) if (reply.kind.case === 'integer') total += reply.kind.value;
    return replies.integer(total);
  }

  /** DBSIZE, KEYS and SCAN over every range in key order. */
  async #scatter(caller: Caller, name: string, argv: readonly Uint8Array[]): Promise<KvReply> {
    const all = await this.#d.router.ranges();
    if (!all.ok) return asError(all.error);
    const each = (p: Placement) => this.#on(p, caller, { kind: 'command', argv });
    if (name === 'DBSIZE') {
      let total = 0n;
      for (const reply of await Promise.all(all.value.map(each))) {
        if (reply.kind.case === 'error') return reply;
        if (reply.kind.case === 'integer') total += reply.kind.value;
      }
      return replies.integer(total);
    }
    if (name === 'KEYS') {
      const found: KvReply[] = [];
      for (const reply of await Promise.all(all.value.map(each))) {
        if (reply.kind.case === 'error') return reply;
        if (reply.kind.case === 'array') found.push(...reply.kind.value.items);
      }
      return replies.array(found);
    }
    return this.#scan(caller, argv, all.value);
  }

  /**
   * SCAN across ranges: the cursor is still the last key returned, which any range
   * can resume from, so it survives splits. Ranges run in key order from the one
   * holding the cursor until COUNT keys are found or the keyspace ends.
   */
  async #scan(
    caller: Caller,
    argv: readonly Uint8Array[],
    all: readonly Placement[],
  ): Promise<KvReply> {
    const options = argv.slice(2);
    const countAt = options.findIndex((o) => decoder.decode(o).toUpperCase() === 'COUNT');
    const count =
      countAt >= 0 ? Number(decoder.decode(options[countAt + 1] ?? new Uint8Array())) || 10 : 10;
    let cursor = argv[1] as Uint8Array;
    const after = decodeCursor(cursor);
    if (after === undefined) return replies.error('INVALID_ARGUMENT', 'invalid cursor');
    let first = 0;
    if (after !== null) {
      const where = await this.#d.router.place(caller.tenant, [after]);
      if (!where.ok) return asError(where.error);
      first = Math.max(
        0,
        all.findIndex((p) => p.rangeId === where.value[0]?.rangeId),
      );
    }
    const found: KvReply[] = [];
    let last: Uint8Array | undefined;
    for (let i = first; i < all.length; i++) {
      if (found.length >= count) {
        // Enough keys: resume after the last one, which any range can do.
        return this.#page(last ? encodeCursor(last) : '0', found);
      }
      const reply = await this.#on(all[i] as Placement, caller, {
        kind: 'command',
        argv: [argv[0] as Uint8Array, cursor, ...options],
      });
      if (reply.kind.case === 'error') return reply;
      const [next, keys] = reply.kind.case === 'array' ? reply.kind.value.items : [];
      const batch = keys?.kind.case === 'array' ? keys.kind.value.items : [];
      found.push(...batch);
      const lastBulk = batch.at(-1);
      if (lastBulk?.kind.case === 'bulk') last = lastBulk.kind.value;
      const label = next?.kind.case === 'bulk' ? decoder.decode(next.kind.value) : '0';
      // The range stopped inside itself at COUNT keys: hand its cursor back.
      if (label !== '0') return this.#page(label, found);
      cursor = new TextEncoder().encode('0');
    }
    return this.#page('0', found);
  }

  #page(cursor: string, found: KvReply[]): KvReply {
    return replies.array([replies.bulk(new TextEncoder().encode(cursor)), replies.array(found)]);
  }
}
