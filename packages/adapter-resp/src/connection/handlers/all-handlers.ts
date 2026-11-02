import { ConnectionCommandRegistry } from '../connection-command.js';
import { clientCommand } from './client.js';
import {
  clusterAddLearnerCommand,
  clusterInfoCommand,
  clusterPromoteCommand,
  clusterRemoveCommand,
  clusterTransferCommand,
} from './cluster.js';
import { commandCommand } from './command.js';
import { configCommand } from './config.js';
import { helloCommand } from './hello.js';
import { infoCommand } from './info.js';
import {
  cacheDelCommand,
  cacheGetCommand,
  cacheSetCommand,
  memAddCommand,
  memForgetCommand,
  memGetCommand,
  memHistoryCommand,
  memPackCommand,
  memSearchCommand,
} from './memory.js';
import {
  memBranchCommand,
  memBranchesCommand,
  memDiffCommand,
  memDropCommand,
  memMergeCommand,
  memWatchCommand,
} from './branches.js';
import { memConflictsCommand, memResolveCommand, memTrustCommand } from './review.js';
import {
  memConsolidateCommand,
  memExportCommand,
  memImportCommand,
  memJobsCommand,
  memPinCommand,
  memTraceCommand,
  memUnpinCommand,
} from './lifecycle.js';
import { quitCommand, resetCommand, selectCommand } from './session-commands.js';

/** Every command the RESP adapter answers itself. */
export function createConnectionCommands(): ConnectionCommandRegistry {
  return new ConnectionCommandRegistry([
    helloCommand,
    selectCommand,
    quitCommand,
    resetCommand,
    clientCommand,
    infoCommand,
    configCommand,
    commandCommand,
    clusterInfoCommand,
    clusterAddLearnerCommand,
    clusterPromoteCommand,
    clusterRemoveCommand,
    clusterTransferCommand,
    memAddCommand,
    memPackCommand,
    memSearchCommand,
    memGetCommand,
    memForgetCommand,
    memHistoryCommand,
    memConflictsCommand,
    memResolveCommand,
    memTrustCommand,
    memBranchCommand,
    memBranchesCommand,
    memDiffCommand,
    memMergeCommand,
    memDropCommand,
    memWatchCommand,
    memPinCommand,
    memUnpinCommand,
    memConsolidateCommand,
    memJobsCommand,
    memExportCommand,
    memImportCommand,
    memTraceCommand,
    cacheSetCommand,
    cacheGetCommand,
    cacheDelCommand,
  ]);
}
