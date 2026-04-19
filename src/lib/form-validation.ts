import type { ZodType } from 'zod'

/**
 * Type for field-level validation errors compatible with TanStack Form
 */
export type FieldErrors = {
  fields: Record<string, string>
  form?: string
}

/**
 * Wraps a Zod schema to create a TanStack Form validator function.
 * This is needed because Zod v4 doesn't implement StandardSchemaV1
 * which TanStack Form expects for direct schema usage.
 *
 * @param schema - A Zod schema to use for validation
 * @returns A validator function compatible with TanStack Form's validators.onSubmit
 *
 * Note: The input type (TInput) is what the form submits (typically all strings),
 * while the schema output type (T) is what the schema transforms to.
 */
export function zodValidator<T, TInput = unknown>(schema: ZodType<T>) {
  return ({ value }: { value: TInput }): FieldErrors | undefined => {
    const result = schema.safeParse(value)
    if (result.success) {
      return undefined
    }

    // Convert Zod errors to TanStack Form field errors
    const fieldErrors: Record<string, string> = {}
    for (const issue of result.error.issues) {
      const path = issue.path.join('.')
      if (path && !fieldErrors[path]) {
        fieldErrors[path] = issue.message
      }
    }

    return { fields: fieldErrors }
  }
}

/**
 * Get the first error message for a specific field from validation errors
 */
export function getFieldError(
  errors: Array<FieldErrors | undefined> | undefined,
  fieldName: string,
): string | undefined {
  if (!errors) return undefined

  for (const error of errors) {
    if (error?.fields[fieldName]) {
      return error.fields[fieldName]
    }
  }
  return undefined
}

/**
 * Check if there are any validation errors
 */
export function hasErrors(
  errors: Array<FieldErrors | undefined> | undefined,
): boolean {
  if (!errors) return false
  return errors.some((error) => error && Object.keys(error.fields).length > 0)
}
