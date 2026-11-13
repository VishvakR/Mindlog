import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { MemoryLogger, MemoryMetrics } from '@mindlog/core';
import { ConfStateSchema, RangeDescriptorSchema, SnapshotMetaSchema } from '@mindlog/proto';
import type { KeyValue } from '@mindlog/proto';
import type { MainIo } from '@mindlog/server';
import { EXIT, main } from '@mindlog/server';
import { confStateKey, rangeDescriptorKey, rangeLocalKey, soleVoter } from '@mindlog/statemachine';
import { checkCoverage } from '../src/bootstrap/restore-backup.js';
import { respClient } from './support/resp-client.js';
import { tempDir } from './support/temp-dir.js';

const NODE = [
  '--single-node',
  '--host',
  '127.0.0.1',
  '--port',
  '0',
  '--http-port',
  '0',
  '--mcp-port',
  '0',
];

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const value: MainIo = {
    cwd,
    env: {},
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    node: { logger: new MemoryLogger(), metrics: new MemoryMetrics() },
  };
  return { value, out: () => out.join(''), err: () => err.join('') };
}

const pair = (key: Uint8Array, value: Uint8Array): KeyValue => ({
  $typeName: 'mindlog.v1.KeyValue',
  key,
  value,
});
const descriptor = (rangeId: bigint, start: string, end: string) =>
  pair(
    rangeDescriptorKey(rangeId),
    toBinary(
      RangeDescriptorSchema,
      create(RangeDescriptorSchema, {
        rangeId,
        startKey: Buffer.from(start),
        endKey: Buffer.from(end),
      }),
    ),
  );
const range = (rangeId: bigint, start: string, end: string) =>
  [
    rangeId,
    { meta: create(SnapshotMetaSchema, {}), pairs: [descriptor(rangeId, start, end)] },
  ] as const;

describe('backups (ADR-0041)', () => {
  test('soleVoter makes the node the only voter and drops removed-replica records', () => {
    const conf = pair(
      confStateKey(5n),
      toBinary(ConfStateSchema, create(ConfStateSchema, { voters: [1n, 2n, 3n], learners: [4n] })),
    );
    const removed = pair(rangeLocalKey(5n, 'removed', 9n), new Uint8Array());
    const out = soleVoter(5n, 7n, [conf, removed, descriptor(5n, '', '')]);
    expect(out).toHaveLength(2);
    const state = fromBinary(ConfStateSchema, out[0]?.value ?? new Uint8Array());
    expect(state.voters).toEqual([7n]);
    expect(state.learners).toEqual([]);
  });

  test('a backup must tile the keyspace and hold the placement driver', () => {
    const pd = range(0n, '\u0000', '\u0001');
    expect(checkCoverage(new Map([pd, range(1n, '', 'm'), range(2n, 'm', '')])).ok).toBe(true);
    expect(checkCoverage(new Map([range(1n, '', '')])).ok).toBe(false);
    expect(checkCoverage(new Map([pd, range(1n, '', 'm'), range(2n, 'n', '')])).ok).toBe(false);
    expect(checkCoverage(new Map([pd, range(1n, '', 'm')])).ok).toBe(false);
  });

  test('backup, verify, restore into a new directory, and read the keys back', async () => {
    const cwd = await tempDir();
    const source = join(cwd, 'a');
    await writeFile(join(cwd, 'mindlog.yaml'), `node:\n  dataDir: ${JSON.stringify(source)}\n`);

    const a = await main(NODE, io(cwd).value);
    if (a.kind !== 'running') throw new Error('node A did not start');
    const client = await respClient(a.node.resp.port);
    for (let i = 0; i < 20; i++) expect(await client.call('SET', `k${i}`, `v${i}`)).toBe('+OK\r\n');
    await client.close();
    const backup = await a.node.backupNow('test1');
    await a.node.close();
    expect(backup.ok && backup.value.ranges).toContain('0');
    expect(backup.ok && backup.value.ranges).toContain('1');

    const verify = io(cwd);
    expect(await main(['backup', 'verify', 'test1'], verify.value)).toEqual({
      kind: 'exit',
      code: EXIT.ok,
    });
    expect(verify.out()).toMatch(/ranges restore cleanly/);
    // Without the config file, --from names the backed-up node's data directory.
    const elsewhere = io(await tempDir());
    const fromArgs = ['backup', 'verify', 'test1', '--from', source];
    expect(await main(fromArgs, elsewhere.value)).toEqual({ kind: 'exit', code: EXIT.ok });

    const target = join(cwd, 'b');
    const restore = io(cwd);
    const args = ['backup', 'restore', 'test1', '--data-dir', target];
    expect(await main(args, restore.value)).toEqual({ kind: 'exit', code: EXIT.ok });
    expect(await readdir(target)).toContain('pd');
    const again = io(cwd);
    expect(await main(args, again.value)).toEqual({ kind: 'exit', code: EXIT.usage });
    expect(again.err()).toContain('not empty');

    const b = await main([...NODE, '--data-dir', target], io(cwd).value);
    if (b.kind !== 'running') throw new Error('restored node B did not start');
    const read = await respClient(b.node.resp.port);
    for (let i = 0; i < 20; i++)
      expect(await read.call('GET', `k${i}`)).toBe(`$${String(`v${i}`.length)}\r\nv${i}\r\n`);
    expect(await read.call('SET', 'after', 'restore')).toBe('+OK\r\n');
    await read.close();
    await b.node.close();
  });

  test('verify of a missing backup fails; bad arguments are usage errors', async () => {
    const cwd = await tempDir();
    const missing = io(cwd);
    expect(await main(['backup', 'verify', 'nope'], missing.value)).toEqual({
      kind: 'exit',
      code: EXIT.failure,
    });
    expect(await main(['backup', 'restore', 'x'], io(cwd).value)).toEqual({
      kind: 'exit',
      code: EXIT.usage,
    });
    expect(await main(['backup'], io(cwd).value)).toEqual({ kind: 'exit', code: EXIT.usage });
  });
});
