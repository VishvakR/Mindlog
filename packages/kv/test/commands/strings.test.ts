import fc from 'fast-check';
import { beforeEach, describe, expect, test } from 'vitest';
import { createKvRegistry } from '@mindlog/kv';
import { kvNode } from '../support/kv-node.js';

const NOT_INT = { error: 'INVALID_ARGUMENT value is not an integer or out of range' };
const SYNTAX = { error: 'INVALID_ARGUMENT syntax error' };

let node: Awaited<ReturnType<typeof kvNode>>;
beforeEach(async () => {
  node = await kvNode(createKvRegistry());
});

describe('GET / SET (Valkey string.tcl)', () => {
  test('SET and GET an item', async () => {
    expect(await node.run('SET', 'x', 'foobar')).toBe('OK');
    expect(await node.run('GET', 'x')).toBe('foobar');
    expect(await node.run('GET', 'missing')).toBeNull();
  });

  test('SET NX and XX', async () => {
    expect(await node.run('SET', 'k', 'a', 'XX')).toBeNull();
    expect(await node.run('SET', 'k', 'a', 'NX')).toBe('OK');
    expect(await node.run('SET', 'k', 'b', 'NX')).toBeNull();
    expect(await node.run('SET', 'k', 'c', 'xx')).toBe('OK');
    expect(await node.run('GET', 'k')).toBe('c');
  });

  test('SET GET returns the old value, even when NX blocks the write', async () => {
    expect(await node.run('SET', 'k', 'a', 'GET')).toBeNull();
    expect(await node.run('SET', 'k', 'b', 'GET')).toBe('a');
    expect(await node.run('SET', 'k', 'c', 'NX', 'GET')).toBe('b');
    expect(await node.run('GET', 'k')).toBe('b');
  });

  test('SET IFEQ writes only over an equal string value (Valkey 8.1)', async () => {
    expect(await node.run('SET', 'k', 'a', 'IFEQ', 'x')).toBeNull();
    expect(await node.run('GET', 'k')).toBeNull();
    await node.run('SET', 'k', 'a');
    expect(await node.run('SET', 'k', 'b', 'IFEQ', 'x')).toBeNull();
    expect(await node.run('SET', 'k', 'b', 'IFEQ', 'a', 'GET')).toBe('a');
    expect(await node.run('GET', 'k')).toBe('b');
    expect(await node.run('SET', 'k', 'c', 'IFEQ', 'b', 'NX')).toEqual(SYNTAX);
    await node.run('RPUSH', 'l', 'x');
    expect(await node.run('SET', 'l', 'v', 'IFEQ', 'x')).toEqual({
      error: expect.stringMatching(/^WRONG_TYPE/) as unknown,
    });
  });

  test('SET option conflicts are syntax errors', async () => {
    expect(await node.run('SET', 'k', 'v', 'NX', 'XX')).toEqual(SYNTAX);
    expect(await node.run('SET', 'k', 'v', 'EX', '10', 'PX', '100')).toEqual(SYNTAX);
    expect(await node.run('SET', 'k', 'v', 'KEEPTTL', 'EX', '10')).toEqual(SYNTAX);
    expect(await node.run('SET', 'k', 'v', 'EX')).toEqual(SYNTAX);
    expect(await node.run('SET', 'k', 'v', 'BOGUS')).toEqual(SYNTAX);
  });

  test('SET with invalid expire times', async () => {
    expect(await node.run('SET', 'k', 'v', 'EX', '0')).toEqual({
      error: "INVALID_ARGUMENT invalid expire time in 'set' command",
    });
    expect(await node.run('SET', 'k', 'v', 'PX', 'abc')).toEqual(NOT_INT);
  });

  test('SET EX expires the key and SET clears a TTL unless KEEPTTL', async () => {
    await node.run('SET', 'k', 'v', 'EX', '10');
    node.clock.advance(9_999n);
    expect(await node.run('GET', 'k')).toBe('v');
    node.clock.advance(1_001n);
    expect(await node.run('GET', 'k')).toBeNull();

    await node.run('SET', 'k', 'v', 'PX', '100');
    await node.run('SET', 'k', 'w', 'KEEPTTL');
    node.clock.advance(101n);
    expect(await node.run('GET', 'k')).toBeNull();

    await node.run('SET', 'k', 'v', 'PX', '100');
    await node.run('SET', 'k', 'w');
    node.clock.advance(101n);
    expect(await node.run('GET', 'k')).toBe('w');
  });

  test('SETNX against expired volatile key', async () => {
    await node.run('SET', 'x', '10', 'PX', '50');
    node.clock.advance(51n);
    expect(await node.run('SETNX', 'x', '20')).toBe(1);
    expect(await node.run('GET', 'x')).toBe('20');
  });

  test('SETEX / PSETEX set a value with a TTL', async () => {
    expect(await node.run('SETEX', 'k', '1', 'v')).toBe('OK');
    expect(await node.run('PSETEX', 'p', '1000', 'v')).toBe('OK');
    node.clock.advance(1_001n);
    expect(await node.run('GET', 'k')).toBeNull();
    expect(await node.run('GET', 'p')).toBeNull();
    expect(await node.run('SETEX', 'k', '-1', 'v')).toEqual({
      error: "INVALID_ARGUMENT invalid expire time in 'setex' command",
    });
  });

  test('GETDEL and GETEX', async () => {
    await node.run('SET', 'k', 'v');
    expect(await node.run('GETDEL', 'k')).toBe('v');
    expect(await node.run('GET', 'k')).toBeNull();
    await node.run('SET', 'k', 'v');
    expect(await node.run('GETEX', 'k', 'PX', '10')).toBe('v');
    expect(await node.run('GETEX', 'k', 'PERSIST')).toBe('v');
    node.clock.advance(20n);
    expect(await node.run('GET', 'k')).toBe('v');
    expect(await node.run('GETEX', 'k', 'EX')).toEqual(SYNTAX);
  });

  test('MGET returns nil for missing and non-string keys; MSET and MSETNX', async () => {
    expect(await node.run('MSET', 'a', '1', 'b', '2')).toBe('OK');
    expect(await node.run('MGET', 'a', 'b', 'c')).toEqual(['1', '2', null]);
    expect(await node.run('MSET', 'a', '1', 'b')).toEqual({
      error: "INVALID_ARGUMENT wrong number of arguments for 'mset' command",
    });
    expect(await node.run('MSETNX', 'c', '3', 'a', 'x')).toBe(0);
    expect(await node.run('GET', 'c')).toBeNull();
    expect(await node.run('MSETNX', 'c', '3', 'd', '4')).toBe(1);
  });
});

describe('INCR family (Valkey incr.tcl)', () => {
  test('INCR against nonexistent key', async () => {
    expect(await node.run('INCR', 'novar')).toBe(1);
    expect(await node.run('GET', 'novar')).toBe('1');
  });

  test('DECR against key is not exist and incr', async () => {
    expect(await node.run('DECR', 'n')).toBe(-1);
    expect(await node.run('INCR', 'n')).toBe(0);
  });

  test('INCR over 32bit value and INCRBY over 32bit increment', async () => {
    await node.run('SET', 'novar', '17179869184');
    expect(await node.run('INCR', 'novar')).toBe(17_179_869_185);
    expect(await node.run('INCRBY', 'novar', '17179869184')).toBe(34_359_738_369);
  });

  test('INCR fails against key with spaces and non-integers', async () => {
    for (const bad of ['    11', '11    ', ' 11 ', '1.5', 'x']) {
      await node.run('SET', 'novar', bad);
      expect(await node.run('INCR', 'novar')).toEqual(NOT_INT);
    }
  });

  test('INCR fails on overflow and keeps the value', async () => {
    await node.run('SET', 'n', '9223372036854775807');
    expect(await node.run('INCR', 'n')).toEqual({
      error: 'INVALID_ARGUMENT increment or decrement would overflow',
    });
    expect(await node.run('GET', 'n')).toBe('9223372036854775807');
    expect(await node.run('DECRBY', 'n', '-9223372036854775808')).toEqual({
      error: 'INVALID_ARGUMENT decrement would overflow',
    });
  });

  test('INCR keeps the TTL', async () => {
    await node.run('SET', 'n', '1', 'PX', '100');
    await node.run('INCR', 'n');
    node.clock.advance(101n);
    expect(await node.run('GET', 'n')).toBeNull();
  });

  test('INCRBYFLOAT', async () => {
    await node.run('SET', 'f', '10.5');
    expect(await node.run('INCRBYFLOAT', 'f', '0.1')).toBe('10.6');
    expect(await node.run('INCRBYFLOAT', 'f', '-10.6')).toBe('0');
    expect(await node.run('INCRBYFLOAT', 'f', 'x')).toEqual({
      error: 'INVALID_ARGUMENT value is not a valid float',
    });
    expect(await node.run('INCRBYFLOAT', 'f', '+inf')).toEqual({
      error: 'INVALID_ARGUMENT increment would produce NaN or Infinity',
    });
  });
});

describe('APPEND / STRLEN / GETRANGE / SETRANGE', () => {
  test('APPEND basics', async () => {
    expect(await node.run('APPEND', 'k', 'foo')).toBe(3);
    expect(await node.run('APPEND', 'k', 'bar')).toBe(6);
    expect(await node.run('GET', 'k')).toBe('foobar');
    expect(await node.run('STRLEN', 'k')).toBe(6);
    expect(await node.run('STRLEN', 'missing')).toBe(0);
  });

  test('GETRANGE against string value with negative indexes', async () => {
    await node.run('SET', 'k', 'Hello World');
    expect(await node.run('GETRANGE', 'k', '0', '3')).toBe('Hell');
    expect(await node.run('GETRANGE', 'k', '0', '-1')).toBe('Hello World');
    expect(await node.run('GETRANGE', 'k', '-4', '-1')).toBe('orld');
    expect(await node.run('GETRANGE', 'k', '5', '3')).toBe('');
    expect(await node.run('GETRANGE', 'k', '5', '5000')).toBe(' World');
    expect(await node.run('GETRANGE', 'k', '-5000', '10000')).toBe('Hello World');
    expect(await node.run('GETRANGE', 'k', '-1', '-5')).toBe('');
    expect(await node.run('GETRANGE', 'missing', '0', '-1')).toBe('');
  });

  test('SETRANGE pads with zero bytes and validates the offset', async () => {
    expect(await node.run('SETRANGE', 'k', '0', '')).toBe(0);
    expect(await node.run('GET', 'k')).toBeNull();
    expect(await node.run('SETRANGE', 'k', '1', 'b')).toBe(2);
    expect(await node.run('GET', 'k')).toBe('\u0000b');
    await node.run('SET', 'k', 'foo');
    expect(await node.run('SETRANGE', 'k', '1', 'bar')).toBe(4);
    expect(await node.run('GET', 'k')).toBe('fbar');
    expect(await node.run('SETRANGE', 'k', '-1', 'x')).toEqual({
      error: 'INVALID_ARGUMENT offset is out of range',
    });
  });
});

describe('strings against a model', () => {
  test('random SET / APPEND / INCRBY / GETDEL sequences match a Map', async () => {
    const op = fc.oneof(
      fc.tuple(
        fc.constant('SET'),
        fc.constantFrom('a', 'b'),
        fc.oneof(fc.integer({ min: -9, max: 9 }).map(String), fc.constantFrom('x', '')),
      ),
      fc.tuple(fc.constant('APPEND'), fc.constantFrom('a', 'b'), fc.constantFrom('1', 'z')),
      fc.tuple(
        fc.constant('INCRBY'),
        fc.constantFrom('a', 'b'),
        fc.integer({ min: -5, max: 5 }).map(String),
      ),
      fc.tuple(fc.constant('GETDEL'), fc.constantFrom('a', 'b'), fc.constant('')),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 15 }), async (ops) => {
        const n = await kvNode(createKvRegistry());
        const model = new Map<string, string>();
        for (const [verb, key, arg] of ops) {
          const before = model.get(key);
          if (verb === 'SET') model.set(key, arg);
          else if (verb === 'APPEND') model.set(key, (before ?? '') + arg);
          else if (verb === 'GETDEL') model.delete(key);
          else if (/^-?(0|[1-9][0-9]*)$/.test(before ?? '0') && before !== '-0') {
            model.set(key, String(Number(before ?? '0') + Number(arg)));
          }
          await (verb === 'GETDEL' ? n.run(verb, key) : n.run(verb, key, arg));
          expect(await n.run('GET', key)).toBe(model.get(key) ?? null);
        }
      }),
      { numRuns: 60 },
    );
  }, 60_000);
});
