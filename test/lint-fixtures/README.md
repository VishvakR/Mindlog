# Lint fixtures

Deliberately broken code. `test/architecture/boundaries.test.ts` lints these files with the repository's ESLint config and asserts that every architecture rule fires (ADR-0002). They are excluded from `pnpm lint`, the build and test discovery.
