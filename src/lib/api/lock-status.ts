/**
 * Unified Lock Status Schema
 *
 * Provides consistent lock/checkout status representation across all API endpoints.
 *
 * Three lock contexts in Cascadia:
 * 1. Item Lock - Exclusive edit rights for concurrent access control
 * 2. File Lock - CAD-specific file lock for external tool integration
 * 3. Checkout - Branch-scoped edit session for PLM workflow
 *
 * This module provides:
 * - Unified TypeScript types
 * - Zod validation schemas
 * - Helper functions for creating lock status responses
 */

import { z } from 'zod'

/**
 * User reference for who holds a lock.
 */
export const lockHolderSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  email: z.string().email(),
})

export type LockHolder = z.infer<typeof lockHolderSchema>

/**
 * Lock scope indicates what resources are affected by the lock.
 */
export const lockScopeSchema = z.enum(['item', 'cascade', 'file'])

export type LockScope = z.infer<typeof lockScopeSchema>

/**
 * Lock type for distinguishing different locking mechanisms.
 */
export const lockTypeSchema = z.enum(['lock', 'checkout', 'file_lock'])

export type LockType = z.infer<typeof lockTypeSchema>

/**
 * Active lock details when isLocked is true.
 */
const activeLockDetailsSchema = z.object({
  lockedBy: lockHolderSchema,
  lockedAt: z.string().datetime(),
  lockedFor: z.number().int().min(0).optional(), // Duration in minutes
  scope: lockScopeSchema.optional(),
  branchId: z.string().uuid().optional(), // For checkout locks
  branchName: z.string().optional(), // For checkout locks
})

/**
 * Unified lock status schema - represents lock state for any resource.
 *
 * When not locked:
 * ```json
 * { "isLocked": false }
 * ```
 *
 * When locked:
 * ```json
 * {
 *   "isLocked": true,
 *   "lockType": "lock",
 *   "lockedBy": { "id": "...", "name": "John Doe", "email": "john@example.com" },
 *   "lockedAt": "2024-01-15T10:30:00.000Z",
 *   "lockedFor": 45,
 *   "scope": "item"
 * }
 * ```
 */
export const lockStatusSchema = z.discriminatedUnion('isLocked', [
  z.object({
    isLocked: z.literal(false),
    lockType: lockTypeSchema.optional(),
  }),
  z
    .object({
      isLocked: z.literal(true),
      lockType: lockTypeSchema.optional(),
    })
    .merge(activeLockDetailsSchema),
])

export type LockStatus = z.infer<typeof lockStatusSchema>

/**
 * Create an unlocked status response.
 */
export function createUnlockedStatus(lockType?: LockType): LockStatus {
  return {
    isLocked: false,
    ...(lockType && { lockType }),
  }
}

/**
 * Create a locked status response.
 */
export function createLockedStatus(params: {
  lockedBy: LockHolder
  lockedAt: Date
  lockType?: LockType
  lockedFor?: number
  scope?: LockScope
  branchId?: string
  branchName?: string
}): LockStatus {
  return {
    isLocked: true,
    lockType: params.lockType,
    lockedBy: params.lockedBy,
    lockedAt: params.lockedAt.toISOString(),
    ...(params.lockedFor !== undefined && { lockedFor: params.lockedFor }),
    ...(params.scope && { scope: params.scope }),
    ...(params.branchId && { branchId: params.branchId }),
    ...(params.branchName && { branchName: params.branchName }),
  }
}

/**
 * Calculate lock duration in minutes from lock timestamp.
 */
export function calculateLockDuration(lockedAt: Date | string): number {
  const lockTime = typeof lockedAt === 'string' ? new Date(lockedAt) : lockedAt
  return Math.floor((Date.now() - lockTime.getTime()) / 1000 / 60)
}

/**
 * Checkout status schema - extends lock status with checkout-specific fields.
 *
 * Checkouts are branch-scoped edit sessions used in PLM workflows.
 * The response uses the same structure as lock status but includes
 * additional branch context.
 */
export const checkoutStatusSchema = z.discriminatedUnion('isCheckedOut', [
  z.object({
    isCheckedOut: z.literal(false),
  }),
  z.object({
    isCheckedOut: z.literal(true),
    checkedOutBy: lockHolderSchema,
    checkedOutAt: z.string().datetime(),
    branchId: z.string().uuid(),
    branchName: z.string().optional(),
  }),
])

export type CheckoutStatusResponse = z.infer<typeof checkoutStatusSchema>

/**
 * Create a not-checked-out status response.
 */
export function createNotCheckedOutStatus(): CheckoutStatusResponse {
  return { isCheckedOut: false }
}

/**
 * Create a checked-out status response.
 */
export function createCheckedOutStatus(params: {
  checkedOutBy: LockHolder
  checkedOutAt: Date
  branchId: string
  branchName?: string
}): CheckoutStatusResponse {
  return {
    isCheckedOut: true,
    checkedOutBy: params.checkedOutBy,
    checkedOutAt: params.checkedOutAt.toISOString(),
    branchId: params.branchId,
    ...(params.branchName && { branchName: params.branchName }),
  }
}

/**
 * Convert a checkout status to a unified lock status.
 * Useful for presenting checkouts in lock-aware UIs.
 */
export function checkoutToLockStatus(
  checkout: CheckoutStatusResponse,
): LockStatus {
  if (!checkout.isCheckedOut) {
    return createUnlockedStatus('checkout')
  }

  return createLockedStatus({
    lockedBy: checkout.checkedOutBy,
    lockedAt: new Date(checkout.checkedOutAt),
    lockType: 'checkout',
    branchId: checkout.branchId,
    branchName: checkout.branchName,
  })
}
