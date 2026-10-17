import { create } from '@bufbuild/protobuf';
import type { NodeInfo, Operator, OperatorStep } from '@mindlog/proto';
import { OperatorSchema, OperatorStepSchema, ReplicaRole, StepKind } from '@mindlog/proto';
import type { PdConfig, PlannedOperator, PlannedStep, RangeView } from './cluster-view.js';

const KIND = {
  'add-learner': StepKind.ADD_LEARNER,
  promote: StepKind.PROMOTE,
  'transfer-leader': StepKind.TRANSFER_LEADER,
  'remove-voter': StepKind.REMOVE_VOTER,
  split: StepKind.SPLIT,
  merge: StepKind.MERGE,
} as const;

/** Hands out ids from PD's replicated counter. */
export type IdSource = (count: number) => Promise<bigint>;

interface Running {
  op: Operator;
  /** Epoch version of the range when the operator started (a split is done once it grows). */
  startVersion: bigint;
}

/**
 * Operators in flight (PLAN 8.3). PD never changes ranges itself: it hands
 * the current step to the range's leader in the reply to a range heartbeat,
 * and treats a step as done when a later heartbeat shows its effect (as
 * TiKV PD's `IsFinish`), so steps are idempotent and a lost reply is harmless.
 * At most one operator runs per range.
 */
export class OperatorController {
  readonly #config: PdConfig;
  readonly #ids: IdSource;
  readonly #running = new Map<bigint, Running>();
  readonly #finished: Operator[] = [];

  constructor(config: PdConfig, ids: IdSource) {
    this.#config = config;
    this.#ids = ids;
  }

  /** Ranges that have an operator. */
  busy(): Set<bigint> {
    return new Set(this.#running.keys());
  }

  list(): Operator[] {
    return [...this.#running.values()].map((r) => r.op);
  }

  /** Operators that finished or were cancelled since the last call. */
  takeFinished(): Operator[] {
    return this.#finished.splice(0);
  }

  /**
   * Starts an operator from a scheduler's plan, allocating the ids of the
   * replicas and ranges it creates. `undefined` when the range is busy or the
   * cluster-wide limit is reached.
   */
  async add(
    planned: PlannedOperator,
    scheduler: string,
    range: RangeView,
    nowMs: number,
    nodes: ReadonlyMap<bigint, NodeInfo>,
  ): Promise<Operator | undefined> {
    if (this.#running.has(planned.rangeId) || this.#running.size >= this.#config.maxOperators)
      return undefined;
    const newReplica = planned.steps.some((s) => s.kind === 'add-learner');
    const newRange = planned.steps.some((s) => s.kind === 'split');
    const id = await this.#ids(1 + Number(newReplica) + Number(newRange));
    const next = id + 1n;
    const replicaId = newReplica ? next : 0n;
    const newRangeId = newRange ? next + (newReplica ? 1n : 0n) : 0n;
    const steps = planned.steps.map((s) => this.#step(s, replicaId, newRangeId, nodes));
    // Re-check: another add may have run while ids were being allocated.
    if (this.#running.has(planned.rangeId)) return undefined;
    const op = create(OperatorSchema, {
      id,
      rangeId: planned.rangeId,
      scheduler,
      steps,
      step: 0,
      explanation: planned.explanation,
      createdMs: BigInt(nowMs),
      status: 'running',
    });
    this.#running.set(planned.rangeId, { op, startVersion: range.range.epoch?.version ?? 0n });
    return op;
  }

  /**
   * A range leader reported. Skips the steps whose effect is visible and
   * returns the operator positioned at the first step left, or `undefined`
   * when there is none or the operator just finished.
   */
  onHeartbeat(rv: RangeView, nowMs: number): Operator | undefined {
    const running = this.#running.get(rv.range.rangeId);
    if (!running) return undefined;
    const { op } = running;
    if (nowMs - Number(op.createdMs) > this.#config.operatorTimeoutMs) {
      this.#end(rv.range.rangeId, 'timeout');
      return undefined;
    }
    while (op.step < op.steps.length && this.#done(op.steps[op.step] as OperatorStep, rv, running))
      op.step++;
    if (op.step >= op.steps.length) {
      this.#end(rv.range.rangeId, 'done');
      return undefined;
    }
    return op;
  }

  /** Drops operators of ranges that no longer exist (a merge finished) and any past the timeout. */
  sweep(existing: ReadonlySet<bigint>, nowMs: number): void {
    for (const [rangeId, { op }] of [...this.#running]) {
      if (!existing.has(rangeId))
        this.#end(rangeId, op.steps.some((s) => s.kind === StepKind.MERGE) ? 'done' : 'cancelled');
      else if (nowMs - Number(op.createdMs) > this.#config.operatorTimeoutMs)
        this.#end(rangeId, 'timeout');
    }
  }

  cancel(rangeId: bigint): void {
    if (this.#running.has(rangeId)) this.#end(rangeId, 'cancelled');
  }

  #end(rangeId: bigint, status: string): void {
    const running = this.#running.get(rangeId);
    if (!running) return;
    this.#running.delete(rangeId);
    running.op.status = status;
    this.#finished.push(running.op);
  }

  #step(
    s: PlannedStep,
    replicaId: bigint,
    newRangeId: bigint,
    nodes: ReadonlyMap<bigint, NodeInfo>,
  ): OperatorStep {
    const nodeId = s.nodeId ?? 0n;
    return create(OperatorStepSchema, {
      kind: KIND[s.kind],
      replicaId:
        s.kind === 'add-learner' || (s.kind === 'promote' && !s.replicaId)
          ? replicaId
          : (s.replicaId ?? 0n),
      nodeId,
      address: nodes.get(nodeId)?.address ?? '',
      newRangeId: s.kind === 'split' ? newRangeId : (s.targetRange ?? 0n),
    });
  }

  #done(step: OperatorStep, rv: RangeView, running: Running): boolean {
    const replicas = rv.range.replicas;
    switch (step.kind) {
      case StepKind.ADD_LEARNER:
        return replicas.some((r) => r.replicaId === step.replicaId);
      case StepKind.PROMOTE:
        return replicas.some((r) => r.replicaId === step.replicaId && r.role === ReplicaRole.VOTER);
      case StepKind.TRANSFER_LEADER:
        return rv.leaderReplicaId === step.replicaId;
      case StepKind.REMOVE_VOTER:
        return !replicas.some((r) => r.replicaId === step.replicaId);
      case StepKind.SPLIT:
        return (rv.range.epoch?.version ?? 0n) > running.startVersion;
      default:
        return false;
    }
  }
}
