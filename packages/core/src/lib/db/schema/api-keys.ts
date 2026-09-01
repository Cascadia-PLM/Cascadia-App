// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { users } from './users'

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    keyHash: varchar('key_hash', { length: 255 }).notNull(),
    keyPrefix: varchar('key_prefix', { length: 12 }).notNull(),
    /**
     * Permission scope: `{ resource: [actions] }`. NULL means the key inherits
     * the owner's full role-derived permissions.
     */
    permissions: jsonb('permissions').$type<Record<string, Array<string>>>(),
    /**
     * Role scope: the role names this key may exercise at `requireRole` gates.
     * NULL means the key inherits every role its owner holds.
     *
     * Roles are a *separate* axis from `permissions` — `intersectPermissions`
     * has no vocabulary for them, so without this column a key scoped to
     * `{ parts: ['read'] }` still passed `requireRole('Administrator')` purely
     * because its owner is an admin. Like permissions, this can only narrow:
     * the owner must still actually hold the role.
     */
    roles: jsonb('roles').$type<Array<string>>(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    /**
     * Reversible deactivation. A disabled key authenticates nothing but keeps
     * its identity, scope, and history, so a client suspected of misbehaving
     * can be switched off and back on without reissuing credentials.
     *
     * Deliberately distinct from `revokedAt`: revocation is permanent and the
     * secret can never be honoured again. Disabling is an operational pause;
     * revoking is a security decision. Collapsing them would make an admin
     * choose between "I can undo this" and "this is definitely dead".
     */
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** When the key's secret was last rotated, if ever. */
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  },
  (table) => [
    // The authentication lookup key. Every request presenting an API key
    // resolves it by this hash, and the table carried neither a constraint
    // nor an index for it: the lookup was a sequential scan, and nothing
    // stopped two rows from claiming the same secret. Unique does both jobs
    // in one line. A collision is cryptographically implausible — the hash
    // is SHA-256 of a 256-bit random secret — so a rejected insert here is
    // a bug worth failing loudly on, not a case to recover from.
    uniqueIndex('uq_api_keys_key_hash').on(table.keyHash),
  ],
)

/**
 * Authentication activity for a key.
 *
 * Successes are sampled rather than exhaustive (see `recordKeyEvent` — one row
 * per key per minute), because a CI or CAD connector key can drive thousands
 * of requests a day and an exact per-request log would cost far more than the
 * question it answers. Failures are always recorded: they are rare, and each
 * one is the interesting case — a revoked key still in use, a key that
 * outlived its expiry, a scope that is narrower than the client assumes.
 */
export const apiKeyEvents = pgTable(
  'api_key_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * No cascade to a hard delete: keys are revoked, never deleted, so the
     * reference stays valid for the life of the row.
     */
    keyId: uuid('key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    /**
     * What happened at the auth boundary. `success` means the key resolved;
     * everything else is a rejection reason.
     */
    outcome: varchar('outcome', { length: 32 }).notNull(),
    method: varchar('method', { length: 10 }),
    path: text('path'),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // The activity view is always "this key, newest first".
    index('api_key_events_key_id_occurred_at_idx').on(
      table.keyId,
      table.occurredAt,
    ),
  ],
)

export type ApiKeyEventOutcome =
  'success' | 'expired' | 'disabled' | 'revoked' | 'inactive_user'

export const apiKeysRelations = relations(apiKeys, ({ one, many }) => ({
  user: one(users, {
    fields: [apiKeys.userId],
    references: [users.id],
  }),
  events: many(apiKeyEvents),
}))

export const apiKeyEventsRelations = relations(apiKeyEvents, ({ one }) => ({
  key: one(apiKeys, {
    fields: [apiKeyEvents.keyId],
    references: [apiKeys.id],
  }),
}))
