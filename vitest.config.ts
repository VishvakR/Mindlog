import { defineConfig } from 'vitest/config';

// Workspace packages resolve to their TypeScript sources through this export
// condition, so tests never need a prior build (ADR-0002).
// Externals (node_modules) keep Node's own resolution: bundler-only conditions
// such as `module` can select builds that Node cannot load.
const conditions = ['@mindlog/source', 'import', 'node', 'default'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/dist-test/**', 'test/lint-fixtures/**'],
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
