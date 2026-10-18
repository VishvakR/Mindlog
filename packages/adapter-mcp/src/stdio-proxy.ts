import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Transport } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

/**
 * Relays JSON-RPC messages both ways between a local transport (a host's
 * stdio) and the node's Streamable HTTP endpoint. Resolves to a stop function.
 */
export async function proxyMessages(
  local: Transport,
  remote: Transport,
): Promise<() => Promise<void>> {
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await Promise.allSettled([local.close(), remote.close()]);
  };
  local.onmessage = (message) => {
    remote.send(message).catch((cause: unknown) => {
      process.stderr.write(
        `mindlog mcp: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
    });
  };
  remote.onmessage = (message) => {
    void local.send(message);
  };
  local.onclose = () => void close();
  remote.onerror = (error) => {
    process.stderr.write(`mindlog mcp: ${error.message}\n`);
  };
  await remote.start();
  await local.start();
  return close;
}

/**
 * `mindlog-server mcp --stdio`: lets a local agent host (Claude Desktop) that
 * spawns MCP servers use a running node, so several hosts share one data
 * directory. Logs go to stderr; stdout is the protocol channel.
 */
export async function runStdioProxy(options: {
  url: string;
  apiKey: string;
}): Promise<() => Promise<void>> {
  const remote = new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: { headers: { authorization: `Bearer ${options.apiKey}` } },
  });
  return proxyMessages(new StdioServerTransport(), remote);
}
