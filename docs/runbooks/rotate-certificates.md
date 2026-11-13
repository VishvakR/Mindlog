# Rotating certificates

TLS and mTLS use `tls.ca`, `tls.cert` and `tls.key` (phase 10). Files are re-read every `tls.reloadMs`.

**Steps**
1. Issue new certificates from the same CA, or from a new CA during a CA rotation.
2. CA rotation only: first put a bundle with the old and the new CA in `tls.ca` on every node and the model service. Wait one `tls.reloadMs`.
3. Replace `tls.cert` and `tls.key` on each node, atomically (write to a temporary file, then `mv`). Keep them `chmod 600`; the `production` profile refuses readable secrets.
4. The node serves the new certificate without a restart. A broken pair is logged and ignored, and the old one stays in use.
5. CA rotation only: after every node uses new certificates, remove the old CA from the bundle.

**Verify.** Run `openssl s_client -connect <host>:6379 -showcerts` (also on the HTTP, MCP and internal ports), and check the new expiry. Nodes keep their peer connections; `mindlog_transport_dropped_messages_total` does not jump.

**Record.** The new expiry date, and when to rotate next.
