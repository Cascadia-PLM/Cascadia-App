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
import { safeErrorMessage } from '@/lib/errors/pg'
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
 * Re-raise a failed tool call with a message the model may see.
 *
 * Both surfaces that run these handlers — TanStack AI for the in-app chatbot,
 * the MCP server for external agents — put the thrown `message` straight into
 * the tool result they hand back to the model. A database failure's message is
 * the failed SQL and its bound parameters, so it is swapped for a generic one
 * and kept only in the server log; every other message (not-found, validation,
 * permission denied) is what the model needs to correct course and survives
 * untouched.
 */
function rethrowSafely(error: unknown, toolName: string): never {
  const safe = safeErrorMessage(error, 'Tool execution failed')
  if (error instanceof Error && safe !== error.message) {
    aiLogger.error({ err: error, toolName }, 'AI tool failed')
    throw new Error(safe, { cause: error })
  }
  throw error
}

/**
 * Permission specification for a tool
 */
export interface PermissionSpec {
  resource: ResourceType
  action: PermissionAction
}

/**
 * How a tool declares the permission a call has to satisfy.
 *
 * A constant covers the tools whose target is fixed by the tool itself —
 * `create_program` always charges `programs`. The resolver form is for the
 * tools that write whatever the caller names: `update_item` and
 * `transition_item_state` reach every registered item type through one entry
 * point, so the resource to charge is a property of the *input*, not of the
 * tool.
 *
 * Resolving here rather than inside the handler is the whole point. The
 * wrapper is the only RBAC gate on these paths — neither `ItemService` nor
 * `LifecycleService` re-checks below it — and `checkToolPermission`
 * intersects an API key's scope with the user's role permissions, so a
 * handler-side check would be a second, weaker gate that MCP callers could
 * hold a narrower key than.
 */
export type ToolPermission<TInput> =
  PermissionSpec | ((input: TInput) => Promise<PermissionSpec>)

/** Narrow a tool's declared permission to the tuple this call must satisfy. */
async function resolvePermission<TInput>(
  permission: ToolPermission<TInput>,
  input: TInput,
): Promise<PermissionSpec> {
  return typeof permission === 'function' ? permission(input) : permission
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
      error = safeErrorMessage(e, 'Unknown error')
      rethrowSafely(e, toolName)
    } finally {
      // Log tool usage for audit trail
      const durationMs = Date.now() - startTime

      try {
        await db.insert(aiUsageLogs).values({
          sessionId: context.sessionId || null,
          userId: context.userId,
          programId: context.programId || null,
          toolName,
          toolParams: input,
          toolResult: error ? null : result,
          error,
          durationMs,
          provider: context.provider || null,
          model: context.model || null,
          // Token counts are not a per-tool quantity: they live on the
          // stream's done chunks, which this wrapper never sees. The chat
          // route records them per request via lib/ai/usage.ts.
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
 *
 * `permission` may be a resolver (see `ToolPermission`); it runs inside the
 * try/finally so a failed lookup is audit-logged and re-raised safely rather
 * than escaping unrecorded.
 */
export function withWritePermissionAndAudit<TInput, TOutput>(
  toolName: string,
  permission: ToolPermission<TInput>,
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
      const required = await resolvePermission(permission, input)
      const permitted = await checkToolPermission(context, required)

      if (!permitted) {
        throw new Error(
          `Permission denied: You don't have ${required.action} access to ${required.resource}`,
        )
      }

      result = await handler(input, context)
      return result
    } catch (e) {
      error = safeErrorMessage(e, 'Unknown error')
      rethrowSafely(e, toolName)
    } finally {
      const durationMs = Date.now() - startTime

      try {
        await db.insert(aiUsageLogs).values({
          sessionId: context.sessionId || null,
          userId: context.userId,
          programId: context.programId || null,
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
