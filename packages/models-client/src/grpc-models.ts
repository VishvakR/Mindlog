import type { Client } from '@connectrpc/connect';
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import type { MindlogError, MindlogErrorCode, Result, TlsProvider } from '@mindlog/core';
import { err, mindlogError, ok, grpcClientOptions } from '@mindlog/core';
import {
  EmbedKind as ProtoEmbedKind,
  ModelsService,
  NliLabel as ProtoNliLabel,
} from '@mindlog/proto';
import type {
  CallOptions,
  Capability,
  EmbedKind,
  Embeddings,
  ExtractedFacts,
  FactKind,
  Models,
  ModelServiceStatus,
  NliLabel,
  NliResults,
  RecognizedEntities,
  RerankScores,
  SummarizeOptions,
  Summary,
} from './ports.js';

export interface GrpcModelsOptions {
  /** `host:port` of the model service; plaintext HTTP/2 on localhost unless `tls` is set. */
  readonly address: string;
  /** Mutual TLS to the sidecar (PLAN 18.4). */
  readonly tls?: TlsProvider;
  /** Default deadline per call. */
  readonly timeoutMs: number;
}

const CODES: Partial<Record<Code, MindlogErrorCode>> = {
  [Code.Unavailable]: 'UNAVAILABLE',
  [Code.ResourceExhausted]: 'BUSY',
  [Code.DeadlineExceeded]: 'DEADLINE_EXCEEDED',
  [Code.Unimplemented]: 'UNIMPLEMENTED',
  [Code.Canceled]: 'CANCELLED',
  [Code.InvalidArgument]: 'INVALID_ARGUMENT',
};

const NLI: Record<number, NliLabel> = {
  [ProtoNliLabel.ENTAILMENT]: 'entailment',
  [ProtoNliLabel.NEUTRAL]: 'neutral',
  [ProtoNliLabel.CONTRADICTION]: 'contradiction',
};

const FACT_KINDS = new Set<string>(['semantic', 'procedural', 'episodic']);
const CAPABILITIES: readonly Capability[] = [
  'embed',
  'ner',
  'nli',
  'rerank',
  'extract',
  'summarize',
];

function vector(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** The model service over gRPC (PLAN 14.3); every failure becomes a `MindlogError`. */
export class GrpcModels implements Models {
  #client: Client<typeof ModelsService>;
  readonly #timeoutMs: number;

  constructor(options: GrpcModelsOptions) {
    const connect = () =>
      createClient(
        ModelsService,
        createGrpcTransport(grpcClientOptions(options.address, options.tls)),
      );
    this.#client = connect();
    options.tls?.subscribe(() => {
      this.#client = connect();
    });
    this.#timeoutMs = options.timeoutMs;
  }

  async #call<T>(
    method: string,
    options: CallOptions | undefined,
    run: (call: { timeoutMs: number }) => Promise<T>,
  ): Promise<Result<T, MindlogError>> {
    try {
      return ok(await run({ timeoutMs: options?.timeoutMs ?? this.#timeoutMs }));
    } catch (cause: unknown) {
      const e = ConnectError.from(cause);
      return err(
        mindlogError(CODES[e.code] ?? 'INTERNAL', `model service ${method}: ${e.rawMessage}`, {
          cause,
        }),
      );
    }
  }

  embed(
    texts: readonly string[],
    kind: EmbedKind,
    options?: CallOptions,
  ): Promise<Result<Embeddings, MindlogError>> {
    return this.#call('embed', options, async (call) => {
      const r = await this.#client.embed(
        {
          texts: [...texts],
          kind: kind === 'query' ? ProtoEmbedKind.QUERY : ProtoEmbedKind.PASSAGE,
        },
        call,
      );
      return { modelId: r.modelId, dims: r.dims, vectors: r.vectors.map(vector) };
    });
  }

  recognize(
    texts: readonly string[],
    labels: readonly string[],
    options?: CallOptions,
  ): Promise<Result<RecognizedEntities, MindlogError>> {
    return this.#call('recognize', options, async (call) => {
      const r = await this.#client.recognizeEntities(
        { texts: [...texts], labels: [...labels] },
        call,
      );
      return {
        modelId: r.modelId,
        spans: r.results.map((x) =>
          x.spans.map((s) => ({
            start: s.start,
            end: s.end,
            text: s.text,
            label: s.label,
            score: s.score,
          })),
        ),
      };
    });
  }

  classify(
    pairs: ReadonlyArray<readonly [string, string]>,
    options?: CallOptions,
  ): Promise<Result<NliResults, MindlogError>> {
    return this.#call('classify', options, async (call) => {
      const r = await this.#client.classifyNli(
        { pairs: pairs.map(([premise, hypothesis]) => ({ premise, hypothesis })) },
        call,
      );
      return {
        modelId: r.modelId,
        results: r.results.map((x) => ({ label: NLI[x.label] ?? 'neutral', score: x.score })),
      };
    });
  }

  rerank(
    query: string,
    documents: readonly string[],
    options?: CallOptions,
  ): Promise<Result<RerankScores, MindlogError>> {
    return this.#call('rerank', options, async (call) => {
      const r = await this.#client.rerank({ query, documents: [...documents] }, call);
      return { modelId: r.modelId, scores: r.scores };
    });
  }

  extractFacts(text: string, options?: CallOptions): Promise<Result<ExtractedFacts, MindlogError>> {
    return this.#call('extractFacts', options, async (call) => {
      const r = await this.#client.extractFacts({ text }, call);
      return {
        modelId: r.modelId,
        facts: r.facts.map((f) => ({
          text: f.text,
          kind: (FACT_KINDS.has(f.kind) ? f.kind : 'semantic') as FactKind,
          relations: f.relations.map((x) => ({
            subject: x.subject,
            relation: x.relation,
            object: x.object,
          })),
        })),
      };
    });
  }

  summarize(
    texts: readonly string[],
    instruction: string,
    options?: SummarizeOptions,
  ): Promise<Result<Summary, MindlogError>> {
    return this.#call('summarize', options, async (call) => {
      const r = await this.#client.summarize(
        { texts: [...texts], instruction, maxChars: options?.maxChars ?? 0 },
        call,
      );
      return { modelId: r.modelId, summary: r.summary };
    });
  }

  health(options?: CallOptions): Promise<Result<ModelServiceStatus, MindlogError>> {
    return this.#call('health', options, async (call) => {
      const r = await this.#client.health({}, call);
      const byName = new Map(r.models.map((m) => [m.capability, m]));
      const status = (c: Capability) => ({
        modelId: byName.get(c)?.modelId ?? '',
        ready: byName.get(c)?.ready ?? false,
      });
      return {
        ready: r.ready,
        capabilities: Object.fromEntries(CAPABILITIES.map((c) => [c, status(c)])) as Record<
          Capability,
          { modelId: string; ready: boolean }
        >,
      };
    });
  }
}
