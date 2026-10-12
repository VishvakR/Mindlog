import { create } from '@bufbuild/protobuf';
import type { MindlogErrorCode } from '@mindlog/core';
import { mindlogError, toErrorDetail } from '@mindlog/core';
import type { CommandResult } from '@mindlog/proto';
import { CommandResultSchema, ErrorDetailSchema } from '@mindlog/proto';

/** A deterministic failure recorded as a command's result (PLAN 6.2). */
export function errorResult(code: MindlogErrorCode, message: string): CommandResult {
  const detail = toErrorDetail(mindlogError(code, message));
  return create(CommandResultSchema, {
    outcome: { case: 'error', value: create(ErrorDetailSchema, detail) },
  });
}
