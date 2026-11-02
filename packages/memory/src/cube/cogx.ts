import type { ImportItem } from './mcube.js';
import { IMPORT_LIMITS } from './mcube.js';
import type { TarFile } from './tar.js';
import { unpackTar } from './tar.js';

// COGX, Cognee's exchange format (cognee/modules/migration/cogx.py, COGX 0.1): a tar.gz of
// manifest.json and one JSONL file per record kind. Read only; raw nodes and permissions are skipped.

const decoder = new TextDecoder();
export const COGX_MAJOR = 0;

type Row = Record<string, unknown>;
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

/** Epoch s/ms/µs/ns or ISO 8601 (naive read as UTC) to ms, as COGX `parse_timestamp` does. */
export function cogxTime(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    let s = v;
    while (Math.abs(s) > 2e10) s /= 1000;
    return Math.round(s * 1000);
  }
  if (typeof v !== 'string' || v === '') return undefined;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(v) || !v.includes('T') ? v : `${v}Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

function rows(files: Map<string, TarFile>, name: string): Row[] {
  const f = files.get(name);
  if (!f) return [];
  return decoder
    .decode(f.data)
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Row);
}

function common(r: Row): Pick<ImportItem, 'agent' | 'session' | 'meta'> {
  const scope = (r.scope ?? {}) as Row;
  const agent = str(scope.agent_id);
  const session = str(scope.session_id) ?? str(scope.run_id);
  return {
    ...(agent ? { agent } : {}),
    ...(session ? { session } : {}),
    meta: { cogx: { system: r.external_system ?? 'unknown', id: r.external_id ?? null } },
  };
}

/** The memories of a COGX archive. Throws on an archive it cannot read. */
export function unpackCogx(bytes: Uint8Array): { source: string; items: ImportItem[] } {
  const files = new Map(
    unpackTar(bytes, { maxFiles: IMPORT_LIMITS.files, maxBytes: IMPORT_LIMITS.bytes }).map((f) => [
      f.name.split('/').at(-1) ?? f.name,
      f,
    ]),
  );
  const m = files.get('manifest.json');
  if (!m) throw new RangeError('not a COGX archive: no manifest.json');
  const manifest = JSON.parse(decoder.decode(m.data)) as Row;
  const version = typeof manifest.cogx_version === 'string' ? manifest.cogx_version : '0';
  const major = Number(version.split('.')[0]);
  if (!Number.isInteger(major) || major > COGX_MAJOR)
    throw new RangeError(`COGX ${version} is newer than this reader (0.1)`);
  const items: ImportItem[] = [];
  const add = (r: Row, text: string | undefined, it: Partial<ImportItem> = {}) => {
    if (text) items.push({ text, kind: 'semantic', tags: [], ...common(r), ...it });
  };
  for (const r of rows(files, 'memories.jsonl'))
    add(r, str(r.content), { tags: ((r.categories as string[] | undefined) ?? []).slice(0, 20) });
  for (const r of rows(files, 'facts.jsonl')) {
    const from = cogxTime(r.valid_at);
    const to = cogxTime(r.invalid_at);
    add(r, str(r.fact_text) ?? [r.subject_ref, r.predicate, r.object_ref].map(String).join(' '), {
      ...(from !== undefined ? { validFromMs: from } : {}),
      ...(to !== undefined ? { validToMs: to } : {}),
    });
  }
  for (const r of rows(files, 'memory_blocks.jsonl'))
    add(r, str(r.value) && `${String(r.label)}: ${String(r.value)}`, { tags: ['memory-block'] });
  for (const r of rows(files, 'entities.jsonl'))
    add(r, str(r.description) && `${String(r.name)}: ${String(r.description)}`, {
      tags: ['entity'],
    });
  for (const r of rows(files, 'episodes.jsonl')) {
    const turns = ((r.turns as Row[] | undefined) ?? [])
      .map((t) => `${String(t.role)}: ${String(t.content)}`)
      .join('\n');
    add(r, str(turns), { kind: 'episodic' });
  }
  for (const r of rows(files, 'documents.jsonl'))
    add(r, str(r.content), { kind: 'episodic', tags: str(r.title) ? [String(r.title)] : [] });
  return { source: str(manifest.source_system) ?? 'unknown', items };
}
