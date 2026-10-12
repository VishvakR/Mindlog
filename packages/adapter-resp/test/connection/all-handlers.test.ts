import { describe, expect, test } from 'vitest';
import { createConnectionCommands, loadCommandSpecs } from '@mindlog/adapter-resp';
import { allKvCommands } from '@mindlog/kv';

/** Session commands KvService handles (services/src/kv/kv-service.ts). */
const SESSION_COMMANDS = ['AUTH', 'MULTI', 'EXEC', 'DISCARD', 'WATCH', 'UNWATCH'];

describe('command coverage', () => {
  test('every spec has exactly one implementation, and every command has a spec', () => {
    const specs = [...loadCommandSpecs().keys()].sort();
    const owners = [
      ...allKvCommands().map((c) => c.name),
      ...createConnectionCommands().names(),
      ...SESSION_COMMANDS,
    ];
    expect(new Set(owners).size).toBe(owners.length);
    expect([...owners].sort()).toEqual(specs);
  });

  test('registering a command twice is a programmer error', () => {
    const registry = createConnectionCommands();
    expect(() => {
      registry.register({ name: 'hello', execute: () => ({}) as never });
    }).toThrow(/HELLO registered twice/);
  });
});
