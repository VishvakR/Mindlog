import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadConfig } from '@mindlog/server';
import { tempDir } from './support/temp-dir.js';

describe('loadConfig', () => {
  test('defaults when there is no mindlog.yaml', async () => {
    const result = await loadConfig({ cwd: await tempDir(), env: {} });
    expect(result.ok && result.value.listen.resp.port).toBe(6379);
  });

  test('mindlog.yaml in cwd, then env, then flags', async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, 'mindlog.yaml'),
      'node:\n  id: from-file\nlisten:\n  resp:\n    port: 7001\n',
    );
    const result = await loadConfig({
      cwd,
      env: { MINDLOG_NODE__ID: 'from-env' },
      flags: { listen: { resp: { port: 7002 } } },
    });
    expect(result.ok && [result.value.node.id, result.value.listen.resp.port]).toEqual([
      'from-env',
      7002,
    ]);
  });

  test('an explicit --config path must exist', async () => {
    const cwd = await tempDir();
    const result = await loadConfig({ cwd, env: {}, configPath: 'missing.yaml' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CONFIG_INVALID');
      expect(result.error.message).toContain('missing.yaml');
    }
  });

  test('an invalid file is CONFIG_INVALID with the field', async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, 'custom.yaml'), 'limits:\n  maxClients: 0\n');
    const result = await loadConfig({ cwd, env: {}, configPath: 'custom.yaml' });
    expect(!result.ok && Object.keys(result.error.fields ?? {})).toEqual(['limits.maxClients']);
  });
});
