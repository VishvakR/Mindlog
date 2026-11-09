import type { KeyRange, MindlogError, Result } from '@mindlog/core';
import { KeyFamily, decodeKey, keyPrefix, prefixRange } from '@mindlog/core';
import type { KvReader } from '@mindlog/storage';
import { compareBytes, parseVersionedKey } from '@mindlog/storage';
import type { TenantInfo } from './schemas.js';
import type { TenantUsage } from './governor.js';

export interface UsageSamplerDeps {
  readonly tenants: () => Promise<Result<TenantInfo[], MindlogError>>;
  /** Key spans of the ranges this node leads, so the cluster counts each range once. */
  readonly leaderSpans: () => readonly KeyRange[];
  readonly state: KvReader;
  /** Approximate on-disk bytes of a key span. */
  readonly sizer: (start: Uint8Array, end: Uint8Array) => Promise<number>;
  /** Most keys walked per tenant per sample. */
  readonly maxKeys?: number;
}

const DEFAULT_MAX_KEYS = 200_000;

function overlap(a: KeyRange, b: KeyRange): KeyRange | undefined {
  const start = compareBytes(a.start, b.start) >= 0 ? a.start : b.start;
  const end = compareBytes(a.end, b.end) <= 0 ? a.end : b.end;
  return compareBytes(start, end) < 0 ? { start, end } : undefined;
}

/**
 * Approximate per-tenant usage of the ranges this node leads. Only tenants with
 * a storage-shaped quota are measured.
 * shortcut: keys and memories come from a capped walk, so past `maxKeys` they under-count; maintain counters if quotas need to be exact.
 */
export class UsageSampler {
  constructor(private readonly deps: UsageSamplerDeps) {}

  async #count(tenant: string, spans: readonly KeyRange[]) {
    const cap = this.deps.maxKeys ?? DEFAULT_MAX_KEYS;
    let keys = 0;
    let memories = 0;
    let walked = 0;
    let previous: Uint8Array | undefined;
    for (const span of spans) {
      for await (const [raw] of this.deps.state.iterate(span)) {
        if (++walked > cap) return { keys, memories };
        const logical = parseVersionedKey(raw)?.logical ?? raw;
        if (previous && compareBytes(previous, logical) === 0) continue;
        previous = logical.slice();
        const decoded = decodeKey(logical);
        if (!decoded.ok || decoded.value.tenant !== tenant) continue;
        const { family, tuple } = decoded.value;
        if (family === KeyFamily.KV && tuple.length === 1) keys += 1;
        if (family === KeyFamily.MEMORY && tuple[1] === 'r') memories += 1;
      }
    }
    return { keys, memories };
  }

  async sample(): Promise<Map<string, TenantUsage>> {
    const out = new Map<string, TenantUsage>();
    const tenants = await this.deps.tenants();
    if (!tenants.ok) return out;
    const led = this.deps.leaderSpans();
    for (const { name, quotas } of tenants.value) {
      const wantBytes = quotas.storageBytes !== undefined;
      const wantCounts = quotas.keys !== undefined || quotas.memories !== undefined;
      if (!wantBytes && !wantCounts) continue;
      const prefix = keyPrefix(name);
      if (!prefix.ok) continue;
      const tenantSpan = prefixRange(prefix.value);
      const spans = led.flatMap((s) => overlap(s, tenantSpan) ?? []);
      let bytes = 0;
      if (wantBytes) for (const s of spans) bytes += await this.deps.sizer(s.start, s.end);
      const counts = wantCounts ? await this.#count(name, spans) : { keys: 0, memories: 0 };
      out.set(name, { bytes, ...counts });
    }
    return out;
  }
}
