import { describe, expect, test } from 'vitest';
import { resolveConfig } from '@mindlog/core';
import { parseCliArgs } from '@mindlog/server';

describe('parseCliArgs', () => {
  test('no arguments', () => {
    const args = parseCliArgs([]);
    expect(args.ok && args.value).toEqual({
      singleNode: false,
      configPath: undefined,
      flags: {},
      help: false,
      version: false,
    });
  });

  test('flags become config overrides', () => {
    const args = parseCliArgs([
      '--single-node',
      '-c',
      'x.yaml',
      '-p',
      '7000',
      '--host',
      '127.0.0.1',
      '--data-dir',
      '/tmp/d',
      '--log-level',
      'debug',
    ]);
    expect(args.ok && args.value.singleNode).toBe(true);
    expect(args.ok && args.value.configPath).toBe('x.yaml');
    expect(args.ok && args.value.flags).toEqual({
      listen: { resp: { port: 7000, host: '127.0.0.1' } },
      node: { dataDir: '/tmp/d' },
      observability: { logLevel: 'debug' },
    });
    const config = args.ok ? resolveConfig({ flags: args.value.flags }) : undefined;
    expect(config?.ok && config.value.listen.resp).toEqual({
      host: '127.0.0.1',
      port: 7000,
      tls: false,
    });
  });

  test('help and version', () => {
    const args = parseCliArgs(['-h', '--version']);
    expect(args.ok && [args.value.help, args.value.version]).toEqual([true, true]);
  });

  test('unknown flags, positionals and bad ports are INVALID_ARGUMENT', () => {
    for (const argv of [['--nope'], ['extra'], ['--port', 'abc'], ['--port']]) {
      const args = parseCliArgs(argv);
      expect(args.ok, argv.join(' ')).toBe(false);
      if (!args.ok) expect(args.error.code).toBe('INVALID_ARGUMENT');
    }
  });
});
