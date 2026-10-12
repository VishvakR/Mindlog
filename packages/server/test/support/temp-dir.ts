import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A fresh directory removed after the test. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mindlog-server-'));
  dirs.push(dir);
  return dir;
}
