import { describe, expect, test } from 'vitest';
import { resolveConfig } from '../src/index.js';

const files: Record<string, string> = { '/run/pw': 'hunter2-long-password\n' };
const readSecret = (path: string): string => {
  const text = files[path];
  if (text === undefined) throw new Error('no such file');
  return text;
};

describe('secrets from files', () => {
  test('NAME_FILE reads the value and drops one trailing newline', () => {
    const r = resolveConfig({ env: { MINDLOG_AUTH__PASSWORD_FILE: '/run/pw' }, readSecret });
    expect(r.ok && r.value.auth.password).toBe('hunter2-long-password');
  });

  test('${file:/path} in the YAML file', () => {
    const r = resolveConfig({ fileText: 'auth:\n  password: ${file:/run/pw}\n', readSecret });
    expect(r.ok && r.value.auth.password).toBe('hunter2-long-password');
  });

  test('a missing file is a configuration error', () => {
    const r = resolveConfig({ env: { MINDLOG_AUTH__PASSWORD_FILE: '/nope' }, readSecret });
    expect(!r.ok && r.error.code).toBe('CONFIG_INVALID');
  });

  test('without a reader the suffix means nothing', () => {
    const r = resolveConfig({ env: { MINDLOG_AUTH__PASSWORD_FILE: '/run/pw' } });
    expect(r.ok).toBe(false);
  });
});
