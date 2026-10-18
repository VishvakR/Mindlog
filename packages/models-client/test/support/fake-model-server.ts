import { createServer } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { FakeModels } from '@mindlog/models-client';
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
} from '@mindlog/proto';

type Mode = 'busy' | 'missing' | 'slow';

const LABELS = {
  entailment: NliLabel.ENTAILMENT,
  neutral: NliLabel.NEUTRAL,
  contradiction: NliLabel.CONTRADICTION,
} as const;

function value<T>(r: { ok: true; value: T } | { ok: false }): T {
  if (!r.ok) throw new ConnectError('fake failed', Code.Internal);
  return r.value;
}

async function gate(mode: Mode | undefined): Promise<void> {
  if (mode === 'busy') throw new ConnectError('queue full', Code.ResourceExhausted);
  if (mode === 'missing') throw new ConnectError('model not loaded', Code.Unavailable);
  if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 500));
}

/**
 * The model service's gRPC API in TypeScript, answering with `FakeModels`, so the
 * adapter's encoding is tested end to end without Python or real models.
 */
export async function startFakeModelServer(
  modes: Partial<Record<'embed' | 'ner', Mode>> = {},
): Promise<{ address: string; close(): Promise<void> }> {
  const fake = new FakeModels();
  const handler = connectNodeAdapter({
    routes: (router) => {
      router.service(ModelsService, {
        async embed(req) {
          await gate(modes.embed);
          const r = value(
            await fake.embed(req.texts, req.kind === EmbedKind.QUERY ? 'query' : 'passage'),
          );
          return create(EmbedResponseSchema, {
            vectors: r.vectors.map((v) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength)),
            dims: r.dims,
            modelId: r.modelId,
          });
        },
        async recognizeEntities(req) {
          await gate(modes.ner);
          const r = value(await fake.recognize(req.texts, req.labels));
          return create(RecognizeEntitiesResponseSchema, {
            results: r.spans.map((spans) => ({ spans: [...spans] })),
            modelId: r.modelId,
          });
        },
        async classifyNli(req) {
          const r = value(
            await fake.classify(req.pairs.map((p) => [p.premise, p.hypothesis] as const)),
          );
          return create(ClassifyNliResponseSchema, {
            results: r.results.map((x) => ({ label: LABELS[x.label], score: x.score })),
            modelId: r.modelId,
          });
        },
        async rerank(req) {
          const r = value(await fake.rerank(req.query, req.documents));
          return create(RerankResponseSchema, { scores: [...r.scores], modelId: r.modelId });
        },
        async extractFacts(req) {
          const r = value(await fake.extractFacts(req.text));
          return create(ExtractFactsResponseSchema, {
            facts: r.facts.map((f) => ({ ...f, relations: [...f.relations] })),
            modelId: r.modelId,
          });
        },
        summarize() {
          throw new ConnectError('phase 8', Code.Unimplemented);
        },
        async health() {
          const r = value(await fake.health());
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
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    address: `127.0.0.1:${String(port)}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
