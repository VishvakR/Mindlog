import type { Message } from '@mindlog/proto';
import { MessageType } from '@mindlog/proto';
import { becomeLeaderAndReplicate, campaign } from './election.js';
import type { Raft } from './raft.js';
import { handleAppend, handleHeartbeat, handleSnapshot } from './step-follower.js';

/** Pre-candidate and candidate: count votes, yield to a leader of our term. */
export function stepCandidate(r: Raft, m: Message): void {
  const myResponse =
    r.role === 'pre-candidate' ? MessageType.PRE_VOTE_RESPONSE : MessageType.VOTE_RESPONSE;
  switch (m.type) {
    case MessageType.APPEND:
      r.becomeFollower(m.term, m.from);
      handleAppend(r, m);
      return;
    case MessageType.HEARTBEAT:
      r.becomeFollower(m.term, m.from);
      handleHeartbeat(r, m);
      return;
    case MessageType.SNAPSHOT:
      r.becomeFollower(m.term, m.from);
      handleSnapshot(r, m);
      return;
    default:
      break;
  }
  if (m.type !== myResponse) return;
  const result = r.poll(m.from, !m.reject);
  if (result === 'won') {
    if (r.role === 'pre-candidate') campaign(r, 'elect', false);
    else becomeLeaderAndReplicate(r);
  } else if (result === 'lost') {
    r.becomeFollower(r.term, 0n);
  }
}
