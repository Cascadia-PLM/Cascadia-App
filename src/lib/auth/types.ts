import { z } from 'zod'

/**
 * Shared auth types that can be safely imported on both client and server
 * These types don't depend on any server-only modules
 */

/**
 * User type for client-side consumption
 */
export interface User {
  id: string
  email: string
  name: string | null
  provider: string | null
  providerId: string | null
  active: boolean
  lastLogin: Date | null
  createdAt: Date
}

/**
 * Role type for client-side consumption
 */
export interface Role {
  id: string
  name: string
  description: string | null
  permissions: Record<string, Array<string>> | null
}

/**
 * User with roles for display purposes
 */
export interface UserWithRoles extends User {
  roles: Array<Role>
}

/**
 * Validation schema for creating a new user
 */
export const userCreateSchema = z.object({
  email: z.string().email('Invalid email address'),
  name: z.string().min(1, 'Name is required').max(255),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must not exceed 128 characters'),
  provider: z.enum(['local', 'azure', 'google', 'github']).default('local'),
  providerId: z.string().optional(),
  active: z.boolean().default(true),
})

/**
 * Validation schema for updating a user
 */
export const userUpdateSchema = z.object({
  email: z.string().email('Invalid email address').optional(),
  name: z.string().min(1, 'Name is required').max(255).optional(),
  active: z.boolean().optional(),
  provider: z.enum(['local', 'azure', 'google', 'github']).optional(),
  providerId: z.string().nullable().optional(),
})

/**
 * Validation schema for password change
 */
export const passwordChangeSchema = z.object({
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must not exceed 128 characters'),
})
