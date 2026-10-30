/**
 * @mindlog/adapter-mcp — agents remember and recall over MCP (PLAN 15.2):
 * Streamable HTTP with API keys, and a stdio proxy for local hosts.
 */
export type { McpMemory } from './tool-kit.js';
export { buildMcpServer } from './memory-tools.js';
export type { KeyVerifier, McpHttpServerOptions } from './mcp-http-server.js';
export { McpHttpServer } from './mcp-http-server.js';
export { proxyMessages, runStdioProxy } from './stdio-proxy.js';
