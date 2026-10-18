#!/usr/bin/env node
import { main } from './cli/main.js';

const result = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});

if (result.kind === 'exit') {
  process.exitCode = result.code;
} else if (result.kind === 'proxying') {
  // The stdio proxy keeps the process alive until the host closes stdin.
} else {
  const { node } = result;
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    node.logger.info('shutting down', { signal });
    node.close().then(
      () => process.exit(0),
      (cause: unknown) => {
        node.logger.fatal('shutdown failed', { cause });
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  // Fail-stop (CLAUDE.md §4 rule 6): never keep serving after an unexpected error.
  process.on('uncaughtException', (cause) => {
    node.logger.fatal('uncaught exception', { cause });
    process.exit(1);
  });
  process.on('unhandledRejection', (cause) => {
    node.logger.fatal('unhandled rejection', { cause });
    process.exit(1);
  });
}
