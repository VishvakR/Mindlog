import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const created: string[] = [];

/** A fresh directory under the OS temp dir, removed after the test file. */
export function tempDir(prefix = 'mindlog-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});
