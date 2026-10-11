// ILLEGAL: wall-clock time and ambient randomness inside deterministic apply code.
export function applyPut(): number {
  const stamp = Date.now();
  const jitter = Math.random();
  const when = new Date();
  return stamp + jitter + when.getTime();
}
