import type { Message } from '@mindlog/proto';
import { EntryType, MessageType } from '@mindlog/proto';
import { voteResult } from './quorum/majority.js';
import type { Raft } from './raft.js';

/** Leader handling of proposals, acks, ReadIndex and transfer (etcd `stepLeader`). */
export function stepLeader(r: Raft, m: Message): void {
  switch (m.type) {
    case MessageType.PROPOSE:
      propose(r, m);
      return;
    case MessageType.READ_INDEX:
      if (!r.committedEntryInCurrentTerm()) r.pendingReadIndex.push(m);
      else handleReadIndex(r, m);
      return;
    case MessageType.APPEND_RESPONSE:
      handleAppendResponse(r, m);
      return;
    case MessageType.HEARTBEAT_RESPONSE:
      handleHeartbeatResponse(r, m);
      return;
    default:
      return;
  }
}

function propose(r: Raft, m: Message): void {
  // A removed leader or one handing over leadership takes no new writes.
  if (!r.prs.has(r.id) || r.leadTransferee !== 0n || m.entries.length === 0) return;
  for (const entry of m.entries) {
    if (entry.type !== EntryType.CONF_CHANGE) continue;
    if (r.pendingConfIndex > r.log.applied) return;
    r.pendingConfIndex = r.log.lastIndex() + BigInt(m.entries.length);
  }
  r.appendEntries(m.entries);
  r.bcastAppend();
}

/** Answers a read once leadership is confirmed by a heartbeat round. */
export function handleReadIndex(r: Raft, m: Message): void {
  const index = r.log.committed;
  if (r.voters.size === 1 && r.voters.has(r.id)) {
    respondRead(r, m.from, index, m.context);
    return;
  }
  r.readOnly.add(index, m.context, m.from);
  r.readOnly.recvAck(r.id, m.context);
  r.bcastHeartbeat(m.context);
}

function respondRead(r: Raft, from: bigint, index: bigint, context: Uint8Array): void {
  if (from === r.id || from === 0n) r.readStates.push({ index, context });
  else r.send({ type: MessageType.READ_INDEX_RESPONSE, to: from, index, context });
}

/** Called after the first commit of a term: serves reads that waited for it. */
export function releasePendingReadIndex(r: Raft): void {
  if (!r.committedEntryInCurrentTerm()) return;
  const waiting = r.pendingReadIndex;
  r.pendingReadIndex = [];
  for (const m of waiting) handleReadIndex(r, m);
}

function handleAppendResponse(r: Raft, m: Message): void {
  const pr = r.prs.get(m.from);
  if (!pr) return;
  pr.recentActive = true;
  r.recordLeaseTick(pr, m.leaseTick);
  if (m.reject) {
    let nextProbe = m.rejectHint;
    if (m.logTerm > 0n) [nextProbe] = r.log.findConflictByTerm(m.rejectHint, m.logTerm);
    if (pr.maybeDecrTo(m.index, nextProbe)) {
      if (pr.state === 'replicate') pr.becomeProbe();
      r.sendAppend(m.from);
    }
    return;
  }
  if (pr.maybeUpdate(m.index) || (pr.match === m.index && pr.state === 'probe')) {
    if (pr.state === 'probe') pr.becomeReplicate();
    else if (pr.state === 'snapshot' && pr.match + 1n >= r.log.firstIndex()) {
      pr.becomeProbe();
      pr.becomeReplicate();
    } else if (pr.state === 'replicate') pr.inflights.freeLE(m.index);

    if (r.maybeCommit()) {
      releasePendingReadIndex(r);
      r.bcastAppend();
    } else if (m.from !== r.id && pr.state !== 'snapshot' && pr.sentCommit < r.log.committed) {
      // This peer has not heard the current commit index yet.
      r.sendAppend(m.from);
    }
    while (r.sendAppend(m.from, false)) {
      // keep the pipeline full
    }
    if (m.from === r.leadTransferee && pr.match === r.log.lastIndex()) sendTimeoutNow(r, m.from);
  }
}

function handleHeartbeatResponse(r: Raft, m: Message): void {
  const pr = r.prs.get(m.from);
  if (!pr) return;
  pr.recentActive = true;
  pr.probeSent = false;
  r.recordLeaseTick(pr, m.leaseTick);
  // Lost appends never free their slots; let one through so a reject can reset the pipeline.
  if (pr.state === 'replicate' && pr.inflights.full()) pr.inflights.freeFirstOne();
  if (pr.match < r.log.lastIndex()) r.sendAppend(m.from);
  // Repeat TimeoutNow until the target can campaign (it may still be applying its promotion).
  else if (m.from === r.leadTransferee) sendTimeoutNow(r, m.from);
  if (m.context.length === 0) return;
  const acks = r.readOnly.recvAck(m.from, m.context);
  if (!acks || voteResult(r.voters, acks) !== 'won') return;
  for (const read of r.readOnly.advance(m.context))
    respondRead(r, read.from, read.index, read.context);
}

export function sendTimeoutNow(r: Raft, to: bigint): void {
  r.send({ type: MessageType.TIMEOUT_NOW, to });
}
