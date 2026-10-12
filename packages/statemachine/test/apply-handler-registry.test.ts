import { create } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { CommandResultSchema } from '@mindlog/proto';
import type { ApplyHandler } from '@mindlog/statemachine';
import { ApplyHandlerRegistry } from '@mindlog/statemachine';

const handler = (body: ApplyHandler['body']): ApplyHandler => ({
  body,
  apply: () => Promise.resolve(create(CommandResultSchema)),
});

describe('ApplyHandlerRegistry', () => {
  test('finds handlers by body kind', () => {
    const registry = new ApplyHandlerRegistry();
    const kv = handler('kvWrite');
    registry.register(kv);
    registry.register(handler('expire'));
    expect(registry.get('kvWrite')).toBe(kv);
    expect(registry.get('kvBatch')).toBeUndefined();
    expect(registry.list().sort()).toEqual(['expire', 'kvWrite']);
  });

  test('refuses a second handler for the same body', () => {
    const registry = new ApplyHandlerRegistry();
    registry.register(handler('kvWrite'));
    expect(() => {
      registry.register(handler('kvWrite'));
    }).toThrow(/already registered/);
  });
});
