import type { MessageInitShape } from '@bufbuild/protobuf';
import { create } from '@bufbuild/protobuf';
import type { HybridLogicalClock, UlidGenerator } from '@mindlog/core';
import type { Command } from '@mindlog/proto';
import { CommandSchema } from '@mindlog/proto';

type BodyInit = NonNullable<MessageInitShape<typeof CommandSchema>['body']>;

const encoder = new TextEncoder();

/**
 * Builds commands on the proposing side: a fresh ULID request id and the
 * node's HLC timestamp. All non-determinism is decided here, before
 * proposing, and travels inside the command (ADR-0003).
 */
export class CommandStamper {
  readonly #hlc: HybridLogicalClock;
  readonly #ids: UlidGenerator;

  constructor(hlc: HybridLogicalClock, ids: UlidGenerator) {
    this.#hlc = hlc;
    this.#ids = ids;
  }

  stamp(tenant: string, principal: string, body: BodyInit, requestId?: Uint8Array): Command {
    return create(CommandSchema, {
      requestId: requestId ?? encoder.encode(this.#ids.next()),
      principal,
      hlc: this.#hlc.now(),
      tenant,
      body,
    });
  }
}
