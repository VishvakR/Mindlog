import type { TenantGovernor, TenantService, TenantUsage } from '@mindlog/services';
import { UsageSampler } from '@mindlog/services';
import type { NodeCore } from './open-node-core.js';

const SAMPLE_MS = 30_000;

/**
 * Samples tenant usage and exchanges it with the placement driver, which
 * totals it across nodes and sets each node's rate-limit share. Without a
 * placement driver this node's own numbers are the totals.
 */
export function trackTenantUsage(
  core: NodeCore,
  tenants: TenantService,
  governor: TenantGovernor,
): () => void {
  const sampler = new UsageSampler({
    tenants: () => tenants.list(),
    state: core.stateStore,
    sizer: (start, end) => core.sizer.approximateSize(start, end),
    leaderSpans: () =>
      core.store
        .replicas()
        .filter((r) => r.rangeId !== 0n && r.initialised && r.isLeader())
        .map((r) => ({ start: r.descriptor.startKey, end: r.descriptor.endKey })),
  });
  let usage = new Map<string, TenantUsage>();
  let running = false;
  const sample = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      usage = await sampler.sample();
      if (!core.agent)
        governor.applyBudgets([...usage].map(([tenant, u]) => ({ tenant, share: 1, ...u })));
    } finally {
      running = false;
    }
  };
  core.agent?.attachTenants({
    report: () => {
      const demand = new Map(governor.drainDemand().map((d) => [d.tenant, d]));
      return [...new Set([...demand.keys(), ...usage.keys()])].map((tenant) => {
        const u = usage.get(tenant);
        return {
          tenant,
          writeQps: demand.get(tenant)?.writeQps ?? 0,
          recallQps: demand.get(tenant)?.recallQps ?? 0,
          bytes: BigInt(u?.bytes ?? 0),
          keys: BigInt(u?.keys ?? 0),
          memories: BigInt(u?.memories ?? 0),
        };
      });
    },
    apply: (budgets) => {
      governor.applyBudgets(
        budgets.map((b) => ({
          tenant: b.tenant,
          share: b.share,
          bytes: Number(b.bytes),
          keys: Number(b.keys),
          memories: Number(b.memories),
        })),
      );
    },
  });
  void sample();
  const timer = setInterval(() => void sample(), SAMPLE_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
