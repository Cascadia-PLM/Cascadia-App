// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * API key lifecycle.
 *
 * Both the self-service surface (`/auth/api-keys`) and the admin surface
 * (`/admin/api-keys`) route through here, so an operation means the same thing
 * whichever page invoked it. The only difference between them is ownership:
 * self-service passes `ownerId` and can only touch its own keys; admin passes
 * null and can touch any.
 */

import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db'
import { apiKeyEvents, apiKeys } from '../db/schema/api-keys'
import { users } from '../db/schema/users'
import { generateApiKey, getKeyPrefix, hashApiKey } from './api-key-utils'
import { loadApiKeyPolicy } from './api-key-policy'
import { resolveKeyExpiration } from './api-key-policy-types'
import { permissionService } from './permission-service'
import { NotFoundError, ValidationError } from '@/lib/errors'

/**
 * A key's effective state, derived rather than stored — `expired` is a
 * function of the clock, so persisting it would immediately go stale.
 * Precedence matters: a revoked key that has also expired reads as revoked,
 * because revocation is the decision someone made.
 */
export type ApiKeyStatus = 'active' | 'disabled' | 'expired' | 'revoked'

export function deriveStatus(key: {
  expiresAt: Date | null
  disabledAt: Date | null
  revokedAt: Date | null
}): ApiKeyStatus {
  if (key.revokedAt) return 'revoked'
  if (key.disabledAt) return 'disabled'
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return 'expired'
  return 'active'
}

/** Columns safe to return anywhere. Never includes `keyHash`. */
const publicColumns = {
  id: apiKeys.id,
  name: apiKeys.name,
  keyPrefix: apiKeys.keyPrefix,
  permissions: apiKeys.permissions,
  roles: apiKeys.roles,
  expiresAt: apiKeys.expiresAt,
  lastUsedAt: apiKeys.lastUsedAt,
  createdAt: apiKeys.createdAt,
  disabledAt: apiKeys.disabledAt,
  revokedAt: apiKeys.revokedAt,
  rotatedAt: apiKeys.rotatedAt,
  userId: apiKeys.userId,
}

export interface CreateApiKeyInput {
  name: string
  permissions?: Record<string, Array<string>> | null
  roles?: Array<string>
  expiresAt?: string
}

export interface UpdateApiKeyInput {
  name?: string
  permissions?: Record<string, Array<string>> | null
  roles?: Array<string> | null
}

export class ApiKeyService {
  /**
   * Load a key, enforcing ownership when `ownerId` is given.
   *
   * The same NotFoundError is thrown for "no such key" and "not yours", so the
   * self-service surface cannot be used to probe which key ids exist.
   */
  private static async requireKey(keyId: string, ownerId: string | null) {
    const where = ownerId
      ? and(eq(apiKeys.id, keyId), eq(apiKeys.userId, ownerId))
      : eq(apiKeys.id, keyId)

    const [key] = await db.select().from(apiKeys).where(where).limit(1)
    if (!key) throw new NotFoundError('API key', keyId)
    return key
  }

  /** One user's keys, newest first. */
  static async listForUser(userId: string) {
    const rows = await db
      .select(publicColumns)
      .from(apiKeys)
      .where(eq(apiKeys.userId, userId))
      .orderBy(desc(apiKeys.createdAt))

    return rows.map((row) => ({ ...row, status: deriveStatus(row) }))
  }

  /** Every key on the instance, with its owner. */
  static async listAll() {
    const rows = await db
      .select({
        ...publicColumns,
        userName: users.name,
        userEmail: users.email,
      })
      .from(apiKeys)
      .innerJoin(users, eq(apiKeys.userId, users.id))
      .orderBy(desc(apiKeys.createdAt))

    return rows.map((row) => ({ ...row, status: deriveStatus(row) }))
  }

  /**
   * Validate a requested role scope against what the caller actually holds.
   * Returns the normalised scope, or null for "inherit every owner role".
   */
  private static async normalizeRoles(
    userId: string,
    roles: Array<string> | null | undefined,
  ): Promise<Array<string> | null> {
    if (roles === undefined || roles === null) return null

    if (!Array.isArray(roles) || roles.some((r) => typeof r !== 'string')) {
      throw new ValidationError('roles must be an array of role names')
    }

    const owned = await permissionService.getUserRoles(userId)
    const notHeld = roles.filter((r) => !owned.includes(r))
    if (notHeld.length > 0) {
      throw new ValidationError(
        `Cannot scope an API key to roles you do not hold: ${notHeld.join(', ')}`,
      )
    }

    return Array.from(new Set(roles))
  }

  /**
   * Mint a key for `userId`. Returns the raw secret alongside the record —
   * the only time it is ever available.
   */
  static async create(userId: string, input: CreateApiKeyInput) {
    const name = input.name.trim()
    if (name.length === 0) {
      throw new ValidationError('API key name is required')
    }
    if (name.length > 255) {
      throw new ValidationError('API key name must be 255 characters or fewer')
    }

    const roles = await this.normalizeRoles(userId, input.roles)

    const policy = await loadApiKeyPolicy()
    const expiry = resolveKeyExpiration(input.expiresAt, policy)
    if (!expiry.ok) throw new ValidationError(expiry.error)

    const rawKey = generateApiKey()

    const [created] = await db
      .insert(apiKeys)
      .values({
        userId,
        name,
        keyHash: hashApiKey(rawKey),
        keyPrefix: getKeyPrefix(rawKey),
        permissions: input.permissions ?? null,
        roles,
        expiresAt: expiry.expiresAt,
      })
      .returning(publicColumns)

    if (!created) throw new Error('Failed to create API key')

    return { key: { ...created, status: deriveStatus(created) }, rawKey }
  }

  /**
   * Edit a key's name and scope in place.
   *
   * Scope is editable because the alternative — revoke and reissue — forces a
   * credential rollout through every consuming client just to narrow a
   * permission. Narrowing an over-broad key should be the easy path.
   */
  static async update(
    keyId: string,
    ownerId: string | null,
    input: UpdateApiKeyInput,
  ) {
    const existing = await this.requireKey(keyId, ownerId)
    if (existing.revokedAt) {
      throw new ValidationError('A revoked key cannot be modified')
    }

    const patch: Record<string, unknown> = {}

    if (input.name !== undefined) {
      const name = input.name.trim()
      if (name.length === 0) {
        throw new ValidationError('API key name is required')
      }
      if (name.length > 255) {
        throw new ValidationError(
          'API key name must be 255 characters or fewer',
        )
      }
      patch.name = name
    }

    if (input.permissions !== undefined) {
      patch.permissions = input.permissions
    }

    if (input.roles !== undefined) {
      // Roles are validated against the *key owner*, not the admin editing it:
      // the key acts as its owner, so its owner's roles are the ceiling.
      patch.roles = await this.normalizeRoles(existing.userId, input.roles)
    }

    if (Object.keys(patch).length === 0) {
      return { ...existing, status: deriveStatus(existing) }
    }

    const [updated] = await db
      .update(apiKeys)
      .set(patch)
      .where(eq(apiKeys.id, keyId))
      .returning(publicColumns)

    if (!updated) throw new NotFoundError('API key', keyId)
    return { ...updated, status: deriveStatus(updated) }
  }

  /** Pause or resume a key without changing its secret. */
  static async setDisabled(
    keyId: string,
    ownerId: string | null,
    disabled: boolean,
  ) {
    const existing = await this.requireKey(keyId, ownerId)
    if (existing.revokedAt) {
      throw new ValidationError(
        'A revoked key cannot be re-enabled; create a new key instead',
      )
    }

    const [updated] = await db
      .update(apiKeys)
      .set({ disabledAt: disabled ? new Date() : null })
      .where(eq(apiKeys.id, keyId))
      .returning(publicColumns)

    if (!updated) throw new NotFoundError('API key', keyId)
    return { ...updated, status: deriveStatus(updated) }
  }

  /** Permanently retire a key. */
  static async revoke(keyId: string, ownerId: string | null) {
    const existing = await this.requireKey(keyId, ownerId)
    if (existing.revokedAt) {
      throw new ValidationError('API key is already revoked')
    }

    const [updated] = await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, keyId))
      .returning(publicColumns)

    if (!updated) throw new NotFoundError('API key', keyId)
    return { ...updated, status: deriveStatus(updated) }
  }

  /**
   * Issue a new secret for an existing key, preserving its id, scope, and
   * activity history.
   *
   * Rotation is the reason the id and the secret are separate concepts: a
   * leaked credential can be replaced without the key losing the audit trail
   * that makes the leak investigable. The old secret stops working the moment
   * this returns.
   */
  static async rotate(keyId: string, ownerId: string | null) {
    const existing = await this.requireKey(keyId, ownerId)
    if (existing.revokedAt) {
      throw new ValidationError('A revoked key cannot be rotated')
    }

    const rawKey = generateApiKey()

    const [updated] = await db
      .update(apiKeys)
      .set({
        keyHash: hashApiKey(rawKey),
        keyPrefix: getKeyPrefix(rawKey),
        rotatedAt: new Date(),
      })
      .where(eq(apiKeys.id, keyId))
      .returning(publicColumns)

    if (!updated) throw new NotFoundError('API key', keyId)
    return { key: { ...updated, status: deriveStatus(updated) }, rawKey }
  }

  /** Recent authentication activity for a key, newest first. */
  static async activity(keyId: string, ownerId: string | null, limit = 100) {
    await this.requireKey(keyId, ownerId)

    return db
      .select({
        id: apiKeyEvents.id,
        outcome: apiKeyEvents.outcome,
        method: apiKeyEvents.method,
        path: apiKeyEvents.path,
        ipAddress: apiKeyEvents.ipAddress,
        userAgent: apiKeyEvents.userAgent,
        occurredAt: apiKeyEvents.occurredAt,
      })
      .from(apiKeyEvents)
      .where(eq(apiKeyEvents.keyId, keyId))
      .orderBy(desc(apiKeyEvents.occurredAt))
      .limit(Math.min(limit, 500))
  }
}
