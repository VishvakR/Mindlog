import { parseArgs } from 'node:util';
import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';

export interface CliArgs {
  readonly singleNode: boolean;
  readonly configPath?: string | undefined;
  /** Config overrides from flags, shaped like `mindlog.yaml`. */
  readonly flags: Record<string, unknown>;
  readonly help: boolean;
  readonly version: boolean;
}

export const USAGE = `Usage: mindlog-server --single-node [options]
       mindlog-server superuser upsert <email> <password> [-c <path>] [--data-dir <path>]

Options:
  --single-node          Run one node with a local durable log (phase 1)
  -c, --config <path>    Config file (default: ./mindlog.yaml if present)
  -p, --port <port>      RESP port (listen.resp.port)
      --host <host>      RESP bind address (listen.resp.host)
      --http-port <port> HTTP API and dashboard port (listen.http.port)
      --data-dir <path>  Data directory (node.dataDir)
      --log-level <lvl>  trace | debug | info | warn | error | fatal
  -h, --help             Show this help
  -v, --version          Show the version

Environment variables MINDLOG_<SECTION>__<KEY> override the file; flags override both.`;

const invalid = (message: string): Result<never, MindlogError> =>
  err(mindlogError('INVALID_ARGUMENT', message));

/** Parses `mindlog-server` arguments into config overrides. */
export function parseCliArgs(argv: readonly string[]): Result<CliArgs, MindlogError> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        'single-node': { type: 'boolean', default: false },
        config: { type: 'string', short: 'c' },
        port: { type: 'string', short: 'p' },
        host: { type: 'string' },
        'http-port': { type: 'string' },
        'data-dir': { type: 'string' },
        'log-level': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    }));
  } catch (cause) {
    return invalid(cause instanceof Error ? cause.message : String(cause));
  }
  const resp: Record<string, unknown> = {};
  if (values.port !== undefined) {
    if (!/^\d+$/.test(values.port)) return invalid(`--port must be a number, got '${values.port}'`);
    resp.port = Number(values.port);
  }
  if (values.host !== undefined) resp.host = values.host;
  const listen: Record<string, unknown> = {};
  if (Object.keys(resp).length > 0) listen.resp = resp;
  const httpPort = values['http-port'];
  if (httpPort !== undefined) {
    if (!/^\d+$/.test(httpPort)) return invalid(`--http-port must be a number, got '${httpPort}'`);
    listen.http = { port: Number(httpPort) };
  }
  const flags: Record<string, unknown> = {};
  if (Object.keys(listen).length > 0) flags.listen = listen;
  if (values['data-dir'] !== undefined) flags.node = { dataDir: values['data-dir'] };
  if (values['log-level'] !== undefined) flags.observability = { logLevel: values['log-level'] };
  return ok({
    singleNode: values['single-node'],
    configPath: values.config,
    flags,
    help: values.help,
    version: values.version,
  });
}
