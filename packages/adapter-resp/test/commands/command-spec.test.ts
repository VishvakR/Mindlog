import { describe, expect, test } from 'vitest';
import type { CommandArgument } from '@mindlog/adapter-resp';
import { loadCommandSpecs } from '@mindlog/adapter-resp';
import { allKvCommands } from '@mindlog/kv';

const specs = loadCommandSpecs();

describe('command specs', () => {
  const kvFlags = ['write', 'readonly', 'denyoom', 'fast'];

  test.each(allKvCommands().map((c) => [c.name, c] as const))(
    '%s matches the kv registry (arity, flags, keys)',
    (name, command) => {
      const spec = specs.get(name);
      expect(spec, `missing spec for ${name}`).toBeDefined();
      expect(spec?.arity).toBe(command.arity);
      const specFlags = spec?.command_flags
        .map((f) => f.toLowerCase())
        .filter((f) => kvFlags.includes(f));
      expect(new Set(specFlags)).toEqual(new Set(command.flags));
      expect(spec?.key_range).toEqual(command.keys);
    },
  );

  test('every key argument command declares a key range', () => {
    const hasKeyArg = (args: readonly CommandArgument[] = []): boolean =>
      args.some((a) => a.type === 'key' || hasKeyArg(a.arguments));
    for (const [name, spec] of specs) {
      expect(hasKeyArg(spec.arguments) === (spec.key_range !== undefined), name).toBe(true);
    }
  });
});

describe('loadCommandSpecs', () => {
  test('rejects invalid specs', () => {
    const dir = new URL('./fixtures/bad-specs/', import.meta.url);
    expect(() => loadCommandSpecs(dir)).toThrow(/invalid command spec bad.json/);
  });
});

describe('compatibility doc', () => {
  test('docs/api/resp-compatibility.md lists every command', async () => {
    const { readFile } = await import('node:fs/promises');
    const doc = await readFile(
      new URL('../../../../docs/api/resp-compatibility.md', import.meta.url),
      'utf8',
    );
    const missing: string[] = [];
    for (const [name, spec] of specs) {
      const subcommands = Object.keys(spec.subcommands ?? {});
      const forms = subcommands.length > 0 ? subcommands.map((s) => `${name} ${s}`) : [name];
      for (const form of forms) if (!doc.includes(`\`${form}\``)) missing.push(form);
    }
    expect(missing).toEqual([]);
  });
});
