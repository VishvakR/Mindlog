export type VoteResult = 'won' | 'lost' | 'pending';

/** Smallest number of voters that is a majority. */
export const quorumSize = (voters: number): number => Math.floor(voters / 2) + 1;

/**
 * Highest value that a majority of voters have reached: the commit index when
 * fed match indexes, the lease start when fed echoed ticks. 0 with no voters.
 */
export function quorumValue(voters: ReadonlySet<bigint>, valueOf: (id: bigint) => bigint): bigint {
  if (voters.size === 0) return 0n;
  const values = [...voters].map(valueOf).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return values[quorumSize(voters.size) - 1] ?? 0n;
}

/** Outcome of an election (or of ReadIndex acks) given the answers so far. */
export function voteResult(
  voters: ReadonlySet<bigint>,
  votes: ReadonlyMap<bigint, boolean>,
): VoteResult {
  if (voters.size === 0) return 'won';
  let granted = 0;
  let rejected = 0;
  for (const id of voters) {
    const vote = votes.get(id);
    if (vote === true) granted++;
    else if (vote === false) rejected++;
  }
  const need = quorumSize(voters.size);
  if (granted >= need) return 'won';
  if (voters.size - rejected >= need) return 'pending';
  return 'lost';
}
