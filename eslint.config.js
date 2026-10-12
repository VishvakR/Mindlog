// @ts-check
import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Layers from CLAUDE.md §3.1 / PLAN 4.1, top to bottom. A package may import its own
// layer or any layer below it. `**/` also matches test/lint-fixtures/packages/*.
const LAYERS = [
  ['composition', ['server']],
  ['interfaces', ['adapter-resp', 'adapter-mcp', 'adapter-http', 'adapter-grpc']],
  ['application', ['auth', 'router', 'services']],
  [
    'domain',
    [
      'memory',
      'consolidation',
      'branching',
      'cache',
      'collections',
      'rules',
      'txn',
      'kv',
      'jobs',
      'models-client',
    ],
  ],
  ['replication', ['raft', 'multiraft', 'statemachine', 'transport', 'pd']],
  ['storage', ['storage', 'blob', 'index-vector', 'index-text', 'index-graph', 'index-secondary']],
  ['core', ['core', 'proto', 'eventbus']],
];

const layerElements = LAYERS.map(([type, pkgs]) => ({
  type,
  pattern: `**/packages/{${pkgs.join(',')}}`,
}));

const layerPolicies = LAYERS.map(([type], i) => ({
  from: { element: { type } },
  allow: { to: { element: { types: { anyOf: LAYERS.slice(i).map(([t]) => t) } } } },
}));

// Wall-clock and ambient randomness break deterministic apply (CLAUDE.md §4 rule 1).
const NONDETERMINISM = 'is non-deterministic; use cmd.hlc or a seed derived from the log index.';

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/dist-test/**',
      '**/coverage/**',
      '**/gen/**',
      'references/**',
      'python/**',
      // Linted by its own oxlint config (pnpm --filter @mindlog/web lint).
      'web/**',
      'packages/server/dashboard/**',
      // Deliberately broken; linted only by test/architecture/boundaries.test.ts.
      'test/lint-fixtures/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // allowNumber also covers bigint.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Use named exports; default exports are not allowed (CLAUDE.md §10).',
        },
      ],
    },
  },
  {
    files: ['**/packages/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': layerElements,
      'import/resolver': {
        typescript: { conditionNames: ['@mindlog/source', 'types', 'import', 'default'] },
      },
    },
    rules: {
      'boundaries/dependencies': ['error', { default: 'disallow', policies: layerPolicies }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@mindlog/*/*'],
              message:
                'Import other modules only through their public entry `@mindlog/<pkg>` (CLAUDE.md §3.1).',
            },
            {
              regex: String.raw`^(\.\./)+(\.\./)?packages/|^(\.\./){2,}[^/]+/src/`,
              message:
                'Do not reach into another package with a relative path; import `@mindlog/<pkg>`.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/statemachine/**/*.ts', '**/apply/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: `Date.now ${NONDETERMINISM}` },
        { object: 'Math', property: 'random', message: `Math.random ${NONDETERMINISM}` },
        { object: 'performance', property: 'now', message: `performance.now ${NONDETERMINISM}` },
        {
          object: 'crypto',
          property: 'randomUUID',
          message: `crypto.randomUUID ${NONDETERMINISM}`,
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Use named exports; default exports are not allowed (CLAUDE.md §10).',
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: `new Date() ${NONDETERMINISM}`,
        },
      ],
    },
  },
  {
    // Tool config files must default-export their configuration.
    files: ['*.config.ts', '*.config.js'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
);
