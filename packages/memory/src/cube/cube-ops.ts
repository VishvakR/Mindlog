import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import { branchView } from '../branches.js';
import type { EngineCore, LifecycleOps } from '../lifecycle-ops.js';
import { MemoryReads } from '../read/memory-reads.js';
import type { AsOf, CallContext, MemoryRange, MemoryScope, MemoryView } from '../types.js';
import { toView } from '../view.js';
import { unpackCogx } from './cogx.js';
import type { ImportItem } from './mcube.js';
import { IMPORT_LIMITS, packCube, unpackCube } from './mcube.js';

const encoder = new TextEncoder();

/** Memory cubes of a scope (PLAN 13.11): export as `.mcube`, import `.mcube` or COGX. */
export class CubeOps {
  readonly #c: EngineCore;
  readonly #ops: LifecycleOps;

  constructor(core: EngineCore, ops: LifecycleOps) {
    this.#c = core;
    this.#ops = ops;
  }

  /** The scope as a `.mcube` (PLAN 13.11), at `asOf` or now; cold memories with their full text. */
  async exportCube(
    range: MemoryRange,
    scope: MemoryScope,
    asOf?: AsOf,
  ): Promise<Result<Uint8Array, MindlogError>> {
    const at = asOf ? await this.#c.version(range, scope, asOf) : undefined;
    const reads = new MemoryReads(range.reader, scope.tenant, scope.user, at);
    const memories: MemoryView[] = [];
    for await (const r of reads.records()) {
      if (r.expiredAt !== 0n) continue;
      if (memories.length >= IMPORT_LIMITS.memories)
        return err(
          mindlogError('PAYLOAD_TOO_LARGE', `more than ${String(IMPORT_LIMITS.memories)} memories`),
        );
      if (r.tier === 'cold' && this.#c.cold) {
        const e = await this.#c.cold.entry(r);
        if (!e.ok) return e;
        memories.push({ ...toView(r), text: e.value.record.text });
      } else memories.push(toView(r));
    }
    const entities = [];
    for await (const { id, entity } of reads.entities())
      entities.push({
        id,
        name: entity.name,
        type: entity.type,
        mentions: entity.mentionCount,
        ...(entity.summary ? { summary: entity.summary } : {}),
      });
    const edges = [];
    for await (const e of reads.edges())
      edges.push({ src: e.src, relation: e.relation, dst: e.dst, weight: e.edge.weight });
    const branches = [];
    for await (const b of reads.branches()) branches.push({ ...branchView(b) });
    return ok(
      packCube({
        scope: { tenant: scope.tenant, user: scope.user },
        asOfVersion: at ?? 0n,
        exportedAtMs: Number(this.#c.deps.clock.now()),
        embeddingModel: (await this.#ops.lifecycle(range, scope)).embedModel,
        memories,
        entities,
        edges,
        branches,
      }),
    );
  }

  /**
   * Imports a `.mcube` or COGX archive into the scope (PLAN 13.11): each
   * memory is remembered as given, from source `document` with ref
   * `import:<name>`, so the trust policy applies (CLAUDE.md 12).
   */
  async importCube(
    range: MemoryRange,
    scope: MemoryScope,
    input: { bytes: Uint8Array; format: 'mcube' | 'cogx'; name: string },
    context: CallContext,
  ): Promise<Result<{ imported: number; skipped: number; ids: string[] }, MindlogError>> {
    let items: ImportItem[];
    try {
      items =
        input.format === 'cogx' ? unpackCogx(input.bytes).items : unpackCube(input.bytes).items;
    } catch (cause) {
      return err(
        mindlogError(
          'INVALID_ARGUMENT',
          `cannot read the ${input.format} archive: ${String(cause)}`,
        ),
      );
    }
    if (items.length > IMPORT_LIMITS.memories)
      return err(
        mindlogError('PAYLOAD_TOO_LARGE', `more than ${String(IMPORT_LIMITS.memories)} memories`),
      );
    const ids: string[] = [];
    let skipped = 0;
    const base = context.requestId ? new TextDecoder().decode(context.requestId) : undefined;
    for (const [i, it] of items.entries()) {
      const done = await this.#c.remember(
        range,
        {
          scope: {
            ...scope,
            ...(it.agent ? { agent: it.agent } : {}),
            ...(it.session ? { session: it.session } : {}),
          },
          content: it.text.slice(0, this.#c.config.maxTextBytes / 4),
          kind: it.kind,
          tags: it.tags,
          meta: it.meta,
          source: { type: 'document', ref: `import:${input.name}` },
          ...(it.validFromMs !== undefined ? { validFromMs: it.validFromMs } : {}),
          ...(it.validToMs !== undefined ? { validToMs: it.validToMs } : {}),
        },
        {
          principal: context.principal,
          ...(base ? { requestId: encoder.encode(`${base}:${String(i)}`) } : {}),
        },
      );
      if (done.ok) ids.push(...done.value.ids);
      else skipped++;
    }
    return ok({ imported: items.length - skipped, skipped, ids });
  }
}
