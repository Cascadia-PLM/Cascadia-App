// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Permission Checking and Audit Logging Wrapper for AI Tools
 *
 * This module provides a wrapper function that adds permission checking
 * and audit logging to AI tool handlers.
 */

import type { PermissionAction, ResourceType } from '@/lib/auth/permissions'

import { permissionService } from '@/lib/auth/permission-service'
import { hasPermission } from '@/lib/auth/permissions'
import { intersectPermissions } from '@/lib/auth/api-key-utils'
import { db } from '@/lib/db'
import { aiUsageLogs } from '@/lib/db/schema/ai'
import { aiLogger } from '@/lib/logging/logger'

/**
 * Context passed to each tool handler for permission checking and audit logging
 */
export interface ToolContext {
  userId: string
  sessionId?: string
  programId?: string
  designId?: string
  provider?: string
  model?: string
  /**
   * API key scope when the tool is invoked over MCP with a scoped key.
   * Null/undefined means full user permissions (in-app chat sessions and
   * full-scope keys). Keys can only narrow access, never widen it.
   */
  keyScope?: Record<string, Array<string>> | null
}

/**
 * Check a tool permission for the given context.
 *
 * Session-backed calls check role permissions directly. Calls carrying an
 * API key scope intersect that scope with the user's role permissions —
 * mirroring the enforcement in apiHandler() for REST routes.
 */
async function checkToolPermission(
  context: ToolContext,
  permission: PermissionSpec,
): Promise<boolean> {
  if (context.keyScope) {
    const userPermissions = await permissionService.getUserPermissions(
      context.userId,
    )
    const effective = intersectPermissions(userPermissions, context.keyScope)
    return hasPermission(effective, permission.resource, permission.action)
  }

  return permissionService.canUser(
    context.userId,
    permission.action,
    permission.resource,
  )
}

/**
 * Permission specification for a tool
 */
export interface PermissionSpec {
  resource: ResourceType
  action: PermissionAction
}

/**
 * Wrap a tool handler with permission checking and audit logging
 *
 * This wrapper:
 * 1. Checks if the user has the required permission
 * 2. Executes the handler if permitted
 * 3. Logs the tool usage to the audit table (success or failure)
 *
 * @param toolName - Name of the tool for audit logging
 * @param permission - Required permission (resource + action)
 * @param handler - The actual tool implementation
 */
export function withPermissionAndAudit<TInput, TOutput>(
  toolName: string,
  permission: PermissionSpec,
  handler: (input: TInput, context: ToolContext) => Promise<TOutput>,
) {
  return async (input: TInput, context: ToolContext): Promise<TOutput> => {
    const startTime = Date.now()
    let result: TOutput | undefined
    let error: string | null = null

    try {
      const permitted = await checkToolPermission(context, permission)

      if (!permitted) {
        throw new Error(
          `Permission denied: You don't have ${permission.action} access to ${permission.resource}`,
        )
      }

      // Execute the handler
      result = await handler(input, context)
      return result
    } catch (e) {
      error = e instanceof Error ? e.message : 'Unknown error'
      throw e
    } finally {
      // Log tool usage for audit trail
      const durationMs = Date.now() - startTime

      try {
        await db.insert(aiUsageLogs).values({
          sessionId: context.sessionId || null,
          userId: context.userId,
          toolName,
          toolParams: input,
          toolResult: error ? null : result,
          error,
          durationMs,
          provider: context.provider || null,
          model: context.model || null,
          // TODO: inputTokens/outputTokens - TanStack AI streaming doesn't expose token counts directly
        })
      } catch (logError) {
        // Don't fail the tool execution if logging fails
        aiLogger.error({ err: logError }, 'Failed to log tool usage')
      }
    }
  }
}

/**
 * Metadata for write operations, used for audit logging
 */
export interface WriteOperationMeta {
  actionType: string
  affectedItemIds: Array<string>
  wasConfirmed: boolean
  transactionId: string
}

/**
 * Wrap a write tool handler with permission checking and audit logging.
 * Same as withPermissionAndAudit but accepts WriteOperationMeta for richer audit trails.
 */
export function withWritePermissionAndAudit<TInput, TOutput>(
  toolName: string,
  permission: PermissionSpec,
  handler: (input: TInput, context: ToolContext) => Promise<TOutput>,
) {
  return async (
    input: TInput,
    context: ToolContext,
    meta: WriteOperationMeta,
  ): Promise<TOutput> => {
    const startTime = Date.now()
    let result: TOutput | undefined
    let error: string | null = null

    try {
      const permitted = await checkToolPermission(context, permission)

      if (!permitted) {
        throw new Error(
          `Permission denied: You don't have ${permission.action} access to ${permission.resource}`,
        )
      }

      result = await handler(input, context)
      return result
    } catch (e) {
      error = e instanceof Error ? e.message : 'Unknown error'
      throw e
    } finally {
      const durationMs = Date.now() - startTime

      try {
        await db.insert(aiUsageLogs).values({
          sessionId: context.sessionId || null,
          userId: context.userId,
          toolName,
          toolParams: {
            ...(input as Record<string, unknown>),
            _meta: meta,
          },
          toolResult: error ? null : result,
          error,
          durationMs,
          provider: context.provider || null,
          model: context.model || null,
        })
      } catch (logError) {
        aiLogger.error({ err: logError }, 'Failed to log write tool usage')
      }
    }
  }
}
