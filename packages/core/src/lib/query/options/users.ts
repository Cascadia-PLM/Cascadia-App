// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { collectionQuery, entityQuery } from './entities'
import type { Role, UserWithRoles } from '@/lib/auth/types'

/**
 * Every user, with the roles assigned to each.
 *
 * `/api/v1/users` also returns a `stats` rollup, but it is derivable from
 * this list — deriving it in the component keeps one cache entry rather than
 * two views of the same rows that can disagree after a write.
 */
export function userListQuery() {
  return collectionQuery<UserWithRoles>('users', 'users')
}

/**
 * Only users who can still act — the shape approver and assignee pickers
 * want, so a deactivated account cannot be added as a new approver.
 *
 * Keyed apart from `userListQuery()` by its filter, since it is a different
 * set of rows; both invalidate together off `users`.
 */
export function activeUserListQuery() {
  return collectionQuery<UserWithRoles>('users', 'users', {
    search: 'active=true',
  })
}

export function userDetailQuery(id: string) {
  return entityQuery<UserWithRoles>('users', id, 'user')
}

/** A user as the admin console sees one — the lockout clock included. */
export interface AdminUser extends UserWithRoles {
  lockedUntil: string | null
}

/**
 * Users matching an admin search.
 *
 * An empty term produces the same key as `userListQuery()`, so the two share
 * one cache entry rather than fetching the same rows twice.
 */
export function adminUserListQuery(search?: string) {
  const term = search?.trim() ?? ''
  return collectionQuery<AdminUser>('users', 'users', {
    search: term ? `search=${encodeURIComponent(term)}` : undefined,
  })
}

/** Every role — the picker behind the role-assignment dialogs. */
export function roleListQuery() {
  return collectionQuery<Role>('roles', 'roles')
}
