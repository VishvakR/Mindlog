import { create, fromBinary } from '@bufbuild/protobuf';
import type { MindlogError, Result } from '@mindlog/core';
import { decodeKey, ok } from '@mindlog/core';
import type { NewMemory, ScopeCluster } from '@mindlog/proto';
import { MemoryRehomeSchema, MemoryVectorSchema, NewMemorySchema } from '@mindlog/proto';
import { MvccReader } from '@mindlog/storage';
import type { EmbedKind } from '@mindlog/models-client';
import type { EngineCore, LifecycleOps } from '../lifecycle-ops.js';
import { derivedPrefix, vectorPrefix } from '../keys.js';
import { MemoryReads } from '../read/memory-reads.js';
import type { CallContext, MemoryRange, MemoryScope } from '../types.js';
import { rankClusters, vectorOf } from './clusters.js';

export interface RouteResult {
  /** Cluster ids, nearest first; all of them in id order when there was no embedding. */
  readonly clusters: number[];
  readonly degraded: boolean;
  /** The text's embedding, when one was made. */
  readonly vector?: Float32Array;
}

/**
 * A scope's semantic split (ADR-0039), as one range sees it: the root's
 * clusters, routing a text to them, and the reads and writes a move needs.
 * The moves across ranges are the service's, which can reach every range.
 */
export class SplitOps {
  constructor(
    private readonly core: EngineCore,
    private readonly ops: LifecycleOps,
  ) {}

  /** The root scope's clusters; empty when it is not split. */
  async clusters(range: MemoryRange, scope: MemoryScope): Promise<ScopeCluster[]> {
    return (await this.ops.lifecycle(range, scope)).clusters;
  }

  /** Embeds `text` once and ranks the root's clusters by distance to it. */
  async route(
    range: MemoryRange,
    scope: MemoryScope,
    text: string,
    kind: EmbedKind,
  ): Promise<Result<RouteResult, MindlogError>> {
    const clusters = await this.clusters(range, scope);
    const all = clusters.map((c) => c.id).sort((a, b) => a - b);
    if (clusters.length < 2) return ok({ clusters: all.length > 0 ? all : [0], degraded: false });
    const embedded = await this.core.deps.models.embed([text], kind, {
      timeoutMs: this.core.config.modelTimeoutMs,
    });
    const vector = embedded.ok ? embedded.value.vectors[0] : undefined;
    // Without a vector the caller asks every cluster (recall) or the root (writes).
    if (!vector) return ok({ clusters: all, degraded: true });
    return ok({ clusters: rankClusters(vector, clusters), degraded: false, vector });
  }

  /** Every hot memory of this scope that has a vector, for clustering. */
  async vectors(
    range: MemoryRange,
    scope: MemoryScope,
    limit: number,
  ): Promise<Array<{ id: string; vector: Float32Array }>> {
    const out: Array<{ id: string; vector: Float32Array }> = [];
    const prefix = vectorPrefix(scope.tenant, scope.user);
    for await (const { key, value } of new MvccReader(range.reader).scan(prefix, { limit })) {
      const decoded = decodeKey(key);
      const id = decoded.ok ? decoded.value.tuple.at(-1) : undefined;
      if (typeof id !== 'string') continue;
      out.push({ id, vector: vectorOf(fromBinary(MemoryVectorSchema, value).vector) });
    }
    return out;
  }

  /** What a cluster needs to take these memories in: record, vector and entity names. */
  async copies(
    range: MemoryRange,
    scope: MemoryScope,
    ids: readonly string[],
  ): Promise<NewMemory[]> {
    const reads = new MemoryReads(range.reader, scope.tenant, scope.user);
    const out: NewMemory[] = [];
    for (const id of ids) {
      const record = await reads.record(id);
      if (!record || record.expiredAt !== 0n) continue;
      const vector = await reads.vector(id);
      const mentions = [];
      for (const entityId of record.entities) {
        const entity = await reads.entity(entityId);
        if (entity) mentions.push({ name: entity.name, type: entity.type });
      }
      out.push(
        create(NewMemorySchema, { record, vector: vector?.vector ?? new Uint8Array(), mentions }),
      );
    }
    return out;
  }

  /** Memories of this scope derived from any of `ids`, wherever those live (taint across clusters). */
  async derived(range: MemoryRange, scope: MemoryScope, ids: readonly string[]): Promise<string[]> {
    const out = new Set<string>();
    const reader = new MvccReader(range.reader);
    for (const id of ids) {
      const prefix = derivedPrefix(scope.tenant, scope.user, id);
      for await (const { key } of reader.scan(prefix)) {
        const decoded = decodeKey(key);
        const child = decoded.ok ? decoded.value.tuple.at(-1) : undefined;
        if (typeof child === 'string') out.add(child);
      }
    }
    return [...out];
  }

  /** Proposes one rehome step on this scope's range. */
  rehome(
    range: MemoryRange,
    scope: MemoryScope,
    body: {
      setLayout?: boolean;
      layout?: ScopeCluster[];
      copies?: NewMemory[];
      moved?: string[];
      movedTo?: string;
    },
    context: CallContext,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    return this.core.write(range, scope, context, {
      case: 'memoryRehome',
      value: create(MemoryRehomeSchema, { ...body, user: scope.user }),
    });
  }
}
