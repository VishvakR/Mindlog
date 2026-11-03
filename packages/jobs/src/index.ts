/**
 * @mindlog/jobs — durable jobs stored in the scope's range (PLAN 12.7, ADR-0017).
 */
export {
  MAX_ATTEMPTS,
  completeJob,
  enqueueJob,
  jobCompleteHandler,
  jobLeaseHandler,
} from './apply/job-apply.js';
export type { DueJob } from './job-index.js';
export { dueJobs, jobRangeHooks, queueDepth } from './job-index.js';
export {
  COLLECTION_SCOPE,
  collectionScope,
  jobIndexKey,
  jobIndexPrefix,
  jobKey,
  jobPrefix,
} from './job-keys.js';
export type { JobRunnerDeps, LeasedJob, Worker, WorkerOutcome } from './job-runner.js';
export { JobRunner, WorkerRegistry } from './job-runner.js';
