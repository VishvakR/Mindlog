import { create } from '@bufbuild/protobuf';
import type { ScopeCluster } from '@mindlog/proto';
import { ScopeClusterSchema } from '@mindlog/proto';

/**
 * Semantic split names (ADR-0039): cluster 0 of a scope is the scope itself;
 * cluster n is the scope `user␀c<n>`. Users never contain control characters
 * (the memory schemas refuse them), so the names cannot collide, and the NUL
 * sorts a cluster right after its root, as its own split boundary.
 */
const MARK = '\u0000c';

/** The job that splits and rebalances a scope (ADR-0039). */
export const SPLIT_JOB = 'memory.split';

/** Clusters a scope may have at most. */
export const MAX_CLUSTERS = 8;

export const clusterUser = (user: string, id: number): string =>
  id === 0 ? user : `${user}${MARK}${String(id)}`;

/** The user a cluster scope belongs to (itself for an unsplit scope). */
export const baseUser = (user: string): string => {
  const at = user.indexOf(MARK);
  return at < 0 ? user : user.slice(0, at);
};

export const clusterIdOf = (user: string): number => {
  const at = user.indexOf(MARK);
  return at < 0 ? 0 : Number(user.slice(at + MARK.length));
};

export const vectorOf = (bytes: Uint8Array): Float32Array =>
  new Float32Array(bytes.slice().buffer, 0, bytes.length / 4);

export const bytesOf = (vector: Float32Array): Uint8Array =>
  new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));

const dot = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
};

/** Cosine distance of two L2-normalised vectors. */
export const distance = (a: Float32Array, b: Float32Array): number => 1 - dot(a, b);

export function normalise(v: Float32Array): Float32Array {
  const n = Math.sqrt(dot(v, v));
  return n === 0 ? v : v.map((x) => x / n);
}

/** Cluster ids nearest first; ties go to the lower id, so routing is stable. */
export function rankClusters(vector: Float32Array, clusters: readonly ScopeCluster[]): number[] {
  return [...clusters]
    .map((c) => ({ id: c.id, d: distance(vector, vectorOf(c.centroid)) }))
    .sort((a, b) => a.d - b.d || a.id - b.id)
    .map((c) => c.id);
}

export const cluster = (id: number, centroid: Float32Array, spread: number): ScopeCluster =>
  create(ScopeClusterSchema, { id, centroid: bytesOf(centroid), spread });
