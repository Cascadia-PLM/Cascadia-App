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

- Set `SESSION_SECRET` to a strong random value — never ship a default:
  ```bash
  openssl rand -hex 32
  ```
- **Immediately change the default `admin@cascadia.local` password** (`Cascadia`) — it is only intended for local development bootstrap.
- Enable HTTPS in production. Session cookies are not secure over plain HTTP.
- Configure OAuth providers (GitHub, Azure AD, Google) for SSO where possible.

### Database

- Use a dedicated PostgreSQL user with minimal privileges (not the `postgres` superuser).
- Enable SSL for database connections in production.
- Use `DATABASE_URL` with `?sslmode=require` for remote databases.

### File Storage

- For production deployments, use S3-compatible storage with server-side encryption.
- If using local storage, ensure the vault directory has restricted file permissions.

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
