import { create, toBinary } from '@bufbuild/protobuf';
import type { MindlogError, Result } from '@mindlog/core';
import {
  HybridLogicalClock,
  ManualClock,
  MemoryLogger,
  MemoryMetrics,
  SeededRandom,
  UlidGenerator,
  err,
  mindlogError,
  ok,
} from '@mindlog/core';
import { replies } from '@mindlog/kv';
import type { Command, KvReply } from '@mindlog/proto';
import { AuditRecordSchema, CommandResultSchema } from '@mindlog/proto';
import type { Proposal } from '@mindlog/statemachine';
import { CommandStamper, auditKey } from '@mindlog/statemachine';
import { MemoryStore, MvccWriter } from '@mindlog/storage';
import { expect, test } from 'vitest';
import type { Placement, RangeCall, RangeRouter, RangeTarget } from '../src/index.js';
import { AUDIT_CLUSTER_VERSION, AuditService } from '../src/index.js';

const DAY_MS = 86_400_000n;
const NOW = 1_760_000_000_000n;

/** One range that applies audit commands into a store, as the real handlers would. */
function auditRange(fail?: () => MindlogError | undefined) {
  const store = new MemoryStore();
  const commands: Command[] = [];
  let version = 1n;
  const target: RangeTarget = {
    rangeId: 1n,
    proposer: {
      async propose(command): Promise<Result<Proposal, MindlogError>> {
        commands.push(command);
        const refused = fail?.();
        if (refused) return err(refused);
        if (command.body.case === 'auditAppend') {
          const b = store.batch();
          const w = new MvccWriter(b, version++);
          for (const r of command.body.value.records)
            w.put(auditKey(r.tenant, r.atMs, r.id), toBinary(AuditRecordSchema, r));
          await b.write();
        }
        return ok({ index: version, result: create(CommandResultSchema, {}) });
      },
    },
    readBarrier: { read: () => Promise.resolve(ok(undefined)) },
    reader: store,
    state: store,
    descriptor: () => ({}) as ReturnType<RangeTarget['descriptor']>,
    owns: () => true,
    covers: () => true,
  };
  return { target, commands, of: (c: string) => commands.filter((x) => x.body.case === c) };
}

interface Options {
  readonly local?: boolean;
  readonly forward?: (call: RangeCall) => Promise<Result<KvReply, MindlogError>>;
  readonly locate?: () => Result<Placement, MindlogError> | undefined;
  readonly version?: number;
  readonly retention?: Array<{ name: string; days: number }>;
}

function service(range: ReturnType<typeof auditRange>, o: Options = {}) {
  const clock = new ManualClock(NOW);
  const local = o.local ?? true;
  const router = {
    locate: () =>
      Promise.resolve(
        o.locate?.() ?? ok(local ? { rangeId: 1n, local: range.target } : { rangeId: 1n }),
      ),
    forward: (_p: Placement, _c: unknown, call: RangeCall) =>
      o.forward ? o.forward(call) : Promise.resolve(err(mindlogError('UNAVAILABLE', 'no peer'))),
    local: (id: bigint) => (local && id === 1n ? range.target : undefined),
    refresh: (p: Placement) => Promise.resolve(ok(p)),
  } as unknown as RangeRouter;
  const random = new SeededRandom(7n);
  let n = 0;
  const metrics = new MemoryMetrics();
  const audit = new AuditService({
    router,
    stamper: new CommandStamper(
      new HybridLogicalClock(clock, { maxOffsetMs: 500n }),
      new UlidGenerator(clock, random),
    ),
    clock,
    logger: new MemoryLogger(),
    metrics,
    leaders: () => [],
    clusterVersion: () => o.version ?? AUDIT_CLUSTER_VERSION,
    ids: () => `id${String(++n).padStart(4, '0')}`,
    retention: () => Promise.resolve(o.retention ?? []),
  });
  return { audit, clock, metrics };
}

const event = (tenant: string, action = 'POST /x', ok = true) => ({
  tenant,
  principal: 'apikey:k',
  action,
  resource: `tenant:${tenant}`,
  ok,
});

test('queued events wait for the cluster version, then land per tenant and day', async () => {
  const range = auditRange();
  const old = service(range, { version: AUDIT_CLUSTER_VERSION - 1 });
  old.audit.record(event('acme'));
  await old.audit.tick();
  expect(range.commands).toHaveLength(0);

  const { audit, clock } = service(range);
  audit.record(event('acme', 'a1'));
  audit.record(event('globex', 'g1'));
  clock.advance(DAY_MS);
  audit.record(event('acme', 'a2', false));
  await audit.tick();
  // acme today, globex today, acme tomorrow: three groups, three appends.
  expect(range.of('auditAppend')).toHaveLength(3);

  const page = await audit.read('acme', { limit: 10, retentionDays: 30 });
  expect(page.ok && page.value.items.map((e) => e.action)).toEqual(['a2', 'a1']);
  expect(page.ok && page.value.items[0]?.ok).toBe(false);
});

test('reads page newest first, through days, with a cursor', async () => {
  const range = auditRange();
  const { audit, clock } = service(range);
  for (let i = 0; i < 5; i++) {
    audit.record(event('acme', `e${String(i)}`));
    clock.advance(DAY_MS / 2n);
  }
  await audit.tick();
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 10; pages++) {
    const page = await audit.read('acme', {
      limit: 2,
      retentionDays: 30,
      ...(cursor ? { cursor } : {}),
    });
    if (!page.ok) throw new Error(page.error.message);
    seen.push(...page.value.items.map((e) => e.action));
    cursor = page.value.cursor;
    if (!cursor) break;
  }
  expect(seen).toEqual(['e4', 'e3', 'e2', 'e1', 'e0']);
  // Retention bounds how far back a read walks.
  const recent = await audit.read('acme', { limit: 10, retentionDays: 0 });
  expect(recent.ok && recent.value.items.length).toBeLessThan(5);
});

test('a failed append keeps the events for the next tick', async () => {
  let down = true;
  const range = auditRange(() => (down ? mindlogError('UNAVAILABLE', 'no quorum') : undefined));
  const { audit } = service(range);
  audit.record(event('acme'));
  await audit.tick();
  expect((await audit.read('acme', { limit: 5, retentionDays: 30 })).ok).toBe(true);
  down = false;
  await audit.tick();
  const page = await audit.read('acme', { limit: 5, retentionDays: 30 });
  expect(page.ok && page.value.items).toHaveLength(1);
});

test('a range led elsewhere is written and read through a forwarded call', async () => {
  const range = auditRange();
  const holder = service(range).audit;
  const calls: string[] = [];
  const { audit } = service(range, {
    local: false,
    forward: async (call) => {
      calls.push(call.kind === 'memory' ? call.op : call.kind);
      return ok(await holder.forwarded(1n, call));
    },
  });
  audit.record(event('acme', 'remote'));
  await audit.tick();
  const page = await audit.read('acme', { limit: 5, retentionDays: 30 });
  expect(page.ok && page.value.items.map((e) => e.action)).toEqual(['remote']);
  expect(calls).toEqual(['audit.append', 'audit.read', ...calls.slice(2)]);
});

test('forwarded replies that are errors or of the wrong shape fail the read', async () => {
  const range = auditRange();
  const failing = service(range, {
    local: false,
    forward: () => Promise.resolve(ok(replies.error('UNAVAILABLE', 'peer down'))),
  });
  expect((await failing.audit.read('acme', { limit: 1, retentionDays: 1 })).ok).toBe(false);
  const odd = service(range, { local: false, forward: () => Promise.resolve(ok(replies.ok())) });
  const r = await odd.audit.read('acme', { limit: 1, retentionDays: 1 });
  expect(r.ok ? '' : r.error.code).toBe('INTERNAL');
  const unreachable = service(range, { local: false });
  unreachable.audit.record(event('acme'));
  await unreachable.audit.tick();
  expect(range.of('auditAppend')).toHaveLength(0);
});

test('a moved range is looked up again before giving up', async () => {
  const range = auditRange();
  let lookups = 0;
  const { audit } = service(range, {
    locate: () => (++lookups === 1 ? err(mindlogError('NOT_LEADER', 'moved')) : undefined),
  });
  audit.record(event('acme'));
  await audit.tick();
  expect(lookups).toBe(2);
  expect(range.of('auditAppend')).toHaveLength(1);
});

test('the forwarded entry point checks what it is asked', async () => {
  const range = auditRange();
  const { audit } = service(range);
  const kv = await audit.forwarded(1n, { kind: 'kv', argv: [] } as unknown as RangeCall);
  expect(kv.kind.case).toBe('error');
  const missing = await audit.forwarded(9n, { kind: 'memory', op: 'audit.read', json: '{}' });
  expect(missing.kind.case === 'error' && missing.kind.value.code).toBe('RANGE_MOVED');
  const unknown = await audit.forwarded(1n, { kind: 'memory', op: 'audit.nope', json: '{}' });
  expect(unknown.kind.case === 'error' && unknown.kind.value.message).toContain('audit.nope');
  const down = service(auditRange(() => mindlogError('UNAVAILABLE', 'x'))).audit;
  const append = await down.forwarded(1n, {
    kind: 'memory',
    op: 'audit.append',
    json: JSON.stringify({ records: [] }),
  });
  expect(append.kind.case).toBe('error');
});

test('expiry runs hourly for each tenant, on ranges this node leads', async () => {
  const range = auditRange();
  const { audit, clock } = service(range, { retention: [{ name: 'acme', days: 30 }] });
  await audit.tick();
  const first = range.of('auditExpire').length;
  expect(first).toBe(7);
  await audit.tick();
  expect(range.of('auditExpire')).toHaveLength(first);
  clock.advance(3_600_000n);
  await audit.tick();
  expect(range.of('auditExpire')).toHaveLength(2 * first);

  const remote = auditRange();
  await service(remote, { local: false, retention: [{ name: 'acme', days: 30 }] }).audit.tick();
  expect(remote.of('auditExpire')).toHaveLength(0);
  // Not retryable, so each day is tried once and the failure only logged.
  const failing = auditRange(() => mindlogError('INTERNAL', 'x'));
  await service(failing, { retention: [{ name: 'acme', days: 1 }] }).audit.tick();
  expect(failing.of('auditExpire')).toHaveLength(7);
});

test('the queue is bounded: the overflow is counted, not kept', () => {
  const { audit, metrics } = service(auditRange());
  for (let i = 0; i < 10_050; i++) audit.record(event('acme'));
  expect(metrics.value('mindlog_audit_dropped_total')).toBe(50);
});
