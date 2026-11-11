import type { Http2Session } from 'node:http2';
import { createSecureServer, createServer } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import type { MindlogError, MindlogErrorCode, Result, TlsProvider } from '@mindlog/core';
import { mutualServerTls } from '@mindlog/core';
import {
  ClassifyNliResponseSchema,
  EmbedKind,
  EmbedResponseSchema,
  ExtractFactsResponseSchema,
  HealthResponseSchema,
  ModelsService,
  NliLabel,
  RecognizeEntitiesResponseSchema,
  RerankResponseSchema,
  SummarizeResponseSchema,
} from '@mindlog/proto';
import type { Models } from './ports.js';

const LABELS = {
  entailment: NliLabel.ENTAILMENT,
  neutral: NliLabel.NEUTRAL,
  contradiction: NliLabel.CONTRADICTION,
} as const;

const CODES: Partial<Record<MindlogErrorCode, Code>> = {
  UNAVAILABLE: Code.Unavailable,
  BUSY: Code.ResourceExhausted,
  DEADLINE_EXCEEDED: Code.DeadlineExceeded,
  UNIMPLEMENTED: Code.Unimplemented,
  INVALID_ARGUMENT: Code.InvalidArgument,
};

function value<T>(r: Result<T, MindlogError>): T {
  if (!r.ok) throw new ConnectError(r.error.message, CODES[r.error.code] ?? Code.Internal);
  return r.value;
}

export interface ServedModels {
  /** `host:port`, for `models.endpoint`. */
  readonly address: string;
  close(): Promise<void>;
}

/**
 * Serves any `Models` as the model service's gRPC API (PLAN 14.3): `FakeModels`
 * for tests and demos without Python, or a wrapper that injects faults.
 */
export async function serveModels(
  models: Models,
  options: { host?: string; port?: number; tls?: TlsProvider } = {},
): Promise<ServedModels> {
  const handler = connectNodeAdapter({
    routes: (router) => {
      router.service(ModelsService, {
        async embed(req) {
          const r = value(
            await models.embed(req.texts, req.kind === EmbedKind.QUERY ? 'query' : 'passage'),
          );
          return create(EmbedResponseSchema, {
            vectors: r.vectors.map((v) => {
              const bytes = new Uint8Array(v.length * 4);
              const view = new DataView(bytes.buffer);
              v.forEach((x, i) => {
                view.setFloat32(i * 4, x, true);
              });
              return bytes;
            }),
            dims: r.dims,
            modelId: r.modelId,
          });
        },
        async recognizeEntities(req) {
          const r = value(await models.recognize(req.texts, req.labels));
          return create(RecognizeEntitiesResponseSchema, {
            results: r.spans.map((spans) => ({ spans: [...spans] })),
            modelId: r.modelId,
          });
        },
        async classifyNli(req) {
          const r = value(
            await models.classify(req.pairs.map((p) => [p.premise, p.hypothesis] as const)),
          );
          return create(ClassifyNliResponseSchema, {
            results: r.results.map((x) => ({ label: LABELS[x.label], score: x.score })),
            modelId: r.modelId,
          });
        },
        async rerank(req) {
          const r = value(await models.rerank(req.query, req.documents));
          return create(RerankResponseSchema, { scores: [...r.scores], modelId: r.modelId });
        },
        async extractFacts(req) {
          const r = value(await models.extractFacts(req.text));
          return create(ExtractFactsResponseSchema, {
            facts: r.facts.map((f) => ({ ...f, relations: [...f.relations] })),
            modelId: r.modelId,
          });
        },
        async summarize(req) {
          const r = value(
            await models.summarize(req.texts, req.instruction, {
              ...(req.maxChars > 0 ? { maxChars: req.maxChars } : {}),
            }),
          );
          return create(SummarizeResponseSchema, { summary: r.summary, modelId: r.modelId });
        },
        async health() {
          const r = value(await models.health());
          return create(HealthResponseSchema, {
            ready: r.ready,
            models: Object.entries(r.capabilities).map(([capability, s]) => ({
              capability,
              modelId: s.modelId,
              ready: s.ready,
            })),
          });
        },
      });
    },
  });
  const { tls } = options;
  const server = tls
    ? createSecureServer(mutualServerTls(tls.identity()), handler)
    : createServer(handler);
  const sessions = new Set<Http2Session>();
  server.on('session', (session) => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve);
  });
  const { address, port } = server.address() as AddressInfo;
  return {
    address: `${address}:${String(port)}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
        // Drop open HTTP/2 sessions so close() returns, as a stopped process would.
        for (const session of sessions) session.destroy();
      }),
  };
}
