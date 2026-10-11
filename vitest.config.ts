import { defineConfig } from 'vitest/config';

// Workspace packages resolve to their TypeScript sources through this export
// condition, so tests never need a prior build (ADR-0002).
const conditions = ['@mindlog/source', 'import', 'module', 'node', 'default'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: conditions } },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'test/lint-fixtures/**'],
    environment: 'node',
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/gen/**', '**/index.ts'],
      reporter: ['text-summary', 'html', 'lcov'],
      // PLAN 22.1: at least 85% line coverage on domain packages.
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 80 },
    },
  },
});
