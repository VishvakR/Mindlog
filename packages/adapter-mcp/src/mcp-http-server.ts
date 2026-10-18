import type { AddressInfo } from 'node:net';
import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { ApiKeyIdentity } from '@mindlog/services';
import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { FastifyInstance } from 'fastify';
import type { McpMemory } from './memory-tools.js';
import { buildMcpServer } from './memory-tools.js';

export interface KeyVerifier {
  verify(key: string): Promise<Result<ApiKeyIdentity, MindlogError>>;
}

export interface McpHttpServerOptions {
  readonly memory: McpMemory;
  readonly keys: KeyVerifier;
  readonly host: string;
  readonly port: number;
  /** Host names accepted when binding beyond localhost (DNS-rebinding protection). */
  readonly allowedHosts?: readonly string[];
  readonly version: string;
}

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * MCP over Streamable HTTP on its own listener (PLAN 15.2, default :8765).
 * Every request carries an API key as a bearer token; a fresh server built
 * for that key answers it (stateless), so tools always act as the key.
 */
export class McpHttpServer {
  readonly app: FastifyInstance;
  readonly #o: McpHttpServerOptions;

  constructor(options: McpHttpServerOptions) {
    this.#o = options;
    this.app = createMcpFastifyApp({
      host: options.host,
      ...(options.allowedHosts?.length ? { allowedHosts: [...options.allowedHosts] } : {}),
    });
    const handler = toNodeHandler(
      createMcpHandler((ctx) => {
        const identity = ctx.authInfo?.extra?.identity as ApiKeyIdentity | undefined;
        if (!identity) throw new Error('unauthenticated MCP request');
        return buildMcpServer(options.memory, identity, options.version);
      }),
    );
    this.app.all('/mcp', async (request, reply) => {
      const token = BEARER.exec(request.headers.authorization ?? '')?.[1];
      const verified = token
        ? await options.keys.verify(token)
        : err(mindlogError('UNAUTHENTICATED', 'no API key'));
      if (!verified.ok) {
        return reply.code(401).header('www-authenticate', 'Bearer realm="mindlog"').send({
          error: 'unauthorized',
          message: 'Send an API key as `Authorization: Bearer mlk_…`.',
        });
      }
      const auth = {
        token: token ?? '',
        clientId: verified.value.id,
        scopes: ['memory'],
        extra: { identity: verified.value },
      };
      reply.hijack();
      // IncomingMessage has the fields; its optional ones are typed `T | undefined`.
      const raw = Object.assign(request.raw, { auth }) as unknown as Parameters<typeof handler>[0];
      await handler(raw, reply.raw, request.body);
    });
  }

  async listen(): Promise<Result<AddressInfo, MindlogError>> {
    try {
      await this.app.listen({ host: this.#o.host, port: this.#o.port });
      return ok(this.app.server.address() as AddressInfo);
    } catch (cause: unknown) {
      return err(
        mindlogError(
          'UNAVAILABLE',
          `cannot listen for MCP on ${this.#o.host}:${String(this.#o.port)}`,
          { cause },
        ),
      );
    }
  }

  async close(): Promise<void> {
    await this.app.close();
  }
}
