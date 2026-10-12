import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { MemoryLogger, MemoryMetrics } from '@mindlog/core';
import type { MainIo } from '@mindlog/server';
import { EXIT, main, mindlogVersion } from '@mindlog/server';
import { respClient } from './support/resp-client.js';
import { tempDir } from './support/temp-dir.js';

async function io(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const cwd = await tempDir();
  const value: MainIo = {
    cwd,
    env,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    node: { logger: new MemoryLogger(), metrics: new MemoryMetrics() },
  };
  return { value, cwd, out: () => out.join(''), err: () => err.join('') };
}

describe('main', () => {
  test('--help and --version print and exit 0', async () => {
    const help = await io();
    expect(await main(['--help'], help.value)).toEqual({ kind: 'exit', code: EXIT.ok });
    expect(help.out()).toContain('Usage: mindlog-server --single-node');
    const version = await io();
    expect(await main(['-v'], version.value)).toEqual({ kind: 'exit', code: EXIT.ok });
    expect(version.out()).toBe(`mindlog-server ${mindlogVersion()}\n`);
  });

  test('bad arguments and missing --single-node are usage errors', async () => {
    const bad = await io();
    expect(await main(['--bogus'], bad.value)).toEqual({ kind: 'exit', code: EXIT.usage });
    expect(bad.err()).toContain('Usage:');
    const cluster = await io();
    expect(await main([], cluster.value)).toEqual({ kind: 'exit', code: EXIT.usage });
    expect(cluster.err()).toContain('--single-node');
  });

  test('invalid configuration exits 78 and names the field', async () => {
    const run = await io();
    await writeFile(join(run.cwd, 'mindlog.yaml'), 'limits:\n  maxClients: 0\n');
    expect(await main(['--single-node'], run.value)).toEqual({ kind: 'exit', code: EXIT.config });
    expect(run.err()).toContain('limits.maxClients');
  });

  test('--single-node starts a node from flags', async () => {
    const run = await io();
    const result = await main(
      ['--single-node', '--host', '127.0.0.1', '--port', '0', '--data-dir', join(run.cwd, 'data')],
      run.value,
    );
    expect(result.kind).toBe('running');
    if (result.kind !== 'running') return;
    const client = await respClient(result.node.resp.port);
    expect(await client.call('PING')).toBe('+PONG\r\n');
    await client.close();
    await result.node.close();
  });
});
