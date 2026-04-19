# User Management

This guide covers user administration in Cascadia PLM, including creating users, managing roles, controlling access, and configuring authentication.

## User Accounts

### Database Schema

Users are stored in the `users` table with the following fields:

| Column                  | Type         | Description                                         |
| ----------------------- | ------------ | --------------------------------------------------- |
| `id`                    | UUID         | Primary key (auto-generated)                        |
| `email`                 | VARCHAR(255) | Unique email address (used as login username)       |
| `name`                  | VARCHAR(255) | Display name                                        |
| `password_hash`         | VARCHAR(255) | Argon2id-hashed password                            |
| `provider`              | VARCHAR(50)  | Auth provider: `local`, `azure`, `google`, `github` |
| `provider_id`           | VARCHAR(255) | External provider user ID (for OAuth)               |
| `active`                | BOOLEAN      | Whether the account is enabled (default: true)      |
| `failed_login_attempts` | INTEGER      | Consecutive failed logins (default: 0)              |
| `locked_until`          | TIMESTAMPTZ  | Account lockout expiration (null = not locked)      |
| `last_login`            | TIMESTAMPTZ  | Timestamp of most recent successful login           |
| `created_at`            | TIMESTAMPTZ  | Account creation timestamp                          |

### Creating Users

Users are created through the `UserService.createUser()` method, which validates input, hashes the password, and assigns the default "User" role.

**API endpoint**: There is no dedicated `POST /api/users` endpoint for user creation in the current codebase. Users are created through the seed scripts or will need an admin route added.

**Validation rules** (from `userCreateSchema`):

- `email`: Valid email address, unique across all users
- `name`: 1-255 characters, required
- `password`: 8-128 characters
- `provider`: One of `local`, `azure`, `google`, `github` (defaults to `local`)
- `active`: Boolean (defaults to `true`)

New users automatically receive the "User" role.

### Updating Users

**API endpoint**: `PUT /api/users/:id`

**Permission required**: `users:update`

Updatable fields:

- `email` (uniqueness check enforced)
- `name`
- `active`
- `provider`
- `providerId`

### Deleting Users

**API endpoint**: `DELETE /api/users/:id`

**Permission required**: `users:delete`

This performs a hard delete: the user's role assignments are removed first (foreign key constraint), then the user record is deleted. Sessions are cascade-deleted by the database.

### Activation and Deactivation

Deactivation is the preferred way to remove user access without losing audit history. Unlike deletion, deactivation preserves all records.

**API endpoint**: `POST /api/users/:id/activate`

**Permission required**: `users:manage`

**Request body**:

```json
{
  "active": false
}
```

When a user is deactivated:

1. The `active` flag is set to `false`
2. **All active sessions are immediately revoked** -- the user is logged out everywhere
3. Subsequent login attempts are rejected with "Account is inactive"

When reactivated (`"active": true`), the user can log in again immediately.

### Last Login Tracking

The `last_login` timestamp is updated on every successful authentication. This is handled automatically by `AuthService.login()` and requires no admin action.

## Role Assignment

### Viewing User Roles

**API endpoint**: `GET /api/users/:id/roles`

**Permission required**: `users:read`

Returns the array of roles assigned to the user.

### Assigning Roles

**API endpoint**: `PUT /api/users/:id/roles`

**Permission required**: `users:manage`

**Request body**:

```json
{
  "roleIds": ["<uuid-of-role-1>", "<uuid-of-role-2>"]
}
```

This is a **replace** operation: all existing role assignments are removed, then the specified roles are assigned. To add a role without removing others, include all existing role IDs in the array.

After role assignment, the permission cache for the user is cleared so changes take effect on the next request.

Users can hold multiple roles simultaneously. The effective permissions are the **union** of all assigned role permissions. If any role grants a permission, the user has it.

## Password Management

### Password Hashing

Cascadia uses **Argon2id** as the primary password hashing algorithm with the following parameters:

- Memory cost: 64 MB
- Time cost: 3 iterations
- Parallelism: 4 threads

Legacy PBKDF2 hashes are supported for backward compatibility and are transparently upgraded to Argon2id on next successful login.

### Changing Passwords

**API endpoint**: `PUT /api/users/:id/password`

**Permission required**: `users:manage`

**Request body**:

```json
{
  "currentPassword": "old-password",
  "password": "new-password"
}
```

Password changes require the current password for verification (even when performed by an admin on behalf of a user). On success:

1. The new password is hashed with Argon2id
2. Failed login attempts and lockout state are reset
3. All other sessions for the user are invalidated (the current session is preserved)

**Password validation**: minimum 8 characters, maximum 128 characters.

**Note**: There is no admin-initiated password reset that bypasses the current password requirement. This is a security limitation -- see the issues log at `docs/issues/admin.md`.

## Authentication

### Email/Password (Local)

The default authentication method. Users log in with their email address and password.

**Login flow** (`AuthService.login()`):

1. Look up user by email
2. Check if account is active
3. Check account lockout status
4. Verify password against stored hash
5. On success: reset lockout state, update `last_login`, invalidate all existing sessions (rotation), create new session
6. On failure: increment `failed_login_attempts`, lock account if threshold reached

Password verification supports both Argon2id (current) and PBKDF2 (legacy). Legacy hashes are automatically upgraded to Argon2id on successful login.

### OAuth Providers

The `users` table supports OAuth providers through the `provider` and `provider_id` fields. The supported provider values are:

- `local` -- Email/password authentication
- `azure` -- Azure Active Directory / Entra ID
- `google` -- Google OAuth
- `github` -- GitHub OAuth

The `provider` field is stored on the user record and the `userCreateSchema` validates against these values. OAuth callback routes are expected to be implemented using the Arctic library.

**Note**: The OAuth callback routes are not yet present in the codebase. Only `local` authentication is fully implemented. See the issues log.

## Session Management

### Session Storage

Sessions are stored in the `sessions` database table:

| Column       | Type         | Description                                 |
| ------------ | ------------ | ------------------------------------------- |
| `id`         | VARCHAR(255) | SHA-256 hash of session token (primary key) |
| `user_id`    | UUID         | References `users.id` (cascade delete)      |
| `expires_at` | TIMESTAMPTZ  | Session expiration time                     |
| `ip_address` | VARCHAR(45)  | Client IP at session creation               |
| `user_agent` | TEXT         | Client user agent string                    |
| `created_at` | TIMESTAMPTZ  | When the session was created                |

### Session Tokens

Session tokens are 32 random bytes encoded as Base64. The raw token is sent to the client as a cookie; only the SHA-256 hash is stored in the database (using `@oslojs/crypto`). This means a database breach does not expose valid session tokens.

### Cookie Configuration

The session cookie is set with the following attributes:

| Attribute  | Value                                              |
| ---------- | -------------------------------------------------- |
| `Name`     | `session`                                          |
| `Path`     | `/`                                                |
| `HttpOnly` | `true` (not accessible to JavaScript)              |
| `Secure`   | `true` in production, `false` in development       |
| `SameSite` | `Strict` (cookie only sent for same-site requests) |
| `Max-Age`  | 28800 seconds (8 hours)                            |

### Session Duration and Extension

- **Duration**: 8 hours from creation
- **Extension threshold**: When less than 4 hours remain, the session is automatically extended for another 8 hours on the next validated request
- **Maximum lifetime**: There is no hard maximum -- sessions are extended indefinitely as long as the user remains active

### Session Rotation

On login, all existing sessions for the user are invalidated before creating a new one. This means a user can only have one active session at a time.

### Session Cleanup

Expired sessions remain in the database until explicitly cleaned up. Call `SessionManager.cleanupExpiredSessions()` periodically (e.g., via a scheduled job or cron) to remove stale records.

## Account Lockout

Cascadia implements brute-force protection with automatic account lockout:

| Parameter           | Value      |
| ------------------- | ---------- |
| Max failed attempts | 10         |
| Lockout duration    | 15 minutes |

**Behavior**:

1. Each failed login increments `failed_login_attempts`
2. On the 10th consecutive failure, `locked_until` is set to 15 minutes in the future
3. While locked, all login attempts are rejected with a message showing time remaining
4. After the lockout period, the next login attempt proceeds normally
5. A successful login resets both `failed_login_attempts` (to 0) and `locked_until` (to null)
6. Changing a password also resets the lockout state

### Lockout Events

All lockout-related events are recorded in the `auth_events` table:

- `login_failed` -- Failed login attempt (includes reason: `user_not_found`, `invalid_password`, `user_inactive`, `account_locked`)
- `account_locked` -- Account was locked after reaching max attempts
- `login_success` -- Successful login (resets lockout)
- `logout` -- User logged out
- `permission_denied` -- User attempted an action without permission

Each event includes `ip_address`, `user_id`, `timestamp`, and a `metadata` JSON field with additional context.

## Auth Events Audit Trail

The `auth_events` table provides a complete audit trail of authentication and authorization activity:

```sql
SELECT event_type, ip_address, metadata, timestamp
FROM auth_events
WHERE user_id = '<user-id>'
ORDER BY timestamp DESC;
```

Event types recorded:

| Event Type          | When                                          |
| ------------------- | --------------------------------------------- |
| `login_success`     | User logged in successfully                   |
| `login_failed`      | Failed login attempt (various reasons)        |
| `account_locked`    | Account locked after max failed attempts      |
| `logout`            | User logged out                               |
| `permission_denied` | User tried an action they lack permission for |

## API Reference

| Method | Endpoint                  | Permission     | Description                 |
| ------ | ------------------------- | -------------- | --------------------------- |
| GET    | `/api/users/:id`          | `users:read`   | Get user with roles         |
| PUT    | `/api/users/:id`          | `users:update` | Update user fields          |
| DELETE | `/api/users/:id`          | `users:delete` | Hard delete user            |
| GET    | `/api/users/:id/roles`    | `users:read`   | Get user's roles            |
| PUT    | `/api/users/:id/roles`    | `users:manage` | Replace user's role set     |
| PUT    | `/api/users/:id/password` | `users:manage` | Change user password        |
| POST   | `/api/users/:id/activate` | `users:manage` | Activate or deactivate user |
