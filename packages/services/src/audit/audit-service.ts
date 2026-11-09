import { create, fromBinary, fromJson, toJson } from '@bufbuild/protobuf';
import type { Clock, Counter, Logger, Metrics, MindlogError, Result } from '@mindlog/core';
import { SYSTEM_TENANT, err, mindlogError, ok } from '@mindlog/core';
import { replies } from '@mindlog/kv';
import type { AuditRecord, KvReply } from '@mindlog/proto';
import { AuditAppendSchema, AuditRecordSchema } from '@mindlog/proto';
import type { CommandStamper } from '@mindlog/statemachine';
import { auditDay, auditDayPrefix, auditKey, readAuditOutbox } from '@mindlog/statemachine';
import { MvccReader } from '@mindlog/storage';
import type { Placement, RangeCall, RangeRouter, RangeTarget } from '../kv/range-router.js';

export const AUDIT_OP_PREFIX = 'audit.';
export const AUDIT_CLUSTER_VERSION = 10;

/** One event as interfaces hand it in; the service stamps its id and time. */
export interface AuditEvent {
  readonly tenant: string;
  readonly principal: string;
  readonly actor?: string;
  readonly action: string;
  readonly resource: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface AuditEntry {
  readonly id: string;
  readonly tenant: string;
  readonly principal: string;
  readonly actor: string;
  readonly action: string;
  readonly resource: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly atMs: number;
}

export interface AuditServiceDeps {
  readonly router: RangeRouter;
  readonly stamper: CommandStamper;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly metrics: Metrics;
  /** Ranges this node currently leads, whose outboxes it drains. */
  readonly leaders: () => readonly bigint[];
  readonly clusterVersion: () => number;
  readonly ids: () => string;
  /** Each tenant's retention, for the expiry sweep. */
  readonly retention: () => Promise<ReadonlyArray<{ name: string; days: number }>>;
}

const MAX_QUEUE = 10_000;
const BATCH = 256;
const MAX_RETRIES = 4;
const RETRYABLE = new Set(['NOT_LEADER', 'RANGE_MOVED', 'UNAVAILABLE']);
const EXPIRE_LIMIT = 1_000;
const EXPIRE_EVERY_MS = 3_600_000;
const MAX_DAY_GAP = 366;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const entryOf = (r: AuditRecord): AuditEntry => ({
  id: r.id,
  tenant: r.tenant,
  principal: r.principal,
  actor: r.actor,
  action: r.action,
  resource: r.resource,
  ok: r.ok,
  detail: r.detail,
  atMs: Number(r.atMs),
});

interface ReadPage {
  readonly items: AuditEntry[];
  readonly after?: string;
}

/**
 * The audit log (PLAN 18.5, ADR-0037). Commands write an outbox row in their
 * own range; this service moves those rows to the tenant's audit family, takes
 * events that have no command (refused requests, admin changes), and serves reads.
 */
export class AuditService {
  readonly #queue: AuditRecord[] = [];
  readonly #dropped: Counter;
  readonly #written: Counter;
  #lastExpire = 0;

  constructor(private readonly deps: AuditServiceDeps) {
    this.#dropped = deps.metrics.counter({
      name: 'mindlog_audit_dropped_total',
      help: 'Audit events dropped because the queue was full',
    });
    this.#written = deps.metrics.counter({
      name: 'mindlog_audit_written_total',
      help: 'Audit records placed in a tenant audit family',
    });
  }

  /** Queues an event; bounded, so a flood of refusals cannot grow memory. */
  record(event: AuditEvent): void {
    if (this.#queue.length >= MAX_QUEUE) {
      this.#dropped.inc();
      return;
    }
    this.#queue.push(
      create(AuditRecordSchema, {
        tenant: event.tenant,
        id: this.deps.ids(),
        principal: event.principal,
        actor: event.actor ?? '',
        action: event.action,
        resource: event.resource,
        ok: event.ok,
        detail: event.detail ?? '',
        atMs: this.deps.clock.now(),
      }),
    );
  }

  #ready(): boolean {
    return this.deps.clusterVersion() >= AUDIT_CLUSTER_VERSION;
  }

  /** One pass: queued events, every led range's outbox, then expiry when due. */
  async tick(): Promise<void> {
    if (!this.#ready()) return;
    const batch = this.#queue.splice(0, BATCH);
    if (batch.length > 0 && !(await this.#place(batch))) this.#queue.unshift(...batch);
    for (const rangeId of this.deps.leaders()) await this.#drain(rangeId);
    const now = Number(this.deps.clock.now());
    if (now - this.#lastExpire >= EXPIRE_EVERY_MS) {
      this.#lastExpire = now;
      await this.#expire();
    }
  }

  async #drain(rangeId: bigint): Promise<void> {
    const local = this.deps.router.local(rangeId);
    if (!local) return;
    const pending = await readAuditOutbox(local.state, rangeId, BATCH);
    const last = pending.at(-1);
    if (!last || !(await this.#place(pending.map((p) => p.record)))) return;
    const command = this.deps.stamper.stamp(SYSTEM_TENANT, 'system:audit', {
      case: 'auditOutboxAck',
      value: { throughVersion: last.version },
    });
    const acked = await local.proposer.propose(command);
    if (!acked.ok) this.deps.logger.warn('audit ack failed', { error: acked.error.message });
  }

  async #place(records: readonly AuditRecord[]): Promise<boolean> {
    const groups = new Map<string, AuditRecord[]>();
    for (const r of records) {
      const key = `${r.tenant}\u0000${String(auditDay(r.atMs))}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    for (const group of groups.values()) {
      const placed = await this.#append(group);
      if (!placed.ok) {
        this.deps.logger.warn('audit append failed', { error: placed.error.message });
        return false;
      }
      this.#written.inc(group.length);
    }
    return true;
  }

  async #withRange<T>(
    key: Uint8Array,
    run: (p: Placement) => Promise<Result<T, MindlogError>>,
  ): Promise<Result<T, MindlogError>> {
    for (let attempt = 0; ; attempt++) {
      const placed = await this.deps.router.locate(key);
      const result = placed.ok ? await run(placed.value) : placed;
      if (result.ok || !RETRYABLE.has(result.error.code) || attempt >= MAX_RETRIES) return result;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      if (placed.ok && this.deps.router.refresh) await this.deps.router.refresh(placed.value);
    }
  }

  async #proposeOn(
    target: RangeTarget,
    body: Parameters<CommandStamper['stamp']>[2],
  ): Promise<Result<void, MindlogError>> {
    const proposed = await target.proposer.propose(
      this.deps.stamper.stamp(SYSTEM_TENANT, 'system:audit', body),
    );
    if (!proposed.ok) return proposed;
    const { outcome } = proposed.value.result;
    return outcome.case === 'error'
      ? err(mindlogError(outcome.value.code as MindlogError['code'], outcome.value.message))
      : ok(undefined);
  }

  #append(records: readonly AuditRecord[]): Promise<Result<void, MindlogError>> {
    const first = records[0] as AuditRecord;
    const key = auditKey(first.tenant, first.atMs, first.id);
    const message = create(AuditAppendSchema, { records: [...records] });
    return this.#withRange(key, async (placement) => {
      if (placement.local)
        return this.#proposeOn(placement.local, { case: 'auditAppend', value: message });
      const reply = await this.deps.router.forward(placement, this.#caller(), {
        kind: 'memory',
        op: `${AUDIT_OP_PREFIX}append`,
        json: JSON.stringify(toJson(AuditAppendSchema, message)),
      });
      return reply.ok ? fromReply(reply.value) : reply;
    });
  }

  #caller() {
    return { tenant: SYSTEM_TENANT, principal: 'system:audit' };
  }

  async #readDay(
    target: RangeTarget,
    prefix: Uint8Array,
    after: string | undefined,
    limit: number,
  ): Promise<Result<ReadPage, MindlogError>> {
    const ready = await target.readBarrier.read('lease');
    if (!ready.ok) return ready;
    const items: AuditEntry[] = [];
    let last: Uint8Array | undefined;
    const from = after ? Buffer.from(after, 'base64url') : undefined;
    for await (const { key, value } of new MvccReader(target.reader).scan(prefix, {
      reverse: true,
      limit,
      ...(from ? { before: new Uint8Array(from) } : {}),
    })) {
      items.push(entryOf(fromBinary(AuditRecordSchema, value)));
      last = key;
    }
    return ok({
      items,
      ...(last && items.length === limit ? { after: Buffer.from(last).toString('base64url') } : {}),
    });
  }

  /**
   * Newest first. A cursor is `day:key`, so a page resumes inside a day and
   * then walks back through older days, stopping at the retention window.
   */
  async read(
    tenant: string,
    options: { limit: number; cursor?: string; retentionDays: number },
  ): Promise<Result<{ items: AuditEntry[]; cursor?: string }, MindlogError>> {
    const today = auditDay(this.deps.clock.now());
    const [dayPart, afterPart] = options.cursor?.split(':') ?? [];
    let day = dayPart ? BigInt(dayPart) : today;
    let after = afterPart || undefined;
    const oldest = today - BigInt(Math.min(options.retentionDays, MAX_DAY_GAP));
    const items: AuditEntry[] = [];
    for (; day >= oldest && items.length < options.limit; day--, after = undefined) {
      const page = await this.#page(tenant, day, after, options.limit - items.length);
      if (!page.ok) return page;
      items.push(...page.value.items);
      if (page.value.after) return ok({ items, cursor: `${String(day)}:${page.value.after}` });
    }
    return ok({
      items,
      ...(day >= oldest && items.length >= options.limit ? { cursor: `${String(day)}:` } : {}),
    });
  }

  #page(
    tenant: string,
    day: bigint,
    after: string | undefined,
    limit: number,
  ): Promise<Result<ReadPage, MindlogError>> {
    const prefix = auditDayPrefix(tenant, day);
    return this.#withRange(prefix, async (placement) => {
      if (placement.local) return this.#readDay(placement.local, prefix, after, limit);
      const reply = await this.deps.router.forward(placement, this.#caller(), {
        kind: 'memory',
        op: `${AUDIT_OP_PREFIX}read`,
        json: JSON.stringify({ tenant, day: String(day), after, limit }),
      });
      if (!reply.ok) return reply;
      const value = reply.value.kind;
      if (value.case === 'error')
        return err(mindlogError(value.value.code as MindlogError['code'], value.value.message));
      if (value.case !== 'bulk') return err(mindlogError('INTERNAL', 'bad audit reply'));
      return ok(JSON.parse(decoder.decode(value.value)) as ReadPage);
    });
  }

  async #expire(): Promise<void> {
    const tenants = await this.deps.retention();
    const today = auditDay(this.deps.clock.now());
    for (const { name, days } of tenants) {
      // A window behind the cutoff: the sweep runs hourly, so older days are already gone.
      for (let back = BigInt(days) + 1n; back <= BigInt(days) + 7n; back++) {
        const day = today - back;
        const prefix = auditDayPrefix(name, day);
        const done = await this.#withRange(prefix, async (placement) => {
          if (placement.local)
            return this.#proposeOn(placement.local, {
              case: 'auditExpire',
              value: { tenant: name, day, limit: EXPIRE_LIMIT },
            });
          // Led by another node, whose own sweep covers it.
          return ok(undefined);
        });
        if (!done.ok) this.deps.logger.warn('audit expiry failed', { error: done.error.message });
      }
    }
  }

  /** Runs an audit call another node forwarded here. */
  async forwarded(rangeId: bigint, call: RangeCall): Promise<KvReply> {
    if (call.kind !== 'memory') return replies.error('INVALID_ARGUMENT', 'not an audit call');
    const target = this.deps.router.local(rangeId);
    if (!target)
      return replies.error('RANGE_MOVED', `this node holds no replica of range ${String(rangeId)}`);
    if (call.op === `${AUDIT_OP_PREFIX}append`) {
      const value = fromJson(AuditAppendSchema, JSON.parse(call.json) as never);
      const done = await this.#proposeOn(target, { case: 'auditAppend', value });
      return done.ok ? replies.ok() : replies.error(done.error.code, done.error.message);
    }
    if (call.op === `${AUDIT_OP_PREFIX}read`) {
      const q = JSON.parse(call.json) as {
        tenant: string;
        day: string;
        after?: string;
        limit: number;
      };
      const page = await this.#readDay(
        target,
        auditDayPrefix(q.tenant, BigInt(q.day)),
        q.after,
        q.limit,
      );
      return page.ok
        ? replies.bulk(encoder.encode(JSON.stringify(page.value)))
        : replies.error(page.error.code, page.error.message);
    }
    return replies.error('INVALID_ARGUMENT', `unknown audit operation ${call.op}`);
  }
}

function fromReply(reply: KvReply): Result<void, MindlogError> {
  return reply.kind.case === 'error'
    ? err(mindlogError(reply.kind.value.code as MindlogError['code'], reply.kind.value.message))
    : ok(undefined);
}
