---
description: The single error table, and how each code appears over RESP, HTTP, gRPC and MCP.
---

# Errors

Mindlog has **one** error table (`MindlogErrorCode` in `@mindlog/core`). Every interface maps the same code to its own conventions, so an error means the same thing wherever you see it. Adapters never invent errors of their own.

| Code | RESP prefix | HTTP | gRPC | Retry? | Meaning |
|---|---|---|---|---|---|
| `INVALID_ARGUMENT` | `-ERR` | 400 | INVALID_ARGUMENT | no | Invalid argument |
| `NOT_FOUND` | `-ERR` | 404 | NOT_FOUND | no | Not found |
| `ALREADY_EXISTS` | `-ERR` | 409 | ALREADY_EXISTS | no | Already exists |
| `WRONG_TYPE` | `-WRONGTYPE` | 409 | FAILED_PRECONDITION | no | Operation against a key holding the wrong kind of value |
| `CONFLICT` | `-CONFLICT` | 409 | ABORTED | yes | A concurrent change won (re-read, then retry) |
| `UNAUTHENTICATED` | `-NOAUTH` | 401 | UNAUTHENTICATED | no | Authentication required |
| `INVALID_CREDENTIALS` | `-WRONGPASS` | 401 | UNAUTHENTICATED | no | Invalid username or password |
| `EXEC_ABORTED` | `-EXECABORT` | 409 | ABORTED | no | Transaction discarded because of earlier errors |
| `PERMISSION_DENIED` | `-NOPERM` | 403 | PERMISSION_DENIED | no | The role or a policy row does not allow it |
| `PAYLOAD_TOO_LARGE` | `-ERR` | 413 | RESOURCE_EXHAUSTED | no | Payload too large |
| `RATE_LIMITED` | `-BUSY` | 429 | RESOURCE_EXHAUSTED | yes | A tenant rate limit was hit |
| `QUOTA_EXCEEDED` | `-QUOTA` | 429 | RESOURCE_EXHAUSTED | no | A tenant quota is exhausted (free space, or raise it) |
| `BUSY` | `-BUSY` | 503 | RESOURCE_EXHAUSTED | yes | Backpressure: proposal or job queue full |
| `DEADLINE_EXCEEDED` | `-TIMEOUT` | 504 | DEADLINE_EXCEEDED | yes | Deadline exceeded; a write **may still be applied** |
| `CANCELLED` | `-ERR` | 499 | CANCELLED | yes | Request cancelled |
| `UNAVAILABLE` | `-TRYAGAIN` | 503 | UNAVAILABLE | yes | Service unavailable (no leader known, models down for a model-only call) |
| `NOT_LEADER` | `-TRYAGAIN` | 503 | UNAVAILABLE | yes | Not the leader for this range (nodes normally forward instead) |
| `RANGE_MOVED` | `-MOVED` | 421 | UNAVAILABLE | yes | The range moved to another node |
| `CROSS_RANGE` | `-CROSSSLOT` | 400 | FAILED_PRECONDITION | no | Keys are in different ranges and cross-range transactions are off |
| `UNSUPPORTED_PROTOCOL` | `-NOPROTO` | 400 | UNIMPLEMENTED | no | Unsupported protocol version |
| `UNIMPLEMENTED` | `-ERR` | 501 | UNIMPLEMENTED | no | Not implemented |
| `CLOCK_OFFSET_EXCEEDED` | `-TRYAGAIN` | 503 | UNAVAILABLE | yes | This node's clock is too far off; it has fenced itself |
| `KEY_ENCODING_OUT_OF_RANGE` | `-ERR` | 400 | OUT_OF_RANGE | no | A value cannot be encoded in a key |
| `KEY_DECODE_FAILED` | `-ERR` | 500 | INTERNAL | no | A stored key could not be decoded |
| `CONFIG_INVALID` | `-ERR` | 400 | INVALID_ARGUMENT | no | Invalid configuration |
| `INTERNAL` | `-ERR` | 500 | INTERNAL | no | Internal error |

## How each interface shows an error

{% tabs %}
{% tab title="RESP" %}
```
-WRONGTYPE Operation against a key holding the wrong kind of value
-NOPERM <the reason from the authorization decision>
```
The first word is the RESP prefix above; the rest is the message.
{% endtab %}

{% tab title="HTTP" %}
`application/problem+json` (RFC 9457):

```json
{
  "type": "urn:mindlog:error:invalid-argument",
  "title": "Invalid argument",
  "status": 400,
  "detail": "Request validation failed.",
  "code": "INVALID_ARGUMENT",
  "retryable": false,
  "fields": { "query": "Too small: expected string to have >=1 characters" }
}
```
{% endtab %}

{% tab title="MCP" %}
A tool result with `isError: true` and the text `<CODE>: <message>`. Invalid inputs are reported as JSON-RPC invalid params.
{% endtab %}

{% tab title="SDKs" %}
TypeScript throws `ClientError` (`status`, `code`, `fields`); Python raises `ClientError` (`status`, `message`, `code`, `fields`). Both have an `isRetryable` / `retryable` helper that follows the **Retry?** column, plus network failures.
{% endtab %}
{% endtabs %}

## Retrying safely

* Retry only codes marked **yes**, with exponential backoff and jitter.
* `DEADLINE_EXCEEDED` on a write means "unknown": the write may still be applied. Memory writes carry a `requestId`, so resending with the **same** id is safe and applies once. The SDKs do this for you.
* `QUOTA_EXCEEDED` does not go away by waiting. Deletes and forgets are always allowed, so make room or ask for a higher quota.
