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
        '--mcp-port',
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
      [
        '--single-node',
        '--port',
        '0',
        '--http-port',
        '0',
        '--mcp-port',
        '0',
        '--data-dir',
        dataDir,
      ],
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

describe('main apikey and mcp', () => {
  test('apikey create, list and revoke work offline on the data directory', async () => {
    const run = await io();
    const dataDir = join(run.cwd, 'data');
    expect(
      await main(
        [
          'apikey',
          'create',
          '--tenant',
          'acme',
          '--user',
          'alice',
          '--name',
          'desktop',
          '--data-dir',
          dataDir,
        ],
        run.value,
      ),
    ).toEqual({ kind: 'exit', code: EXIT.ok });
    const key = /mlk_[A-Za-z0-9_-]+/.exec(run.out())?.[0];
    const id = /id (\w+)/.exec(run.out())?.[1];
    expect(key).toBeDefined();
    expect(id).toBeDefined();
    const list = await io();
    expect(await main(['apikey', 'list', '--data-dir', dataDir], list.value)).toEqual({
      kind: 'exit',
      code: EXIT.ok,
    });
    expect(list.out()).toContain(`${id ?? ''}  acme  alice  desktop`);
    expect(list.out()).not.toContain(key ?? 'x');
    const revoke = await io();
    expect(await main(['apikey', 'revoke', id ?? '', '--data-dir', dataDir], revoke.value)).toEqual(
      {
        kind: 'exit',
        code: EXIT.ok,
      },
    );
    const again = await io();
    expect(await main(['apikey', 'revoke', id ?? '', '--data-dir', dataDir], again.value)).toEqual({
      kind: 'exit',
      code: EXIT.failure,
    });
  });

  test('apikey and mcp usage errors', async () => {
    const usage = await io();
    expect(await main(['apikey', 'create', '--name', 'x'], usage.value)).toEqual({
      kind: 'exit',
      code: EXIT.usage,
    });
    expect(usage.err()).toContain('apikey create');
    const mcp = await io();
    expect(await main(['mcp'], mcp.value)).toEqual({ kind: 'exit', code: EXIT.usage });
    expect(mcp.err()).toContain('--api-key');
  });
});

describe('main keys', () => {
  const keyOf = (byte: number) => Buffer.alloc(32, byte).toString('base64');
  const masterEnv = (key: string) => ({ MINDLOG_STORAGE__ENCRYPTION__MASTER_KEY: key });
  const apikey = (dataDir: string) => ['apikey', 'list', '--data-dir', dataDir];

  test('rotate-master re-wraps the data keys, and only the new key opens the directory', async () => {
    const setup = await io(masterEnv(keyOf(1)));
    const dataDir = join(setup.cwd, 'data');
    const create = ['apikey', 'create', '--tenant', 'acme', '--name', 'k', '--data-dir', dataDir];
    expect(await main(create, setup.value)).toEqual({ kind: 'exit', code: EXIT.ok });
    const newKey = join(setup.cwd, 'new.key');
    await writeFile(newKey, `${keyOf(2)}\n`);

    const rotate = await io(masterEnv(keyOf(1)));
    const args = ['keys', 'rotate-master', '--new-key-file', newKey, '--data-dir', dataDir];
    expect(await main(args, rotate.value)).toEqual({ kind: 'exit', code: EXIT.ok });
    expect(rotate.out()).toMatch(/state: re-wrapped \d+ data keys/);

    const fresh = await io(masterEnv(keyOf(2)));
    expect(await main(apikey(dataDir), fresh.value)).toEqual({ kind: 'exit', code: EXIT.ok });
    expect(fresh.out()).toContain('acme');
    const stale = await io(masterEnv(keyOf(1)));
    expect(await main(apikey(dataDir), stale.value)).not.toEqual({ kind: 'exit', code: EXIT.ok });
  });

  test('usage errors: no subcommand, no key file, no encryption, or a short key', async () => {
    const run = async (args: string[], env: Record<string, string> = {}) => {
      const r = await io(env);
      return { result: await main(['keys', ...args], r.value), err: r.err() };
    };
    const usage = { kind: 'exit', code: EXIT.usage };
    expect((await run([])).result).toEqual(usage);
    expect((await run(['rotate-master'])).result).toEqual(usage);
    expect((await run(['--bogus'])).result).toEqual(usage);
    const dir = await tempDir();
    const short = join(dir, 'short.key');
    await writeFile(short, Buffer.alloc(8).toString('base64'));
    const off = await run(['rotate-master', '--new-key-file', short, '--data-dir', dir]);
    expect(off.result).toEqual(usage);
    expect(off.err).toContain('Encryption must be on');
    const bad = await run(['rotate-master', '--new-key-file', short, '--data-dir', dir], {
      MINDLOG_STORAGE__ENCRYPTION__MASTER_KEY: 'too-short',
    });
    expect(bad.result).toEqual({ kind: 'exit', code: EXIT.config });
  });
});
