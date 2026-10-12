import { beforeEach, describe, expect, test } from 'vitest';
import { createKvRegistry } from '@mindlog/kv';
import { kvNode } from '../support/kv-node.js';

let node: Awaited<ReturnType<typeof kvNode>>;
beforeEach(async () => {
  node = await kvNode(createKvRegistry());
});

describe('JSON subset', () => {
  test('JSON.SET at the root and JSON.GET', async () => {
    expect(await node.run('JSON.SET', 'doc', '$', '{"a":1,"b":{"c":[1,2,3]}}')).toBe('OK');
    expect(await node.run('JSON.GET', 'doc')).toBe('{"a":1,"b":{"c":[1,2,3]}}');
    expect(await node.run('JSON.GET', 'doc', '$.b.c')).toBe('[[1,2,3]]');
    expect(await node.run('JSON.GET', 'doc', '.b.c[-1]')).toBe('3');
    expect(await node.run('JSON.GET', 'doc', "$['a']")).toBe('[1]');
    expect(await node.run('JSON.GET', 'doc', '$.missing')).toBe('[]');
    expect(await node.run('JSON.GET', 'doc', '.missing')).toBeNull();
    expect(await node.run('JSON.GET', 'doc', '$.a', '$.b.c[0]')).toBe('{"$.a":[1],"$.b.c[0]":[1]}');
    expect(await node.run('TYPE', 'doc')).toBe('ReJSON-RL');
  });

  test('JSON.SET below the root, NX / XX, and errors', async () => {
    expect(await node.run('JSON.SET', 'doc', '$.a', '1')).toEqual({
      error: 'INVALID_ARGUMENT new objects must be created at the root',
    });
    await node.run('JSON.SET', 'doc', '$', '{"a":1}');
    expect(await node.run('JSON.SET', 'doc', '$.b', '"x"')).toBe('OK');
    expect(await node.run('JSON.SET', 'doc', '$.b', '"y"', 'NX')).toBeNull();
    expect(await node.run('JSON.SET', 'doc', '$.c', '"y"', 'XX')).toBeNull();
    expect(await node.run('JSON.SET', 'doc', '$.x.y', '1')).toBeNull();
    expect(await node.run('JSON.GET', 'doc')).toBe('{"a":1,"b":"x"}');
    expect(await node.run('JSON.SET', 'doc', '$', '{bad')).toEqual({
      error: 'INVALID_ARGUMENT expected a valid JSON value',
    });
  });

  test('JSON.DEL a path or the whole key', async () => {
    await node.run('JSON.SET', 'doc', '$', '{"a":1,"list":[1,2,3]}');
    expect(await node.run('JSON.DEL', 'doc', '$.list[0]')).toBe(1);
    expect(await node.run('JSON.DEL', 'doc', '$.nope')).toBe(0);
    expect(await node.run('JSON.GET', 'doc')).toBe('{"a":1,"list":[2,3]}');
    expect(await node.run('JSON.DEL', 'doc')).toBe(1);
    expect(await node.run('EXISTS', 'doc')).toBe(0);
  });

  test('JSON.MGET across keys', async () => {
    await node.run('JSON.SET', 'a', '$', '{"n":1}');
    await node.run('JSON.SET', 'b', '$', '{"n":2}');
    await node.run('SET', 's', 'string');
    expect(await node.run('JSON.MGET', 'a', 'b', 'missing', 's', '$.n')).toEqual([
      '[1]',
      '[2]',
      null,
      null,
    ]);
  });

  test('JSON keys are a distinct type', async () => {
    await node.run('JSON.SET', 'doc', '$', '1');
    expect(await node.run('GET', 'doc')).toEqual({
      error: 'WRONG_TYPE Operation against a key holding the wrong kind of value',
    });
  });
});
