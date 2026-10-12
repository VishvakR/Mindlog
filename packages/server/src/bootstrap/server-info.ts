import { readFileSync } from 'node:fs';
import type { ServerInfo } from '@mindlog/adapter-resp';
import type { MindlogConfig } from '@mindlog/core';

/** Redis API level Mindlog emulates, reported as `redis_version`. */
export const REDIS_API_VERSION = '7.2.0';

/** This package's version, from `package.json` (next to `src/` and `dist/`). */
export function mindlogVersion(): string {
  const pkg: unknown = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  return typeof pkg === 'object' &&
    pkg !== null &&
    'version' in pkg &&
    typeof pkg.version === 'string'
    ? pkg.version
    : '0.0.0';
}

/** What INFO, HELLO and CONFIG GET report about this node. */
export function serverInfo(config: MindlogConfig, port: number, startedAtMs: bigint): ServerInfo {
  const { limits } = config;
  return {
    redisVersion: REDIS_API_VERSION,
    mindlogVersion: mindlogVersion(),
    port,
    startedAtMs,
    processId: process.pid,
    settings: {
      databases: '1',
      port: String(port),
      bind: config.listen.resp.host,
      maxclients: String(limits.maxClients),
      timeout: String(Math.floor(limits.idleTimeoutMs / 1000)),
      'proto-max-bulk-len': String(limits.maxBulkBytes),
      'client-query-buffer-limit': String(limits.maxInlineBytes),
      appendonly: 'yes',
      appendfsync: 'always',
      save: '',
      dir: config.node.dataDir,
    },
  };
}
