import type { Message } from '@mindlog/proto';
import { MessageType } from '@mindlog/proto';
import type { Raft } from './raft.js';
import { voteResponseType } from './raft.js';
import { stepCandidate } from './step-candidate.js';
import { stepFollower } from './step-follower.js';
import { stepLeader } from './step-leader.js';

const isVote = (t: MessageType): boolean => t === MessageType.VOTE || t === MessageType.PRE_VOTE;

/** Term handling and votes common to every role, then the role's own step (etcd `Step`). */
export function step(r: Raft, m: Message): void {
  if (m.term > r.term) {
    if (isVote(m.type) && !r.isTransferContext(m.context) && r.inLease()) return;
    if (m.type === MessageType.PRE_VOTE) {
      // Never change term on a pre-vote.
    } else if (m.type === MessageType.PRE_VOTE_RESPONSE && !m.reject) {
      // The granted pre-vote carries the future term; counted below.
    } else {
      const fromLeader =
        m.type === MessageType.APPEND ||
        m.type === MessageType.HEARTBEAT ||
        m.type === MessageType.SNAPSHOT;
      r.becomeFollower(m.term, fromLeader ? m.from : 0n);
    }
  } else if (m.term !== 0n && m.term < r.term) {
    if (
      (r.cfg.checkQuorum || r.cfg.preVote) &&
      (m.type === MessageType.APPEND || m.type === MessageType.HEARTBEAT)
    ) {
      // Tell a stale leader about the newer term so it steps down.
      r.send({ type: MessageType.APPEND_RESPONSE, to: m.from });
    } else if (m.type === MessageType.PRE_VOTE) {
      r.send({ type: MessageType.PRE_VOTE_RESPONSE, to: m.from, term: r.term, reject: true });
    }
    return;
  }

  if (isVote(m.type)) {
    const canVote =
      r.vote === m.from ||
      (r.vote === 0n && r.lead === 0n) ||
      (m.type === MessageType.PRE_VOTE && m.term > r.term);
    if (canVote && r.log.isUpToDate(m.index, m.logTerm)) {
      r.send({ type: voteResponseType(m.type), to: m.from, term: m.term });
      if (m.type === MessageType.VOTE) {
        r.electionElapsed = 0;
        r.vote = m.from;
      }
    } else {
      r.send({ type: voteResponseType(m.type), to: m.from, term: r.term, reject: true });
    }
    return;
  }

  if (r.role === 'leader') stepLeader(r, m);
  else if (r.role === 'follower') stepFollower(r, m);
  else stepCandidate(r, m);
}
