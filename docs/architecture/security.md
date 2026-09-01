# Security Architecture

This document describes Cascadia's security model: authentication, authorization, request protection, and input hardening. All security code lives in `packages/core/src/lib/auth/` and `packages/core/src/lib/api/handler.ts`.

---

## Architecture Overview

```
                          ┌─────────────────────────────┐
                          │       Browser Request        │
                          └──────────────┬──────────────┘
                                         │
                          ┌──────────────▼──────────────┐
                          │    apiHandler() wrapper      │
                          │                              │
                          │  1. CORS preflight (OPTIONS) │
                          │  2. CSRF validation          │
                          │  3. Authentication           │
                          │  4. Permission check         │
                          │  5. Route handler execution  │
                          │  6. Security headers         │
                          │  7. Error handling           │
                          └──────────────┬──────────────┘
                                         │
                          ┌──────────────▼──────────────┐
                          │     Service Layer            │
                          │  (additional access checks)  │
                          │  requireDesignAccess()       │
                          │  requireBranchAccess()       │
                          └─────────────────────────────┘
```

Every API route is wrapped by `apiHandler()` from `packages/core/src/lib/api/handler.ts`, which enforces security before the route handler executes.

---

## Authentication

### Password Hashing

**File**: `packages/core/src/lib/auth/password.ts`

Passwords are hashed with **Argon2id** (via `@node-rs/argon2`), the current OWASP-recommended algorithm:

```typescript
export async function hashPassword(password: string): Promise<string> {
  const hashed = await argon2Hash(password, {
    memoryCost: 65536, // 64 MB
    timeCost: 3,
    parallelism: 4,
  })
  return `argon2id:${hashed}`
}
```

Legacy PBKDF2 hashes are supported for gradual migration. On successful login with a PBKDF2 hash, the password is automatically rehashed with Argon2id:

```typescript
if (needsRehash(user.passwordHash)) {
  const newHash = await hashPassword(password)
  await db
    .update(users)
    .set({ passwordHash: newHash })
    .where(eq(users.id, user.id))
}
```

Password verification uses constant-time comparison to prevent timing attacks.

### Session Management

**File**: `packages/core/src/lib/auth/session.ts`

Sessions are database-backed (not JWTs), stored in the `sessions` table.

| Property              | Value                                                     |
| --------------------- | --------------------------------------------------------- |
| Session duration      | 8 hours                                                   |
| Auto-extend threshold | 4 hours remaining                                         |
| Token generation      | 32 bytes from `crypto.getRandomValues()`                  |
| Token storage         | SHA-256 hash of token stored in DB (via `@oslojs/crypto`) |
| Cookie name           | `session`                                                 |

The session token is generated using `@oslojs/encoding` and cryptographically random bytes. Only the SHA-256 hash is stored in the database -- a database breach does not expose valid session tokens.

**Session lifecycle**:

1. **Login**: `AuthService.login()` validates credentials, creates session via `SessionManager.createSession()`
2. **Request validation**: `SessionManager.validateSession()` hashes the token, looks up the session, joins with users, checks expiry
3. **Auto-extension**: If less than 4 hours remain, the session is silently extended
4. **Logout**: Session deleted from database, cookie cleared
5. **Session rotation**: On login, all existing sessions for the user are invalidated (prevents session fixation)

### Account Lockout

**File**: `packages/core/src/lib/auth/AuthService.ts`

After **10 consecutive failed password attempts**, the account is locked for
**15 minutes**:

```typescript
AuthService.MAX_FAILED_ATTEMPTS = 10
AuthService.LOCKOUT_DURATION_MINUTES = 15
```

- Failed attempts increment `users.failedLoginAttempts`
- When threshold is reached, `users.lockedUntil` is set
- A successful password check resets both counters
- Lockout expiry is checked on every attempt

**One budget, not one per endpoint.** Every path that checks an account
password shares this counter, not just the sign-in form — re-entering a
password to sign an approval spends from the same ten attempts and can lock the
account for login. Without that, an attacker holding a stolen session could
guess a password at leisure against an account the login form would already
have locked. The cost is the mirror image: someone spraying the signing prompt
can lock a victim out of signing in, which is the same denial-of-service the
login endpoint has always carried. The `auth_events` metadata records a
`source` (`login` or `signature`) so an administrator can tell the two apart.

### Session Cookie Security

**File**: `packages/core/src/lib/auth/cookie.ts`

```typescript
export function buildSessionCookie(token: string): string {
  return buildCookie({
    name: 'session',
    value: token,
    path: '/',
    httpOnly: true, // Not accessible to JavaScript
    secure: process.env.NODE_ENV === 'production', // HTTPS only in production
    sameSite: 'Strict', // Not sent on cross-site requests
    maxAge: 28800, // 8 hours
  })
}
```

- **HttpOnly**: Cookie cannot be read by client-side JavaScript (prevents XSS token theft)
- **Secure**: Only transmitted over HTTPS in production
- **SameSite=Strict**: Cookie is never sent on cross-origin requests (strongest CSRF protection at the cookie level)

### Auth Event Logging

All authentication events are recorded in the `authEvents` table:

| Event               | Logged Data                                                            |
| ------------------- | ---------------------------------------------------------------------- |
| `login_success`     | userId, IP, email                                                      |
| `login_failed`      | IP, username, reason (user_not_found, invalid_password, user_inactive) |
| `account_locked`    | userId, IP, failedAttempts                                             |
| `logout`            | userId, IP                                                             |
| `permission_denied` | userId, IP, resource, action                                           |

---

## Authorization

### Role-Based Access Control (RBAC)

**File**: `packages/core/src/lib/auth/permissions.ts`

Six predefined roles with hierarchical permissions:

| Role              | Scope             | Key Capabilities                                |
| ----------------- | ----------------- | ----------------------------------------------- |
| **Administrator** | All programs      | Full access everywhere, manages system settings |
| **Power User**    | Assigned programs | Create/edit/delete all item types               |
| **Approver**      | Assigned programs | Read + update + approve (no create/delete)      |
| **User**          | Assigned programs | Create and edit drafts, read released           |
| **View Only**     | Assigned programs | Read-only access                                |

Permissions are defined as `(resource, action)` pairs:

```typescript
type ResourceType =
  | 'parts'
  | 'documents'
  | 'change_orders'
  | 'designs'
  | 'requirements'
  | 'tasks'
  | 'work_instructions'
  | 'work_orders'
  | 'issues'
  | 'workflows'
  | 'users'
  | 'roles'
  | 'programs'
  | 'reports'
  | 'system'

type PermissionAction =
  'create' | 'read' | 'update' | 'delete' | 'approve' | 'manage'
```

### Permission Checking

**File**: `packages/core/src/lib/auth/permission-service.ts`

`PermissionService` is a singleton with a 5-minute in-memory cache. On each check:

1. Look up the user's assigned roles (from `userRoles` join `roles`)
2. For each role, check if any role grants the requested `(resource, action)` permission
3. The `manage` action implies all other actions for that resource

The cache is keyed by `userId:resource:action` and invalidated when roles are changed.

### Program-Based Access Control (PBAC)

**File**: `packages/core/src/lib/auth/AccessControlService.ts`

Programs are the permission boundary. Users can only access designs within their assigned programs, with exceptions:

```typescript
export class AccessControlService {
  static async canAccessDesign(
    userId: string,
    designId: string,
  ): Promise<boolean> {
    // Cross-program authority (programs:manage) bypasses all checks
    if (await this.hasCrossProgramAccess(userId)) return true

    const design = await DesignService.getById(designId)

    // Global libraries (no program, type = 'Library') accessible to all
    if (design.programId === null && design.designType === 'Library')
      return true

    // Unassigned designs accessible to all (before program assignment)
    if (design.programId === null) return true

    // Otherwise, check program membership
    return ProgramService.canUserAccess(userId, design.programId)
  }
}
```

### Route-Level Authorization

Every API route declares its auth requirements in `apiHandler()`:

```typescript
// Public (no auth required)
GET: apiHandler({ public: true }, async (ctx) => { ... })

// Auth only (any authenticated user)
GET: apiHandler({}, async (ctx) => { ... })

// Specific permission required
GET: apiHandler({ permission: ['parts', 'read'] }, async (ctx) => { ... })
POST: apiHandler({ permission: ['change_orders', 'create'] }, async (ctx) => { ... })
```

### Resource-Level Authorization

For fine-grained access (design-specific, branch-specific), services call:

```typescript
import { requireDesignAccess, requireBranchAccess } from '@/lib/auth/access'

// Throws PermissionDeniedError if user cannot access this design
await requireDesignAccess(userId, designId)

// Throws PermissionDeniedError if the branch is missing or unreachable
const { branch, designId } = await requireBranchAccess(userId, branchId)
```

---

## CSRF Protection

**File**: `packages/core/src/lib/api/handler.ts` (`validateOrigin()`)

For state-changing requests (POST, PUT, PATCH, DELETE), the `Origin` or `Referer` header must match:

1. The request's own origin (same-origin) -- always allowed
2. An explicitly configured origin in `CORS_ALLOWED_ORIGINS` env var

If neither header is present, the request is allowed (same-origin requests from some clients like curl omit these headers; SameSite=Strict cookies already prevent cross-site cookie attachment).

If the header is present but does not match, the request is rejected with HTTP 403.

```typescript
function validateOrigin(request: Request): boolean {
  const method = request.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true

  const origin = request.headers.get('origin')
  const referer = request.headers.get('referer')
  // ... validate against request origin and allowed origins
}
```

---

## CORS Configuration

**File**: `packages/core/src/lib/api/handler.ts` (`getCorsHeaders()`)

CORS is same-origin only by default. To allow external origins, set:

```
CORS_ALLOWED_ORIGINS=https://admin.example.com,https://monitoring.example.com
```

Headers set for allowed origins:

```
Access-Control-Allow-Origin: <matched origin>
Access-Control-Allow-Credentials: true
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Max-Age: 86400
```

For origins not in the allowlist, CORS headers are omitted entirely -- the browser blocks the request.

---

## Security Headers

**File**: `packages/core/src/lib/api/handler.ts`

Applied to all API responses via `applySecurityHeaders()`:

```typescript
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff', // Prevents MIME type sniffing
  'X-Frame-Options': 'DENY', // Prevents clickjacking
  'Referrer-Policy': 'strict-origin-when-cross-origin', // Controls Referer header
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', // Disables browser APIs
}
```

CSP (Content-Security-Policy) and HSTS (Strict-Transport-Security) are intentionally left to the reverse proxy or ingress controller for proper tuning per deployment.

---

## Input Validation

### Zod on All API Inputs

Every API route validates input with Zod schemas before passing data to the service layer. Query parameters use `parseQuery()`:

```typescript
import { parseQuery } from '@/lib/api/handler'

const query = parseQuery(
  request,
  z.object({
    designId: z.string().uuid(),
    limit: z.coerce.number().min(1).max(100).default(50),
    offset: z.coerce.number().min(0).default(0),
  }),
)
```

Request bodies are validated against item-type-specific schemas (e.g., `partSchema`, `changeOrderSchema`).

Zod errors are caught by `handleApiError()` and converted to structured field-level error responses via `ValidationError.fromZodError()`.

### Item Type Schemas

Each item type has a Zod schema that validates both base fields and type-specific fields:

```typescript
// packages/core/src/lib/items/types/part.ts
export const partSchema = baseItemSchema.extend({
  itemType: z.literal('Part'),
  designId: z.string().uuid({ message: 'Design is required' }),
  partType: z
    .enum(['Manufacture', 'Purchase', 'Software', 'Phantom'])
    .optional(),
  material: z.string().max(100).optional(),
  weight: z.string().optional(),
  // ...
})
```

---

## File Upload Hardening

**Files**: `packages/core/src/lib/vault/services/FileService.ts`, `packages/core/src/lib/vault/utils/file-utils.ts`

### Size Limits

Default maximum file size: **100 MB** (configurable per upload via `maxSizeBytes` option).

```typescript
static async uploadFile(options: UploadFileOptions): Promise<FileRecord> {
  const { maxSizeBytes = 100 * 1024 * 1024 } = options

  if (!validateFileSize(file.length, maxSizeBytes)) {
    throw new Error('File size exceeds maximum allowed size')
  }
  // ...
}
```

### Extension Allowlist

Only PLM-relevant file types are accepted. The system uses an **allowlist** (not a blocklist):

```typescript
const ALLOWED_EXTENSIONS = new Set([
  // CAD: .step, .stp, .iges, .stl, .obj, .sldprt, .sldasm, .glb, .gltf, ...
  // Documents: .pdf, .doc, .docx, .xls, .xlsx, .csv, .txt, .ppt, .pptx
  // Images: .png, .jpg, .jpeg, .gif, .svg, .webp
  // Archives: .zip, .7z, .tar, .gz
  // Data: .json, .xml, .yaml, .yml
])
```

Files with extensions not in this set are rejected regardless of MIME type.

### Filename Sanitization

Uploaded filenames are sanitized to remove dangerous characters:

```typescript
export function sanitizeFilename(filename: string): string {
  const ext = path.extname(filename)
  const name = path.basename(filename, ext)
  const sanitized = name
    .replace(/[^a-zA-Z0-9\s_-]/g, '_') // Only alphanumeric, spaces, dashes, underscores
    .replace(/\s+/g, '_')
    .substring(0, 200) // Length limit
  return sanitized + ext
}
```

### Content Integrity

Files are SHA-256 hashed on upload. The hash is stored alongside the file record for:

- Duplicate detection (`allowDuplicates` option)
- Future integrity verification

### Storage Path Isolation

Files are stored in an isolated path structure that prevents path traversal:

```
/{masterId}/{revision}/{fileId}/{version}/{sanitized_filename}
```

---

## OAuth Integration

The system supports OAuth authentication via the **Arctic** library (`arctic` package). The `users` table includes `provider` and `providerId` fields for OAuth-authenticated accounts.

**GitHub is the only implemented provider.** The authorization hop (`GET /api/v1/auth/github`) issues a random state token in an HttpOnly, `SameSite=Lax`, 10-minute cookie; the callback (`GET /api/v1/auth/callback/github`) rejects the exchange unless the returned `state` matches that cookie, then clears it. Accounts are matched on `provider` + `providerId`, or linked to an existing user by verified email -- an account with no verified email is refused rather than admitted without one. The redirect URI is derived from `BASE_URL` and is not separately configurable, so it cannot drift from the route the callback is mounted on.

Configuration is limited to `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`; the `azure` and `google` provider values are reserved in the schema but have no client or callback route. See [user management](../admin/user-management.md#oauth-providers).

---

## Client Certificate Signing (Advanced Auditing package)

Instances licensed for the [Advanced Auditing](../features/advanced-auditing.md)
package sign every workflow approval with the approver's CAC/PIV certificate.
This introduces the one place where Cascadia treats a **request header** as
evidence of identity, so the trust boundary is worth stating precisely.

### The trust boundary

Cascadia does not terminate TLS. A reverse proxy performs the mutual-TLS
handshake, validates the client certificate chain, and forwards the certificate
in a header. Cascadia then re-parses and independently re-verifies it.

```
Browser + CAC ──mTLS──> Reverse proxy ──header──> Cascadia
   (PIN unlocks key)    (validates chain,        (re-verifies chain,
                         sets header)             checks enrollment)
```

**A forwarded header is only as trustworthy as the edge that overwrites it.** If
a client can set the header itself, it can assert any identity. Cascadia
therefore fails closed by default:

| Control                                | Behavior                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Header is opt-in                       | No certificate header is read at all unless the deployment names one in `CASCADIA_CLIENT_CERT_HEADER`                    |
| Only the named header                  | A certificate in any other header is ignored, so a stray or forged header name is inert                                  |
| Independent chain verification         | The certificate is re-verified against `CASCADIA_SIGNING_CA_BUNDLE` rather than trusting the proxy's assertion           |
| Forwarded intermediates confer nothing | Intermediates help build a path but the walk must terminate at a configured anchor, so a client cannot attach its own CA |
| Validity is enforced                   | Expired and not-yet-valid certificates are refused                                                                       |
| Certificate bound to one account       | A certificate is enrolled to exactly one user; a valid card cannot sign under another user's session                     |

Deployment requirement: the proxy must overwrite the header on **every**
request, and Cascadia must not be reachable except through that proxy. The
per-proxy examples are documented with the package that needs them, which is not
part of this edition — see [Advanced Auditing](../features/advanced-auditing.md).

### Why the certificate is not re-challenged

The cardholder's PIN unlocks the private key during the TLS handshake, so
possession is already proven when the request arrives. Re-prompting would add
friction without adding evidence. Where no certificate is presented and policy
permits it, the signer re-enters their **account password** instead — a
deliberate act distinct from merely holding a live session — and the record is
marked as the weaker credential (`method: password`, `assurance: password`).

### Tamper evidence

Signatures are append-only and hash-chained per workflow instance. The chain
proves the audit trail has not been edited _through the application_, and makes
direct database edits detectable: rewriting or deleting a row breaks
verification for every signature after it. It is not a substitute for scoping
database credentials — it is what makes misuse of them visible.

### Revocation

Revocation (CRL/OCSP) is enforced by the mTLS terminator during the handshake,
which is where DoD deployments normally handle it. Cascadia does not
independently re-check, and records `revocation_status: not_checked` rather than
implying a check it did not perform.

---

## Session Security Summary

| Attack                             | Mitigation                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Session hijacking**              | HttpOnly + Secure + SameSite=Strict cookies; SHA-256 hashed tokens in DB                                 |
| **Session fixation**               | All sessions invalidated on login (session rotation)                                                     |
| **Brute force**                    | Account lockout after 10 failures, 15-minute cooldown                                                    |
| **CSRF**                           | SameSite=Strict cookies + Origin/Referer validation                                                      |
| **XSS token theft**                | HttpOnly cookies (JavaScript cannot access)                                                              |
| **MIME sniffing**                  | X-Content-Type-Options: nosniff                                                                          |
| **Clickjacking**                   | X-Frame-Options: DENY                                                                                    |
| **Cross-origin attacks**           | Same-origin CORS by default, explicit allowlist required                                                 |
| **Path traversal (uploads)**       | Filename sanitization + isolated storage paths                                                           |
| **Malicious uploads**              | Extension allowlist, size limits, SHA-256 hashing                                                        |
| **Timing attacks**                 | Constant-time password comparison                                                                        |
| **Stale sessions**                 | Periodic cleanup of expired sessions (`cleanupExpiredSessions()`)                                        |
| **Deactivated users**              | Sessions immediately revoked when user is deactivated                                                    |
| **Forged client-cert header**      | Header read only when explicitly named; chain re-verified against configured anchors (Advanced Auditing) |
| **Signing under another identity** | Certificate enrolled to exactly one account; mismatches refused (Advanced Auditing)                      |
| **Edited audit trail**             | Append-only, hash-chained signatures; edits break chain verification (Advanced Auditing)                 |

---

## Key Files

| File                                                 | Purpose                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `packages/core/src/lib/auth/AuthService.ts`          | Login/logout with lockout logic                                   |
| `packages/core/src/lib/auth/session.ts`              | SessionManager: create, validate, extend, delete                  |
| `packages/core/src/lib/auth/password.ts`             | Argon2id hashing, PBKDF2 legacy support, session token generation |
| `packages/core/src/lib/auth/cookie.ts`               | Session cookie builders with conditional Secure flag              |
| `packages/core/src/lib/auth/server.ts`               | `requireAuth()`, `requirePermission()`, `requireRole()`           |
| `packages/core/src/lib/auth/permissions.ts`          | Role definitions and permission checking                          |
| `packages/core/src/lib/auth/permission-service.ts`   | `PermissionService` singleton with caching                        |
| `packages/core/src/lib/auth/AccessControlService.ts` | Program-based access control                                      |
| `packages/core/src/lib/auth/access.ts`               | `requireDesignAccess()`, `requireBranchAccess()`                  |
| `packages/core/src/lib/auth/UserService.ts`          | User CRUD, role assignment, password change                       |
| `packages/core/src/lib/api/handler.ts`               | `apiHandler()` with CSRF, CORS, security headers                  |
| `packages/core/src/lib/vault/utils/file-utils.ts`    | File validation, sanitization, allowlist                          |
| `packages/core/src/lib/packages/guard.ts`            | `requirePackage()` entitlement gate for optional packages         |
