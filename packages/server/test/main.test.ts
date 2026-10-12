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
      [
        '--single-node',
        '--host',
        '127.0.0.1',
        '--port',
        '0',
        '--http-port',
        '0',
        '--data-dir',
        join(run.cwd, 'data'),
      ],
      run.value,
    );
    expect(result.kind).toBe('running');
    if (result.kind !== 'running') return;
    const client = await respClient(result.node.resp.port);
    expect(await client.call('PING')).toBe('+PONG\r\n');
    await client.close();
    await result.node.close();
  });

  test('superuser upsert creates a superuser the started node accepts', async () => {
    const run = await io();
    const dataDir = join(run.cwd, 'data');
    const created = await main(
      ['superuser', 'upsert', 'Admin@Example.com', 'long enough password', '--data-dir', dataDir],
      run.value,
    );
    expect(created).toEqual({ kind: 'exit', code: EXIT.ok });
    expect(run.out()).toBe('Superuser admin@example.com saved.\n');
    const result = await main(
      ['--single-node', '--port', '0', '--http-port', '0', '--data-dir', dataDir],
      run.value,
    );
    if (result.kind !== 'running') throw new Error('not running');
    try {
      const login = await fetch(
        `http://127.0.0.1:${String(result.node.http.port)}/api/superusers/auth-with-password`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'admin@example.com', password: 'long enough password' }),
        },
      );
      expect(login.status).toBe(200);
      // The running node holds the data directory: the command explains why it cannot open it.
      const locked = await io();
      expect(
        await main(
          ['superuser', 'upsert', 'b@example.com', 'long enough password', '--data-dir', dataDir],
          locked.value,
        ),
      ).toEqual({ kind: 'exit', code: EXIT.failure });
      expect(locked.err()).toContain('Stop it first');
    } finally {
      await result.node.close();
    }
  });

  test('superuser usage and weak passwords are usage errors', async () => {
    const usage = await io();
    expect(await main(['superuser', 'delete', 'a@b.co'], usage.value)).toEqual({
      kind: 'exit',
      code: EXIT.usage,
    });
    expect(usage.err()).toContain('superuser upsert');
    const weak = await io();
    expect(
      await main(
        ['superuser', 'upsert', 'a@b.co', 'short', '--data-dir', join(weak.cwd, 'd')],
        weak.value,
      ),
    ).toEqual({ kind: 'exit', code: EXIT.usage });
    expect(weak.err()).toContain('password');
  });
});
