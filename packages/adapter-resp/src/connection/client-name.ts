import { replies } from '@mindlog/kv';
import type { KvReply } from '@mindlog/proto';

const decoder = new TextDecoder();

/**
 * Validates a client name (CLIENT SETNAME, HELLO SETNAME): printable ASCII
 * without spaces, as in Valkey. Returns the name or the error reply.
 */
export function parseClientName(bytes: Uint8Array): string | KvReply {
  for (const byte of bytes) {
    if (byte < 0x21 || byte > 0x7e) {
      return replies.error(
        'INVALID_ARGUMENT',
        'Client names cannot contain spaces, newlines or special characters.',
      );
    }
  }
  return decoder.decode(bytes);
}
