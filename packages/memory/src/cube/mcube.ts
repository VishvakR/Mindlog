import { createHash } from 'node:crypto';
import type { MemoryKind, MemoryView } from '../types.js';
import { MEMORY_KINDS } from '../types.js';
import type { TarFile } from './tar.js';
import { packTar, unpackTar } from './tar.js';

// Memory cubes (PLAN 13.11): a scope's memory as a gzip tar of a manifest and JSONL files.

export const CUBE_FORMAT = 'mcube';
export const CUBE_VERSION = 1;
/** Most memories an import takes, and the most bytes an archive may unpack to. */
export const IMPORT_LIMITS = { memories: 5000, files: 64, bytes: 64 * 1024 * 1024 } as const;

export interface CubeManifest {
  readonly format: typeof CUBE_FORMAT;
  readonly version: number;
  readonly scope: { readonly tenant: string; readonly user: string };
  /** MVCC version (HLC) the scope was read at, as a decimal string. */
  readonly asOfVersion: string;
  readonly exportedAtMs: number;
  readonly embeddingModel: string;
  readonly counts: Readonly<Record<string, number>>;
  /** sha256 (hex) of every other file. */
  readonly files: Readonly<Record<string, string>>;
}

export interface CubeParts {
  readonly scope: { readonly tenant: string; readonly user: string };
  readonly asOfVersion: bigint;
  readonly exportedAtMs: number;
  readonly embeddingModel: string;
  readonly memories: readonly MemoryView[];
  readonly entities: ReadonlyArray<{
    id: string;
    name: string;
    type: string;
    mentions: number;
    summary?: string;
  }>;
  readonly edges: ReadonlyArray<{ src: string; relation: string; dst: string; weight: number }>;
  readonly branches: ReadonlyArray<Record<string, unknown>>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const jsonl = (rows: readonly unknown[]) =>
  encoder.encode(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));

/** The `.mcube` bytes of a scope's memory. */
export function packCube(p: CubeParts): Uint8Array {
  const files: TarFile[] = [
    { name: 'memories.jsonl', data: jsonl(p.memories) },
    { name: 'entities.jsonl', data: jsonl(p.entities) },
    { name: 'edges.jsonl', data: jsonl(p.edges) },
    { name: 'branches.json', data: encoder.encode(JSON.stringify(p.branches)) },
  ];
  const manifest: CubeManifest = {
    format: CUBE_FORMAT,
    version: CUBE_VERSION,
    scope: p.scope,
    asOfVersion: String(p.asOfVersion),
    exportedAtMs: p.exportedAtMs,
    embeddingModel: p.embeddingModel,
    counts: {
      memories: p.memories.length,
      entities: p.entities.length,
      edges: p.edges.length,
      branches: p.branches.length,
    },
    files: Object.fromEntries(files.map((f) => [f.name, sha256(f.data)])),
  };
  return packTar([
    { name: 'manifest.json', data: encoder.encode(JSON.stringify(manifest, null, 2)) },
    ...files,
  ]);
}

/** A memory to import: what remember needs, from either format. */
export interface ImportItem {
  readonly text: string;
  readonly kind: MemoryKind;
  readonly tags: readonly string[];
  readonly agent?: string;
  readonly session?: string;
  readonly validFromMs?: number;
  readonly validToMs?: number;
  readonly meta: Readonly<Record<string, unknown>>;
}

const KINDS = new Set<string>(MEMORY_KINDS);

function lines(file: TarFile | undefined): unknown[] {
  if (!file) return [];
  return decoder
    .decode(file.data)
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as unknown);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 20) : [];

/** The memories of a `.mcube`, after checking its manifest and checksums. Throws on a bad archive. */
export function unpackCube(bytes: Uint8Array): {
  manifest: Partial<CubeManifest>;
  items: ImportItem[];
} {
  const files = new Map(
    unpackTar(bytes, { maxFiles: IMPORT_LIMITS.files, maxBytes: IMPORT_LIMITS.bytes }).map((f) => [
      f.name,
      f,
    ]),
  );
  const m = files.get('manifest.json');
  if (!m) throw new RangeError('not a memory cube: no manifest.json');
  const manifest = JSON.parse(decoder.decode(m.data)) as Partial<CubeManifest>;
  if (manifest.format !== CUBE_FORMAT || typeof manifest.version !== 'number')
    throw new RangeError('not a memory cube: bad manifest');
  if (manifest.version > CUBE_VERSION)
    throw new RangeError(`cube v${String(manifest.version)} is newer than this reader`);
  for (const [name, hash] of Object.entries(manifest.files ?? {})) {
    const f = files.get(name);
    if (!f || sha256(f.data) !== hash) throw new RangeError(`${name} does not match the manifest`);
  }
  const items: ImportItem[] = [];
  for (const row of lines(files.get('memories.jsonl'))) {
    const r = row as Record<string, unknown>;
    const text = str(r.text);
    if (!text || r.expiredAtMs !== undefined) continue;
    const kind =
      typeof r.kind === 'string' && KINDS.has(r.kind) ? (r.kind as MemoryKind) : 'semantic';
    const validFromMs = num(r.validFromMs);
    const validToMs = num(r.validToMs);
    items.push({
      text,
      kind,
      tags: strings(r.tags),
      ...(str(r.agent) ? { agent: str(r.agent) as string } : {}),
      ...(str(r.session) ? { session: str(r.session) as string } : {}),
      ...(validFromMs !== undefined ? { validFromMs } : {}),
      ...(validToMs !== undefined ? { validToMs } : {}),
      meta: { importedId: r.id ?? null },
    });
  }
  return { manifest, items };
}
