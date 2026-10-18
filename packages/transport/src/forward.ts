import type { Client, ConnectRouter } from '@connectrpc/connect';
import { ConnectError, createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import type { ClockSync, Hlc, MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { ExecuteRequest, KvReply } from '@mindlog/proto';
import { ExecuteResponseSchema, KvForwardService } from '@mindlog/proto';
import { create } from '@bufbuild/protobuf';

/** Runs a forwarded call on the range this node holds; supplied by the request layer. */
export type ForwardHandler = (request: ExecuteRequest) => Promise<KvReply>;

/** Mounts `KvForwardService` on the internal listener (ADR-0029). */
export function forwardRoutes(
  handler: () => ForwardHandler,
  clock?: ClockSync,
): (router: ConnectRouter) => void {
  return (router) => {
    router.service(KvForwardService, {
      execute: async (request) => {
        if (request.hlc !== 0n) clock?.receive(request.fromAddress, request.hlc as Hlc);
        return create(ExecuteResponseSchema, { reply: await handler()(request) });
      },
    });
  };
}

/** Sends forwarded calls to the node at an internal address, one connection per node. */
export class KvForwarder {
  readonly #clients = new Map<string, Client<typeof KvForwardService>>();

  async execute(address: string, request: ExecuteRequest): Promise<Result<KvReply, MindlogError>> {
    let client = this.#clients.get(address);
    if (!client) {
      client = createClient(
        KvForwardService,
        createGrpcTransport({ baseUrl: `http://${address}` }),
      );
      this.#clients.set(address, client);
    }
    try {
      const response = await client.execute(request);
      return response.reply
        ? ok(response.reply)
        : err(mindlogError('INTERNAL', 'forwarded call returned no reply'));
    } catch (cause: unknown) {
      const e = ConnectError.from(cause);
      // The request may have reached the node before the connection failed, so the outcome is unknown.
      return err(
        mindlogError('DEADLINE_EXCEEDED', `node ${address} did not answer: ${e.rawMessage}`, {
          cause,
        }),
      );
    }
  }
}
