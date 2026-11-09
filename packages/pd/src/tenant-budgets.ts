/** One store's report for one tenant (`StoreStats.tenants`). */
export interface StoreTenantStats {
  readonly tenant: string;
  readonly writeQps: number;
  readonly recallQps: number;
  readonly bytes: bigint;
  readonly keys: bigint;
  readonly memories: bigint;
}

export interface Budget {
  readonly tenant: string;
  readonly share: number;
  readonly bytes: bigint;
  readonly keys: bigint;
  readonly memories: bigint;
}

/** Split evenly across stores, so a node with no traffic yet can still admit some. */
const FLOOR = 0.1;

/**
 * Each store's budgets (PLAN 18.3): a tenant's rate limit is divided among the
 * live stores by their recent demand, with a small equal floor; its usage is
 * the sum of what each store's led ranges hold. Shares of a tenant sum to 1.
 */
export function tenantBudgets(
  stores: ReadonlyMap<bigint, readonly StoreTenantStats[]>,
): Map<bigint, Budget[]> {
  const n = stores.size;
  const totals = new Map<string, Omit<Budget, 'tenant' | 'share'> & { demand: number }>();
  for (const stats of stores.values()) {
    for (const s of stats) {
      const t = totals.get(s.tenant) ?? { bytes: 0n, keys: 0n, memories: 0n, demand: 0 };
      totals.set(s.tenant, {
        bytes: t.bytes + s.bytes,
        keys: t.keys + s.keys,
        memories: t.memories + s.memories,
        demand: t.demand + s.writeQps + s.recallQps,
      });
    }
  }
  const out = new Map<bigint, Budget[]>();
  for (const [store, stats] of stores) {
    const own = new Map(stats.map((s) => [s.tenant, s.writeQps + s.recallQps]));
    out.set(
      store,
      [...totals].map(([tenant, { bytes, keys, memories, demand }]) => ({
        tenant,
        share: demand === 0 ? 1 / n : FLOOR / n + (1 - FLOOR) * ((own.get(tenant) ?? 0) / demand),
        bytes,
        keys,
        memories,
      })),
    );
  }
  return out;
}
