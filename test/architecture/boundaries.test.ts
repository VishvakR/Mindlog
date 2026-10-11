/**
 * Phase 0 exit gate (PLAN 24): the architecture rules actually block illegal
 * code (ADR-0002). Lints the fixtures in test/lint-fixtures with the real
 * ESLint config and checks which rules fire where.
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fixture = (path: string) => `test/lint-fixtures/packages/${path}`;

interface LintResult {
  readonly filePath: string;
  readonly messages: readonly { readonly ruleId: string | null; readonly message: string }[];
}

let rulesByFile = new Map<string, string[]>();

/** Runs the real ESLint CLI (as CI does) over the fixtures; exit code 1 means "found problems". */
async function lintFixtures(): Promise<LintResult[]> {
  const eslintPkg = createRequire(import.meta.url).resolve('eslint/package.json');
  const eslintBin = join(dirname(eslintPkg), 'bin', 'eslint.js');
  const args = [eslintBin, '--no-ignore', '--format', 'json', fixture('**/*.ts')];
  try {
    const { stdout } = await promisify(execFile)(process.execPath, args, {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(stdout) as LintResult[];
  } catch (error: unknown) {
    const stdout = (error as { stdout?: string }).stdout;
    if (stdout === undefined || stdout === '') throw error;
    return JSON.parse(stdout) as LintResult[];
  }
}

beforeAll(async () => {
  const results = await lintFixtures();
  rulesByFile = new Map(
    results.map((r) => [
      r.filePath.slice(root.length),
      r.messages.map((m) => m.ruleId ?? `fatal: ${m.message}`),
    ]),
  );
}, 120_000);

function rules(path: string): string[] {
  const found = rulesByFile.get(fixture(path));
  if (!found) expect.fail(`fixture ${path} was not linted`);
  return found;
}

describe('architecture rules (phase 0 gate)', () => {
  test('a lower layer cannot import a higher layer', () => {
    expect(rules('core/src/index.ts')).toContain('boundaries/dependencies');
  });

  test('importing downward is allowed by the layer rule', () => {
    expect(rules('storage/src/index.ts')).not.toContain('boundaries/dependencies');
  });

  test('relative paths into another package are blocked', () => {
    expect(rules('core/src/index.ts')).toContain('no-restricted-imports');
    expect(rules('storage/src/index.ts')).toContain('no-restricted-imports');
  });

  test('deep imports past a package entry are blocked', () => {
    expect(rules('memory/src/deep-import.ts')).toContain('no-restricted-imports');
  });

  test('default exports are blocked', () => {
    expect(rules('memory/src/default-export.ts')).toContain('no-restricted-syntax');
  });

  test('wall-clock time and randomness are blocked in apply code', () => {
    const found = rules('statemachine/src/apply/apply-put.ts');
    expect(found.filter((r) => r === 'no-restricted-properties')).toHaveLength(2);
    expect(found).toContain('no-restricted-syntax');
  });

  test('legal code produces no errors', () => {
    expect(rules('memory/src/legal.ts')).toEqual([]);
    expect(rules('memory/src/local.ts')).toEqual([]);
  });
});
