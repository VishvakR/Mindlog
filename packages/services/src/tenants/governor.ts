import { RateLimiter } from '@mindlog/auth';
import type { Clock, Counter, Gauge, Metrics, MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { Quotas } from './schemas.js';
import type { TenantRecord } from './tenant-service.js';

/** What a request costs: `free` covers deletes, so a tenant at its quota can make room. */
export type AdmitClass = 'write' | 'memory' | 'recall' | 'free';

/** Approximate usage of one tenant, totalled across the cluster by the placement driver. */
export interface TenantUsage {
  readonly bytes: number;
  readonly keys: number;
  readonly memories: number;
}

export interface TenantDemand {
  readonly tenant: string;
  readonly writeQps: number;
  readonly recallQps: number;
}

export interface TenantBudget extends TenantUsage {
  readonly tenant: string;
  /** This node's fraction of the tenant's cluster-wide rate limits (PLAN 18.3). */
  readonly share: number;
}

const MAX_TENANTS = 4_096;
const HOUR_S = 3_600;

const exceeded = (what: string) =>
  mindlogError('QUOTA_EXCEEDED', `This tenant has used its ${what} quota.`);

/**
 * Per-tenant admission (PLAN 18.3): fast rejects before a request reaches a
 * range. Rate limits are local token buckets scaled by this node's share of
 * the tenant's limit, which the placement driver recomputes from each node's
 * demand. Usage totals are approximate and only as fresh as the last sample.
 */
export class TenantGovernor {
  readonly #limiter = new RateLimiter({ burst: 1, perSecond: 1, maxKeys: MAX_TENANTS * 3 });
  readonly #budgets = new Map<string, TenantBudget>();
  readonly #demand = new Map<string, { write: number; recall: number }>();
  readonly #connections = new Map<string, number>();
  #demandSince: number;
  readonly #rejected: Counter;
  readonly #limited: Counter;
  readonly #usage: Gauge;

  constructor(
    private readonly deps: {
      readonly tenant: (name: string) => Promise<Result<TenantRecord | undefined, MindlogError>>;
      readonly clock: Clock;
      readonly metrics: Metrics;
    },
  ) {
    this.#demandSince = Number(deps.clock.now());
    this.#rejected = deps.metrics.counter({
      name: 'mindlog_tenant_quota_rejections_total',
      help: 'Requests refused because a tenant is at a quota, by tenant and quota',
      labelNames: ['tenant', 'quota'],
    });
    this.#limited = deps.metrics.counter({
      name: 'mindlog_tenant_rate_limited_total',
      help: 'Requests refused by a tenant rate limit, by tenant and class',
      labelNames: ['tenant', 'class'],
    });
    this.#usage = deps.metrics.gauge({
      name: 'mindlog_tenant_quota_usage_count',
      help: 'Approximate usage of a tenant, by tenant and quota',
      labelNames: ['tenant', 'quota'],
    });
  }

  #share(tenant: string): number {
    return this.#budgets.get(tenant)?.share ?? 1;
  }

  #rate(key: string, qps: number, share: number, now: number): boolean {
    const perSecond = qps * share;
    return this.#limiter.take(key, now, { burst: Math.max(perSecond, 1), perSecond });
  }

  #refuse(tenant: string, quota: string): Result<void, MindlogError> {
    this.#rejected.inc(1, { tenant, quota });
    return err(exceeded(quota));
  }

  #storage(tenant: string, cls: AdmitClass, q: Quotas): Result<void, MindlogError> {
    const used = this.#budgets.get(tenant);
    if (!used) return ok(undefined);
    if (q.storageBytes !== undefined && used.bytes >= q.storageBytes)
      return this.#refuse(tenant, 'storage');
    if (cls === 'write' && q.keys !== undefined && used.keys >= q.keys)
      return this.#refuse(tenant, 'keys');
    if (cls === 'memory' && q.memories !== undefined && used.memories >= q.memories)
      return this.#refuse(tenant, 'memories');
    return ok(undefined);
  }

  #count(tenant: string, cls: AdmitClass): void {
    const d = this.#demand.get(tenant) ?? { write: 0, recall: 0 };
    if (cls === 'recall') d.recall += 1;
    else d.write += 1;
    this.#demand.set(tenant, d);
  }

  /** Admits or refuses one request. A tenant with no row or no quotas passes untouched. */
  async admit(tenant: string, cls: AdmitClass): Promise<Result<void, MindlogError>> {
    if (cls === 'free') return ok(undefined);
    const record = await this.deps.tenant(tenant);
    if (!record.ok) return record;
    const quotas = record.value?.info.quotas;
    if (!quotas || Object.keys(quotas).length === 0) return ok(undefined);
    this.#count(tenant, cls);
    const now = Number(this.deps.clock.now());
    const share = this.#share(tenant);
    const qps = cls === 'recall' ? quotas.recallQps : quotas.writeQps;
    if (
      qps !== undefined &&
      !this.#rate(`${cls === 'recall' ? 'r' : 'w'}:${tenant}`, qps, share, now)
    ) {
      this.#limited.inc(1, { tenant, class: cls });
      return err(
        mindlogError('RATE_LIMITED', 'This tenant is over its request rate.', {
          retryAfterMs: 100,
        }),
      );
    }
    if (quotas.modelSecondsPerHour !== undefined && !this.#modelsLeft(tenant, quotas, now))
      return this.#refuse(tenant, 'model seconds');
    return cls === 'recall' ? ok(undefined) : this.#storage(tenant, cls, quotas);
  }

  #modelBucket(tenant: string, quotas: Quotas) {
    const perHourMs = (quotas.modelSecondsPerHour ?? 0) * 1000;
    return { burst: perHourMs, perSecond: (perHourMs / HOUR_S) * this.#share(tenant) };
  }

  #modelsLeft(tenant: string, quotas: Quotas, now: number): boolean {
    return this.#limiter.peek(`m:${tenant}`, now, this.#modelBucket(tenant, quotas));
  }

  /** Records model time a request used; the bucket may go negative and refuse the next one. */
  async spendModel(tenant: string, ms: number): Promise<void> {
    const record = await this.deps.tenant(tenant);
    const quotas = record.ok ? record.value?.info.quotas : undefined;
    if (quotas?.modelSecondsPerHour === undefined) return;
    this.#limiter.charge(
      `m:${tenant}`,
      Number(this.deps.clock.now()),
      this.#modelBucket(tenant, quotas),
      ms,
    );
  }

  /** Takes a connection slot; the returned function gives it back exactly once. */
  async acquireConnection(tenant: string): Promise<Result<() => void, MindlogError>> {
    const record = await this.deps.tenant(tenant);
    if (!record.ok) return record;
    const limit = record.value?.info.quotas.connections;
    const open = this.#connections.get(tenant) ?? 0;
    if (limit !== undefined && open >= limit) {
      this.#rejected.inc(1, { tenant, quota: 'connections' });
      return err(exceeded('connections'));
    }
    this.#connections.set(tenant, open + 1);
    let released = false;
    return ok(() => {
      if (released) return;
      released = true;
      const left = (this.#connections.get(tenant) ?? 1) - 1;
      if (left > 0) this.#connections.set(tenant, left);
      else this.#connections.delete(tenant);
    });
  }

  /** Request rates per tenant since the last call, for the store heartbeat. */
  drainDemand(): TenantDemand[] {
    const now = Number(this.deps.clock.now());
    const seconds = Math.max((now - this.#demandSince) / 1000, 0.001);
    this.#demandSince = now;
    const out = [...this.#demand].map(([tenant, d]) => ({
      tenant,
      writeQps: d.write / seconds,
      recallQps: d.recall / seconds,
    }));
    this.#demand.clear();
    return out;
  }

  /** Installs what the placement driver computed. */
  applyBudgets(budgets: readonly TenantBudget[]): void {
    this.#budgets.clear();
    for (const b of budgets) {
      this.#budgets.set(b.tenant, b);
      this.#usage.set(b.bytes, { tenant: b.tenant, quota: 'storage' });
      this.#usage.set(b.keys, { tenant: b.tenant, quota: 'keys' });
      this.#usage.set(b.memories, { tenant: b.tenant, quota: 'memories' });
    }
  }

  /** Last known usage of a tenant, for the dashboard. */
  usage(tenant: string): TenantUsage | undefined {
    return this.#budgets.get(tenant);
  }
}
