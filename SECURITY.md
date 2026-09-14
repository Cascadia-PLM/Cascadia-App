# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Cascadia PLM, please report it responsibly. **Do not open a public GitHub issue.**

### How to Report

Email **security@cascadiaplm.com** with:

- A description of the vulnerability
- Steps to reproduce
- Potential impact assessment
- Any suggested fixes (optional)

### What to Expect

- **Acknowledgment** within 48 hours of your report.
- **Status update** within 7 days with our assessment and timeline.
- **Fix timeline** depends on severity:
  - **Critical** (auth bypass, data exposure, RCE): Patch within 7 days
  - **High** (privilege escalation, injection): Patch within 14 days
  - **Medium** (information disclosure, CSRF): Patch within 30 days
  - **Low** (minor information leak, hardening): Next scheduled release

### Credit

We will credit reporters in the release notes (unless you prefer to remain anonymous).

## Supported Versions

| Version | Supported |
| ------- | --------- |
| Latest  | Yes       |

Only the latest release receives security patches. We recommend always running the most recent version.

## Security Considerations for Self-Hosting

### Authentication

- Sessions are opaque 256-bit random tokens stored hashed in the database — there is no session signing secret to configure or rotate. Revoking a session is a database row delete.
- **Immediately change the default `admin@cascadia.local` password** (`Cascadia`) — it is only intended for local development bootstrap.
- Enable HTTPS in production. Session cookies are not secure over plain HTTP.
- Configure GitHub OAuth for SSO where possible — it is the only OAuth provider implemented today.

### Database

- Use a dedicated PostgreSQL user with minimal privileges (not the `postgres` superuser).
- Enable SSL for database connections in production.
- Use `DATABASE_URL` with `?sslmode=require` for remote databases.

### File Storage

- For production deployments, use S3-compatible storage with server-side encryption.
- If using local storage, ensure the vault directory has restricted file permissions.

### Secrets at Rest

- Set `ENCRYPTION_KEY` (64 hex characters — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) so provider API keys entered in the admin UI are encrypted with AES-256-GCM before storage. **When it is unset, those keys are stored in plaintext in the database**; the server logs a warning each time that happens.
- Keys saved before `ENCRYPTION_KEY` was configured remain plaintext — re-save them once the key is set.
- Treat `ENCRYPTION_KEY` like any other secret (see Environment Variables below). Rotating it makes previously encrypted values undecryptable until they are re-entered.
- **Webhook signing secrets are the one exception to the plaintext fallback above, deliberately.** A signed webhook subscription cannot be created or rotated while `ENCRYPTION_KEY` is unset: the request is refused with a validation error naming the variable. That is stricter than the treatment of provider API keys, and the difference is blast radius rather than inconsistency — a plaintext provider key exposes a credential the operator already holds elsewhere and can rotate upstream, whereas a plaintext HMAC key lets anyone who can read a table the admin API reads **forge deliveries** into whatever the customer wired the webhook to. An operator on a trusted network can still create an explicitly unsigned subscription; what is refused is the silent middle, a subscription that claims to be signed and is not.
- `ENCRYPTION_KEY` must be set on the **jobs worker** as well as the app tier, with the same value: the worker is where deliveries are signed. The delivery pump refuses to start — logging an error that names the variable — when at least one enabled subscription has a signing secret and the key is unset, rather than sending unsigned.

### Outbound Webhooks

Webhook delivery is the only place Cascadia makes outbound HTTP requests to an
address a user chose, so it is the only place server-side request forgery is a
live concern.

- **Targets are validated at write time and re-classified at send time.** A
  stored target is re-fetched forever, so a write-time check alone would age into
  an internal-network read primitive as DNS changes under it. Every delivery
  resolves the host and refuses it if _any_ returned address is loopback,
  link-local, private, carrier-grade NAT, benchmarking, multicast, reserved,
  IPv4-compatible or local-use NAT64 — any, not the first, because a hostile name
  can answer with one public address and one private one. A host that does not
  resolve at all is retried rather than refused for good, since that is no
  verdict on its address. Saving a subscription also resolves its host and
  refuses one that points somewhere private now; that is best-effort, and the
  send-time check is the boundary.
- **Redirects are not followed** (`redirect: 'manual'`). A 3xx is recorded as a
  permanent failure. Following one is what turns a validated public host into a
  read primitive, and it was the cheap version of the attack.
- **HTTPS is required** unless plaintext is explicitly enabled for a
  subscription, and a target URL may not embed credentials.
- **DNS rebinding between the lookup and the connection is not closed.** Closing
  it needs a custom dispatcher that connects to the vetted address while
  preserving the Host header. What raises the cost meanwhile is that a rebind has
  to win a race on every delivery rather than being configured once, and that the
  redirect ban removes the easy path. This is stated rather than implied because
  an unstated gap is worse than a known one.
- **Delivery failures never carry the target URL or the upstream response body**
  into an error message or a log line. The API error builder returns messages
  verbatim to the client and the error-log table stores context unredacted, so an
  error that echoed either would make an SSRF probe both API-readable and
  permanently logged. The response status and a bounded snippet are stored on the
  delivery row instead, which is gated on `system:manage`.
- Deliveries are signed with HMAC-SHA256 over the **raw request bytes** with the
  timestamp inside the signed material, so a receiver can verify what it received
  without re-serialising it and can distinguish a legitimate redelivery from a
  replay. Redelivery is a designed property: receivers should also dedupe on the
  `X-Cascadia-Event-Id` header.

### Network

- Run RabbitMQ on a private network — do not expose the management interface publicly.
- Use a reverse proxy (nginx, Caddy, Traefik) for TLS termination.
- Restrict API access with network policies if running on Kubernetes.

### Environment Variables

- Never commit `.env` files. Use your platform's secret management (Docker Secrets, Kubernetes Secrets, AWS Secrets Manager, etc.).
- Rotate API keys (AI providers, OAuth secrets) regularly.

## Scope

The following are in scope for security reports:

- Authentication and authorization bypass
- SQL injection, XSS, CSRF, SSRF
- Remote code execution
- Sensitive data exposure
- Privilege escalation
- Insecure default configurations

Out of scope:

- Denial of service (DoS) attacks
- Social engineering
- Issues in third-party dependencies (report upstream, but let us know)
- Security issues in self-hosted deployments caused by misconfiguration
