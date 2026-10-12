import type { StateMachine } from '../apply/state-machine.js';
import type { LocalLog } from '../log/local-log.js';

/**
 * Brings state up to date with the log after a restart: replays every entry
 * above the applied index (ADR-0005). State can lag the log after a crash
 * because state writes are not fsynced; it can never lead it, and the needed
 * entries must not have been compacted. Either violation means corruption, so
 * it throws (fail-stop). Returns the number of entries replayed.
 */
export async function recover(log: LocalLog, machine: StateMachine): Promise<number> {
  const applied = machine.appliedIndex;
  if (applied > log.lastIndex) {
    throw new Error(`state is ahead of the log: applied ${applied}, last ${log.lastIndex}`);
  }
  if (applied + 1n < log.firstIndex && applied < log.lastIndex) {
    throw new Error(
      `log entries ${applied + 1n}..${log.firstIndex - 1n} needed for replay were compacted`,
    );
  }
  let replayed = 0;
  for await (const [index, command] of log.entries(applied + 1n)) {
    await machine.apply(index, command);
    replayed++;
  }
  return replayed;
}
