import { loadConfig } from '../bootstrap/load-config.js';
import { isSingleNode } from '../bootstrap/open-node-core.js';
import { mindlogVersion } from '../bootstrap/server-info.js';
import { startNode } from '../bootstrap/start-node.js';
import { USAGE, parseCliArgs } from './args.js';
import type { MainIo, MainResult } from './io.js';
import { EXIT, formatError } from './io.js';
import { superuserCommand } from './superuser.js';

const exit = (code: number): MainResult => ({ kind: 'exit', code });

/** `mindlog-server [options]` starts the node; `mindlog-server superuser ...` manages superusers. */
export async function main(argv: readonly string[], io: MainIo): Promise<MainResult> {
  if (argv[0] === 'superuser') return superuserCommand(argv.slice(1), io);
  const args = parseCliArgs(argv);
  if (!args.ok) {
    io.stderr(`${formatError(args.error)}\n${USAGE}\n`);
    return exit(EXIT.usage);
  }
  if (args.value.help) {
    io.stdout(`${USAGE}\n`);
    return exit(EXIT.ok);
  }
  if (args.value.version) {
    io.stdout(`mindlog-server ${mindlogVersion()}\n`);
    return exit(EXIT.ok);
  }
  const config = await loadConfig({
    cwd: io.cwd,
    env: io.env,
    configPath: args.value.configPath,
    flags: args.value.flags,
  });
  if (!config.ok) {
    io.stderr(formatError(config.error));
    return exit(EXIT.config);
  }
  // --single-node ignores any configured peers; otherwise a cluster needs them.
  if (args.value.singleNode)
    config.value.cluster = { ...config.value.cluster, peers: [], join: false };
  else if (isSingleNode(config.value)) {
    io.stderr(
      'mindlog-server: set cluster.peers (or cluster.join) in the config, or run with --single-node\n',
    );
    return exit(EXIT.usage);
  }
  const node = await startNode(config.value, io.node);
  if (!node.ok) {
    io.stderr(formatError(node.error));
    return exit(EXIT.failure);
  }
  return { kind: 'running', node: node.value };
}
