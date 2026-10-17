import type { Message } from '@mindlog/proto';
import { MessageType } from '@mindlog/proto';
import { hup } from './election.js';
import type { Raft } from './raft.js';

/** Follower side of AppendEntries (Figure 2, with etcd's fast-backtracking hint). */
export function handleAppend(r: Raft, m: Message): void {
  const reply = { type: MessageType.APPEND_RESPONSE, to: m.from, leaseTick: m.leaseTick };
  if (m.index < r.log.committed) {
    r.send({ ...reply, index: r.log.committed });
    return;
  }
  const lastNew = r.log.maybeAppend(m.index, m.logTerm, m.commit, m.entries);
  if (lastNew !== undefined) {
    r.send({ ...reply, index: lastNew });
    return;
  }
  const probe = m.index < r.log.lastIndex() ? m.index : r.log.lastIndex();
  const [hintIndex, hintTerm] = r.log.findConflictByTerm(probe, m.logTerm);
  r.send({ ...reply, index: m.index, reject: true, rejectHint: hintIndex, logTerm: hintTerm });
}

export function handleHeartbeat(r: Raft, m: Message): void {
  r.log.commitTo(m.commit < r.log.lastIndex() ? m.commit : r.log.lastIndex());
  r.send({
    type: MessageType.HEARTBEAT_RESPONSE,
    to: m.from,
    context: m.context,
    leaseTick: m.leaseTick,
  });
}

/** Restores from a leader snapshot unless our log already covers it. */
export function handleSnapshot(r: Raft, m: Message): void {
  const meta = m.snapshot;
  const reply = { type: MessageType.APPEND_RESPONSE, to: m.from, leaseTick: m.leaseTick };
  if (!meta || meta.index <= r.log.committed) {
    r.send({ ...reply, index: r.log.committed });
    return;
  }
  if (r.log.matchTerm(meta.index, meta.term)) {
    // Fast-forward: the entries are here, only commit was behind.
    r.log.commitTo(meta.index);
    r.send({ ...reply, index: r.log.lastIndex() });
    return;
  }
  r.log.restore(meta);
  if (meta.confState) r.setConfState(meta.confState);
  r.send({ ...reply, index: r.log.lastIndex() });
}

export function stepFollower(r: Raft, m: Message): void {
  switch (m.type) {
    case MessageType.PROPOSE:
    case MessageType.READ_INDEX:
      // Forward to the leader; dropped (and timed out by the host) when none is known.
      // Local requests are built without a range id; a multi-range store routes by it.
      if (r.lead !== 0n) r.msgs.push({ ...m, to: r.lead, rangeId: r.cfg.rangeId });
      return;
    case MessageType.APPEND:
      r.electionElapsed = 0;
      r.lead = m.from;
      handleAppend(r, m);
      return;
    case MessageType.HEARTBEAT:
      r.electionElapsed = 0;
      r.lead = m.from;
      handleHeartbeat(r, m);
      return;
    case MessageType.SNAPSHOT:
      r.electionElapsed = 0;
      r.lead = m.from;
      handleSnapshot(r, m);
      return;
    case MessageType.TIMEOUT_NOW:
      hup(r, true);
      return;
    case MessageType.READ_INDEX_RESPONSE:
      r.readStates.push({ index: m.index, context: m.context });
      return;
    default:
      return;
  }
}
