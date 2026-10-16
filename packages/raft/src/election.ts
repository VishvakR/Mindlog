import { MessageType } from '@mindlog/proto';
import type { Raft } from './raft.js';
import { TRANSFER_CONTEXT } from './raft.js';

/** Starts an election when allowed (etcd `hup`); `transfer` skips PreVote. */
export function hup(r: Raft, transfer: boolean): void {
  if (r.role === 'leader' || !r.promotable() || r.hasUnappliedConfChanges()) return;
  if (r.cfg.preVote && !transfer) campaign(r, 'pre', false);
  else campaign(r, 'elect', transfer);
}

/** Becomes (pre-)candidate, votes for itself and asks every other voter. */
export function campaign(r: Raft, kind: 'pre' | 'elect', transfer: boolean): void {
  let type: MessageType;
  let term: bigint;
  if (kind === 'pre') {
    r.becomePreCandidate();
    type = MessageType.PRE_VOTE;
    term = r.term + 1n;
  } else {
    r.becomeCandidate();
    type = MessageType.VOTE;
    term = r.term;
  }
  if (r.poll(r.id, true) === 'won') {
    // A single voter wins at once.
    if (kind === 'pre') campaign(r, 'elect', transfer);
    else becomeLeaderAndReplicate(r);
    return;
  }
  for (const id of [...r.voters].sort((a, b) => (a < b ? -1 : 1))) {
    if (id === r.id) continue;
    r.send({
      type,
      to: id,
      term,
      index: r.log.lastIndex(),
      logTerm: r.log.lastTerm(),
      context: transfer ? TRANSFER_CONTEXT : new Uint8Array(),
    });
  }
}

export function becomeLeaderAndReplicate(r: Raft): void {
  r.becomeLeader();
  r.bcastAppend();
}
