/**
 * The single error table (CLAUDE.md §9): every expected failure has one code,
 * and each code maps to exactly one reply on every interface. Adapters render
 * from this table and never invent errors of their own.
 */
export const MindlogErrorCode = {
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  WRONG_TYPE: 'WRONG_TYPE',
  CONFLICT: 'CONFLICT',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  BUSY: 'BUSY',
  DEADLINE_EXCEEDED: 'DEADLINE_EXCEEDED',
  CANCELLED: 'CANCELLED',
  UNAVAILABLE: 'UNAVAILABLE',
  NOT_LEADER: 'NOT_LEADER',
  RANGE_MOVED: 'RANGE_MOVED',
  UNSUPPORTED_PROTOCOL: 'UNSUPPORTED_PROTOCOL',
  UNIMPLEMENTED: 'UNIMPLEMENTED',
  CLOCK_OFFSET_EXCEEDED: 'CLOCK_OFFSET_EXCEEDED',
  KEY_ENCODING_OUT_OF_RANGE: 'KEY_ENCODING_OUT_OF_RANGE',
  KEY_DECODE_FAILED: 'KEY_DECODE_FAILED',
  CONFIG_INVALID: 'CONFIG_INVALID',
  INTERNAL: 'INTERNAL',
} as const;

export type MindlogErrorCode = (typeof MindlogErrorCode)[keyof typeof MindlogErrorCode];

/** gRPC status codes (grpc/status.proto), numeric to stay dependency-free. */
export const GrpcStatus = {
  CANCELLED: 1,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const;

export type GrpcStatus = (typeof GrpcStatus)[keyof typeof GrpcStatus];

/**
 * How an MCP tool call reports the error: schema violations are JSON-RPC
 * `invalid_params` (-32602); everything else is a tool result with `isError`.
 */
export type McpErrorKind = 'invalid_params' | 'tool_error';

export interface ErrorCodeSpec {
  /** First word of the RESP error reply, e.g. `-WRONGTYPE ...` (RESP3 spec). */
  readonly resp: string;
  /** HTTP status for the RFC 9457 problem response. */
  readonly httpStatus: number;
  readonly grpcStatus: GrpcStatus;
  readonly mcp: McpErrorKind;
  /** Whether repeating the same request can succeed without changing it. */
  readonly retryable: boolean;
  /** Short, stable, human title (RFC 9457 `title`). */
  readonly title: string;
}

export const ERROR_CODES = {
  INVALID_ARGUMENT: {
    resp: 'ERR',
    httpStatus: 400,
    grpcStatus: GrpcStatus.INVALID_ARGUMENT,
    mcp: 'invalid_params',
    retryable: false,
    title: 'Invalid argument',
  },
  NOT_FOUND: {
    resp: 'ERR',
    httpStatus: 404,
    grpcStatus: GrpcStatus.NOT_FOUND,
    mcp: 'tool_error',
    retryable: false,
    title: 'Not found',
  },
  ALREADY_EXISTS: {
    resp: 'ERR',
    httpStatus: 409,
    grpcStatus: GrpcStatus.ALREADY_EXISTS,
    mcp: 'tool_error',
    retryable: false,
    title: 'Already exists',
  },
  WRONG_TYPE: {
    resp: 'WRONGTYPE',
    httpStatus: 409,
    grpcStatus: GrpcStatus.FAILED_PRECONDITION,
    mcp: 'tool_error',
    retryable: false,
    title: 'Operation against a key holding the wrong kind of value',
  },
  CONFLICT: {
    resp: 'CONFLICT',
    httpStatus: 409,
    grpcStatus: GrpcStatus.ABORTED,
    mcp: 'tool_error',
    retryable: true,
    title: 'Conflict',
  },
  UNAUTHENTICATED: {
    resp: 'NOAUTH',
    httpStatus: 401,
    grpcStatus: GrpcStatus.UNAUTHENTICATED,
    mcp: 'tool_error',
    retryable: false,
    title: 'Authentication required',
  },
  PERMISSION_DENIED: {
    resp: 'NOPERM',
    httpStatus: 403,
    grpcStatus: GrpcStatus.PERMISSION_DENIED,
    mcp: 'tool_error',
    retryable: false,
    title: 'Permission denied',
  },
  PAYLOAD_TOO_LARGE: {
    resp: 'ERR',
    httpStatus: 413,
    grpcStatus: GrpcStatus.RESOURCE_EXHAUSTED,
    mcp: 'invalid_params',
    retryable: false,
    title: 'Payload too large',
  },
  RATE_LIMITED: {
    resp: 'BUSY',
    httpStatus: 429,
    grpcStatus: GrpcStatus.RESOURCE_EXHAUSTED,
    mcp: 'tool_error',
    retryable: true,
    title: 'Rate limit exceeded',
  },
  BUSY: {
    resp: 'BUSY',
    httpStatus: 503,
    grpcStatus: GrpcStatus.RESOURCE_EXHAUSTED,
    mcp: 'tool_error',
    retryable: true,
    title: 'Server busy',
  },
  DEADLINE_EXCEEDED: {
    resp: 'TIMEOUT',
    httpStatus: 504,
    grpcStatus: GrpcStatus.DEADLINE_EXCEEDED,
    mcp: 'tool_error',
    retryable: true,
    title: 'Deadline exceeded',
  },
  CANCELLED: {
    resp: 'ERR',
    httpStatus: 499,
    grpcStatus: GrpcStatus.CANCELLED,
    mcp: 'tool_error',
    retryable: true,
    title: 'Request cancelled',
  },
  UNAVAILABLE: {
    resp: 'TRYAGAIN',
    httpStatus: 503,
    grpcStatus: GrpcStatus.UNAVAILABLE,
    mcp: 'tool_error',
    retryable: true,
    title: 'Service unavailable',
  },
  NOT_LEADER: {
    resp: 'TRYAGAIN',
    httpStatus: 503,
    grpcStatus: GrpcStatus.UNAVAILABLE,
    mcp: 'tool_error',
    retryable: true,
    title: 'Not the leader for this range',
  },
  RANGE_MOVED: {
    resp: 'MOVED',
    httpStatus: 421,
    grpcStatus: GrpcStatus.UNAVAILABLE,
    mcp: 'tool_error',
    retryable: true,
    title: 'Range moved to another node',
  },
  UNSUPPORTED_PROTOCOL: {
    resp: 'NOPROTO',
    httpStatus: 400,
    grpcStatus: GrpcStatus.UNIMPLEMENTED,
    mcp: 'invalid_params',
    retryable: false,
    title: 'Unsupported protocol version',
  },
  UNIMPLEMENTED: {
    resp: 'ERR',
    httpStatus: 501,
    grpcStatus: GrpcStatus.UNIMPLEMENTED,
    mcp: 'tool_error',
    retryable: false,
    title: 'Not implemented',
  },
  CLOCK_OFFSET_EXCEEDED: {
    resp: 'TRYAGAIN',
    httpStatus: 503,
    grpcStatus: GrpcStatus.UNAVAILABLE,
    mcp: 'tool_error',
    retryable: true,
    title: 'Clock offset exceeds the configured maximum',
  },
  KEY_ENCODING_OUT_OF_RANGE: {
    resp: 'ERR',
    httpStatus: 400,
    grpcStatus: GrpcStatus.OUT_OF_RANGE,
    mcp: 'invalid_params',
    retryable: false,
    title: 'Value cannot be encoded in a key',
  },
  KEY_DECODE_FAILED: {
    resp: 'ERR',
    httpStatus: 500,
    grpcStatus: GrpcStatus.INTERNAL,
    mcp: 'tool_error',
    retryable: false,
    title: 'Stored key could not be decoded',
  },
  CONFIG_INVALID: {
    resp: 'ERR',
    httpStatus: 400,
    grpcStatus: GrpcStatus.INVALID_ARGUMENT,
    mcp: 'invalid_params',
    retryable: false,
    title: 'Invalid configuration',
  },
  INTERNAL: {
    resp: 'ERR',
    httpStatus: 500,
    grpcStatus: GrpcStatus.INTERNAL,
    mcp: 'tool_error',
    retryable: false,
    title: 'Internal error',
  },
} as const satisfies Record<MindlogErrorCode, ErrorCodeSpec>;

/** RFC 9457 `type` URI for a code; a URN so it never implies a live website. */
export function problemType(code: MindlogErrorCode): string {
  return `urn:mindlog:error:${code.toLowerCase().replaceAll('_', '-')}`;
}
