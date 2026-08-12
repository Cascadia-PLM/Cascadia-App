// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type {
  FieldOperator,
  FieldValueConfig,
  GuardContext,
  GuardResult,
  TransitionGuard,
  UserRoleConfig,
} from './types'

/**
 * Guard Evaluator for workflow/lifecycle transitions
 *
 * Evaluates guard conditions to determine if a transition is allowed.
 * Supports field validation and role checks. (Approval gating is not a
 * guard: it is enforced from the state approvers and instance-transition
 * requiredCount by the transition path itself.)
 */
export class GuardEvaluator {
  /**
   * Evaluate all guards for a transition
   */
  static evaluateAll(
    guards: Array<TransitionGuard>,
    context: GuardContext,
  ): Array<GuardResult> {
    const results: Array<GuardResult> = []

    for (const guard of guards) {
      const result = this.evaluate(guard, context)
      results.push(result)
    }

    return results
  }

  /**
   * Evaluate a single guard
   */
  static evaluate(guard: TransitionGuard, context: GuardContext): GuardResult {
    try {
      let passed = false

      switch (guard.type) {
        case 'field_value':
          passed = this.evaluateFieldValue(
            guard.config as FieldValueConfig,
            context,
          )
          break

        case 'user_role':
          passed = this.evaluateUserRole(
            guard.config as UserRoleConfig,
            context,
          )
          break

        default:
          return {
            passed: false,
            guardId: guard.id,
            guardName: guard.name,
            errorMessage: `Unknown guard type: ${guard.type}`,
          }
      }

      return {
        passed,
        guardId: guard.id,
        guardName: guard.name,
        errorMessage: passed ? undefined : guard.errorMessage,
      }
    } catch (error) {
      return {
        passed: false,
        guardId: guard.id,
        guardName: guard.name,
        errorMessage:
          error instanceof Error ? error.message : 'Guard evaluation failed',
      }
    }
  }

  /**
   * Evaluate a field_value guard
   */
  private static evaluateFieldValue(
    config: FieldValueConfig,
    context: GuardContext,
  ): boolean {
    const fieldValue = this.getNestedValue(context.item, config.fieldName)

    switch (config.operator) {
      case 'equals':
        return fieldValue === config.value

      case 'not_equals':
        return fieldValue !== config.value

      case 'contains':
        if (
          typeof fieldValue === 'string' &&
          typeof config.value === 'string'
        ) {
          return fieldValue.toLowerCase().includes(config.value.toLowerCase())
        }
        if (Array.isArray(fieldValue)) {
          return fieldValue.includes(config.value)
        }
        return false

      case 'is_empty':
        return this.isEmpty(fieldValue)

      case 'is_not_empty':
        return !this.isEmpty(fieldValue)

      case 'greater_than':
        return this.compareNumeric(fieldValue, config.value, '>')

      case 'less_than':
        return this.compareNumeric(fieldValue, config.value, '<')

      case 'greater_or_equal':
        return this.compareNumeric(fieldValue, config.value, '>=')

      case 'less_or_equal':
        return this.compareNumeric(fieldValue, config.value, '<=')

      default:
        throw new Error(`Unknown operator: ${config.operator}`)
    }
  }

  /**
   * Evaluate a user_role guard
   */
  private static evaluateUserRole(
    config: UserRoleConfig,
    context: GuardContext,
  ): boolean {
    const userRoles = context.user.roles

    if (config.requireAll) {
      // User must have ALL required roles
      return config.requiredRoles.every((role) => userRoles.includes(role))
    } else {
      // User must have ANY of the required roles
      return config.requiredRoles.some((role) => userRoles.includes(role))
    }
  }

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Get a nested value from an object using dot notation
   * e.g., "part.material" or "changeOrder.reasonForChange"
   */
  private static getNestedValue(
    obj: Record<string, unknown>,
    path: string,
  ): unknown {
    const parts = path.split('.')
    let current: unknown = obj

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined
      }
      if (typeof current !== 'object') {
        return undefined
      }
      current = (current as Record<string, unknown>)[part]
    }

    return current
  }

  /**
   * Check if a value is empty
   */
  private static isEmpty(value: unknown): boolean {
    if (value === null || value === undefined) {
      return true
    }
    if (typeof value === 'string') {
      return value.trim() === ''
    }
    if (Array.isArray(value)) {
      return value.length === 0
    }
    if (typeof value === 'object') {
      return Object.keys(value).length === 0
    }
    return false
  }

  /**
   * Compare numeric values
   */
  private static compareNumeric(
    a: unknown,
    b: unknown,
    operator: '>' | '<' | '>=' | '<=',
  ): boolean {
    const numA = this.toNumber(a)
    const numB = this.toNumber(b)

    if (numA === null || numB === null) {
      return false
    }

    switch (operator) {
      case '>':
        return numA > numB
      case '<':
        return numA < numB
      case '>=':
        return numA >= numB
      case '<=':
        return numA <= numB
      default:
        return false
    }
  }

  /**
   * Convert a value to a number
   */
  private static toNumber(value: unknown): number | null {
    if (typeof value === 'number') {
      return value
    }
    if (typeof value === 'string') {
      const num = parseFloat(value)
      return isNaN(num) ? null : num
    }
    return null
  }

  // ============================================
  // Context Building Helpers
  // ============================================

  /**
   * Build a guard context from raw data
   */
  static buildContext(
    itemData: Record<string, unknown>,
    userId: string,
    userRoles: Array<string>,
    workflowInstance?: {
      currentState: string
      startedAt: Date
    },
  ): GuardContext {
    return {
      item: itemData,
      user: {
        id: userId,
        roles: userRoles,
      },
      workflowInstance: workflowInstance as any,
    }
  }
}

/**
 * Export common guard presets for convenience
 */
export const GuardPresets = {
  /**
   * Field must not be empty
   */
  requiredField(
    fieldName: string,
    errorMessage?: string,
  ): Omit<TransitionGuard, 'id'> {
    return {
      name: `${fieldName} required`,
      type: 'field_value',
      config: {
        fieldName,
        operator: 'is_not_empty' as FieldOperator,
      },
      errorMessage: errorMessage || `${fieldName} is required`,
    }
  },

  /**
   * Field must equal a specific value
   */
  fieldEquals(
    fieldName: string,
    value: string | number | boolean,
    errorMessage?: string,
  ): Omit<TransitionGuard, 'id'> {
    return {
      name: `${fieldName} equals ${value}`,
      type: 'field_value',
      config: {
        fieldName,
        operator: 'equals' as FieldOperator,
        value,
      },
      errorMessage: errorMessage || `${fieldName} must be ${value}`,
    }
  },

  /**
   * User must have one of the specified roles
   */
  hasRole(
    roles: Array<string>,
    errorMessage?: string,
  ): Omit<TransitionGuard, 'id'> {
    return {
      name: `Requires role: ${roles.join(' or ')}`,
      type: 'user_role',
      config: {
        requiredRoles: roles,
        requireAll: false,
      },
      errorMessage:
        errorMessage ||
        `User must have one of these roles: ${roles.join(', ')}`,
    }
  },
}
