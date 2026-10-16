/** One operation on a register (a Redis string key) as a client saw it. */
export interface RegisterOp {
  readonly kind: 'read' | 'write' | 'cas';
  /** read: the value seen; write: the value written; cas: the new value. */
  readonly value: string | null;
  /** cas only: the expected current value. */
  readonly from?: string;
  /** `fail` for a cas that reported a mismatch; `unknown` when the outcome is indefinite. */
  readonly outcome: 'ok' | 'fail' | 'unknown';
  readonly invoke: number;
  /** Infinity when the outcome is unknown. */
  readonly complete: number;
}

/**
 * Wing–Gong search for a linearization of one register's history
 * (PLAN 22.2). Operations with an unknown outcome may take effect at any
 * point after their invocation, or never. Returns undefined when the history
 * is linearizable, otherwise a short explanation.
 */
export function checkRegister(
  ops: readonly RegisterOp[],
  initial: string | null = null,
): string | undefined {
  const sorted = [...ops].sort((a, b) => a.invoke - b.invoke);
  const n = sorted.length;
  const required = sorted.reduce(
    (mask, op, i) => (op.outcome === 'unknown' ? mask : mask | (1n << BigInt(i))),
    0n,
  );
  const seen = new Set<string>();

  const search = (done: bigint, state: string | null): boolean => {
    if ((done & required) === required) return true;
    const key = `${done.toString(36)}|${state ?? '\u0000'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    // Real-time order: an op can go next only if it was invoked before every
    // pending definite op completed.
    let horizon = Infinity;
    for (let i = 0; i < n; i++) {
      const op = sorted[i] as RegisterOp;
      if (!(done & (1n << BigInt(i))) && op.outcome !== 'unknown' && op.complete < horizon)
        horizon = op.complete;
    }
    for (let i = 0; i < n; i++) {
      const bit = 1n << BigInt(i);
      const op = sorted[i] as RegisterOp;
      if (done & bit || op.invoke > horizon) continue;
      const next = step(op, state);
      if (next !== INVALID && search(done | bit, next)) return true;
    }
    return false;
  };

  return search(0n, initial) ? undefined : `no linearization of ${n} operations`;
}

const INVALID = Symbol('invalid');

function step(op: RegisterOp, state: string | null): string | null | typeof INVALID {
  switch (op.kind) {
    case 'read':
      return op.value === state ? state : INVALID;
    case 'write':
      return op.value;
    case 'cas':
      if (op.outcome === 'fail') return state === op.from ? INVALID : state;
      if (op.outcome === 'ok') return state === op.from ? op.value : INVALID;
      // Unknown: if it applied, it only changed a matching value.
      return state === op.from ? op.value : INVALID;
  }
}
