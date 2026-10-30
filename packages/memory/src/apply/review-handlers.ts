import type { MemoryRecord } from '@mindlog/proto';
import type { ApplyHandler } from '@mindlog/statemachine';
import { errorResult } from '@mindlog/statemachine';
import type { Trust } from '../types.js';
import { readConflict, readRecord, rewriteRecord, writeConflict } from './conflict-writes.js';
import { bumpGeneration, writeIndexTime } from './index-writes.js';
import { countWrites, maskOnBranch, spaceOf } from './branch-handlers.js';
import { outcome, outsideRange } from './results.js';

const TRUST = new Set<string>(['verified', 'normal', 'quarantined'] satisfies Trust[]);

/** Ends a fact's validity at `at` (ms) unless it already ended earlier. */
function end(r: MemoryRecord, at: bigint): boolean {
  if (r.expiredAt !== 0n || (r.validTo !== 0n && r.validTo <= at)) return false;
  r.validTo = at;
  return true;
}

function release(r: MemoryRecord): boolean {
  if (r.trust !== 'quarantined') return false;
  r.trust = 'normal';
  return true;
}

/**
 * `ConflictResolve` (ADR-0015): the loser's validity ends, the winner leaves
 * quarantine; `both` keeps both, optionally as a change at `validFrom`.
 */
export const conflictResolveHandler: ApplyHandler = {
  body: 'conflictResolve',
  async apply(ctx) {
    if (ctx.command.body.case !== 'conflictResolve')
      throw new Error('conflictResolve got another body');
    const { user, id, keep, validFrom, nowMs } = ctx.command.body.value;
    const { tenant } = ctx.command;
    const moved = outsideRange(ctx, user);
    if (moved) return moved;
    if (ctx.command.branch !== '' && ctx.command.branch !== 'main')
      return errorResult('INVALID_ARGUMENT', 'resolve conflicts on main');
    if (keep !== 'a' && keep !== 'b' && keep !== 'both')
      return errorResult('INVALID_ARGUMENT', 'keep must be a, b or both');
    const conflict = await readConflict(ctx, tenant, user, id);
    if (!conflict) return errorResult('NOT_FOUND', `no conflict ${id}`);
    if (conflict.status !== 'open')
      return errorResult('CONFLICT', `conflict ${id} is already resolved`);
    const a = await readRecord(ctx, tenant, user, conflict.a);
    const b = await readRecord(ctx, tenant, user, conflict.b);
    // Each changed record, and whether its trust changed (its vector row follows).
    const changed: Array<[MemoryRecord, boolean]> = [];
    const touch = (r: MemoryRecord, ended: boolean, released: boolean) => {
      if (ended || released) changed.push([r, released]);
    };
    if (keep === 'a') {
      if (b) touch(b, end(b, nowMs), false);
      if (a) touch(a, false, release(a));
    } else if (keep === 'b') {
      if (a) touch(a, end(a, nowMs), false);
      if (b) touch(b, false, release(b));
    } else {
      if (a) touch(a, validFrom !== 0n && end(a, validFrom), release(a));
      if (b) {
        const starts = validFrom !== 0n && b.validFrom !== validFrom;
        if (starts) b.validFrom = validFrom;
        touch(b, starts, release(b));
      }
    }
    for (const [r, trust] of changed) await rewriteRecord(ctx, tenant, user, r, trust);
    conflict.status = 'resolved';
    conflict.keep = keep;
    conflict.resolvedBy = ctx.command.principal;
    conflict.resolvedAt = ctx.version;
    writeConflict(ctx, tenant, user, conflict);
    await bumpGeneration(ctx, tenant, user);
    writeIndexTime(ctx, tenant, user);
    return outcome(changed.map(([r]) => r.id));
  },
};

/** `MemoryTrust` (PLAN 13.4): sets the trust of current memories; others are skipped. */
export const memoryTrustHandler: ApplyHandler = {
  body: 'memoryTrust',
  async apply(ctx) {
    if (ctx.command.body.case !== 'memoryTrust') throw new Error('memoryTrust got another body');
    const { user, ids, trust } = ctx.command.body.value;
    const { tenant } = ctx.command;
    const moved = outsideRange(ctx, user);
    if (moved) return moved;
    if (!TRUST.has(trust)) return errorResult('INVALID_ARGUMENT', `unknown trust ${trust}`);
    const space = await spaceOf(ctx, tenant, user);
    if (!('root' in space)) return space;
    const { root, branch } = space;
    const targets = new Set(ids);
    if (branch && branch.writes + targets.size > branch.maxWrites)
      return errorResult(
        'PAYLOAD_TOO_LARGE',
        `branch ${branch.name} holds at most ${String(branch.maxWrites)} memories`,
      );
    const changed: string[] = [];
    let masked = 0;
    for (const id of targets) {
      const r = await readRecord(ctx, tenant, root, id);
      const own = branch === undefined || (r && !(await readRecord(ctx, tenant, user, id)));
      if (own) {
        if (!r || r.expiredAt !== 0n || r.trust === trust) continue;
        r.trust = trust;
        await rewriteRecord(ctx, tenant, root, r, true);
        changed.push(id);
      } else {
        // A main memory, re-trusted only as the branch sees it (ADR-0013).
        if (r && (r.expiredAt !== 0n || r.trust === trust)) continue;
        const retrust = (x: MemoryRecord) => {
          x.trust = trust;
        };
        if (await maskOnBranch(ctx, tenant, user, branch.name, branch, id, retrust)) {
          changed.push(id);
          masked++;
        }
      }
    }
    if (branch && masked > 0) countWrites(ctx, tenant, user, branch, masked);
    if (changed.length > 0) {
      await bumpGeneration(ctx, tenant, root);
      if (!branch) writeIndexTime(ctx, tenant, user);
    }
    return outcome(changed);
  },
};
