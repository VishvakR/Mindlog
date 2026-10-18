import { parseArgs } from 'node:util';
import { runStdioProxy } from '@mindlog/adapter-mcp';
import type { MainIo, MainResult } from './io.js';
import { EXIT } from './io.js';

export const MCP_USAGE = `Usage: mindlog-server mcp --api-key <key> [--url <url>]

Serves MCP over stdio for a local agent host (Claude Desktop, ...) by relaying to a running
node's Streamable HTTP endpoint, so several hosts share one node. Logs go to stderr.

Options:
      --api-key <key>  API key (or MINDLOG_API_KEY); see \`mindlog-server apikey create\`
      --url <url>      MCP endpoint (default http://127.0.0.1:8765/mcp, or MINDLOG_MCP_URL)`;

const DEFAULT_URL = 'http://127.0.0.1:8765/mcp';

/** `mindlog-server mcp`: the stdio proxy (PLAN 15.2). Runs until stdin closes. */
export async function mcpCommand(argv: readonly string[], io: MainIo): Promise<MainResult> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      options: { 'api-key': { type: 'string' }, url: { type: 'string' } },
    }));
  } catch (cause) {
    io.stderr(
      `mindlog-server: ${cause instanceof Error ? cause.message : String(cause)}\n\n${MCP_USAGE}\n`,
    );
    return { kind: 'exit', code: EXIT.usage };
  }
  const apiKey = values['api-key'] ?? io.env.MINDLOG_API_KEY;
  if (!apiKey) {
    io.stderr(`mindlog-server: --api-key is required\n\n${MCP_USAGE}\n`);
    return { kind: 'exit', code: EXIT.usage };
  }
  const url = values.url ?? io.env.MINDLOG_MCP_URL ?? DEFAULT_URL;
  try {
    await runStdioProxy({ url, apiKey });
  } catch (cause) {
    io.stderr(
      `mindlog-server: cannot reach ${url}: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    return { kind: 'exit', code: EXIT.failure };
  }
  io.stderr(`mindlog mcp: relaying stdio to ${url}\n`);
  return { kind: 'proxying' };
}
