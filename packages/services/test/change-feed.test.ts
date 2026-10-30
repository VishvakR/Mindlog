import { create } from '@bufbuild/protobuf';
import { MemoryLogger, MemoryMetrics } from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import type { Command, CommandResult } from '@mindlog/proto';
import { CommandResultSchema, CommandSchema } from '@mindlog/proto';
import { describe, expect, test } from 'vitest';
import type { ChangeEvent, Resync } from '@mindlog/services';
import { ChangeFeed } from '@mindlog/services';

const HLC = 1_760_000_000_000n << 16n;
const ok = (ids: string[]): CommandResult =>
  create(CommandResultSchema, { outcome: { case: 'memory', value: { ids, count: ids.length } } });

function setup(tailSize = 10) {
  const bus = new InMemoryEventBus({ logger: new MemoryLogger(), metrics: new MemoryMetrics() });
  const feed = new ChangeFeed({ tailSize });
  feed.attach(bus);
  let index = 0n;
  const apply = (body: Command['body'], result: CommandResult, extra: { branch?: string } = {}) => {
    bus.publish({
      type: 'CommandApplied',
      rangeId: 1n,
      index: ++index,
      command: create(CommandSchema, { tenant: 't', principal: 'p', hlc: HLC, body, ...extra }),
      result,
      duplicate: false,
    });
  };
  const forget = (user: string, id: string) => {
    apply({ case: 'memoryForget', value: { user, ids: [id] } } as Command['body'], ok([id]));
  };
  return { bus, feed, apply, forget };
}

const collect = () => {
  const got: Array<ChangeEvent | Resync> = [];
  return { got, listener: (e: ChangeEvent | Resync) => got.push(e) };
};

describe('ChangeFeed (PLAN 13.5)', () => {
  test('maps commands to events and delivers only the subscribed scope', () => {
    const f = setup();
    const c = collect();
    f.feed.subscribe({ tenant: 't', user: 'alice' }, undefined, c.listener);
    f.apply(
      {
        case: 'memoryCommit',
        value: {
          user: 'alice',
          conflicts: [{ id: 'c1', a: 'm0', b: 'm1', status: 'open' }],
        },
      } as Command['body'],
      ok(['m1']),
    );
    f.forget('bob', 'x');
    f.apply(
      { case: 'branchCreate', value: { user: 'alice', name: 'plan' } } as Command['body'],
      ok([]),
    );
    f.forget('alice', 'm1');
    expect(c.got.map((e) => [e.type, 'ids' in e ? e.ids : []])).toEqual([
      ['memory.added', ['m1']],
      ['conflict.raised', ['c1']],
      ['branch.created', ['plan']],
      ['memory.forgotten', ['m1']],
    ]);
    expect(c.got[0]).toMatchObject({ cursor: '1:1', tenant: 't', user: 'alice', principal: 'p' });
  });

  test('failed and repeated commands produce nothing; branch writes are marked', () => {
    const f = setup();
    const c = collect();
    f.feed.subscribe({ tenant: 't', user: 'alice' }, undefined, c.listener);
    f.apply(
      { case: 'memoryForget', value: { user: 'alice', ids: ['m'] } } as Command['body'],
      create(CommandResultSchema, { outcome: { case: 'error', value: { code: 'NOT_FOUND' } } }),
    );
    f.apply(
      { case: 'memoryForget', value: { user: 'alice', ids: ['m'] } } as Command['body'],
      ok(['m']),
      {
        branch: 'plan',
      },
    );
    expect(c.got).toMatchObject([{ type: 'memory.forgotten', branch: 'plan' }]);
  });

  test('resumes after a held cursor and asks for a resync past the tail', () => {
    const f = setup(2);
    for (const id of ['a', 'b', 'c']) f.forget('alice', id);
    const resumed = collect();
    f.feed.subscribe({ tenant: 't', user: 'alice' }, '1:2', resumed.listener);
    expect(resumed.got.map((e) => ('ids' in e ? e.ids[0] : e.type))).toEqual(['c']);
    const old = collect();
    f.feed.subscribe({ tenant: 't', user: 'alice' }, '1:0', old.listener);
    expect(old.got).toEqual([{ type: 'resync' }]);
    const unknown = collect();
    f.feed.subscribe({ tenant: 't', user: 'alice' }, '7:3', unknown.listener);
    expect(unknown.got).toEqual([{ type: 'resync' }]);
    f.forget('alice', 'd');
    expect(old.got).toHaveLength(2);
  });
});
