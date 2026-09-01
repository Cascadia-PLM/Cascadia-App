// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Children, cloneElement, isValidElement, useId } from 'react'
import { Label } from './Label'
import type { ReactElement, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The id of the first child that brings its own. A label points at one
 * control, so the first form control wins when several are nested here.
 */
function findChildId(children: ReactNode): string | undefined {
  for (const child of Children.toArray(children)) {
    if (isValidElement(child)) {
      const { id } = (child as ReactElement<{ id?: string }>).props
      if (id) {
        return id
      }
    }
  }
  return undefined
}

export interface FormFieldProps {
  label?: string
  error?: string
  helpText?: string
  required?: boolean
  children: ReactNode
  className?: string
  /** Optional ID for the form control. If not provided, one will be auto-generated. */
  id?: string
}

export function FormField({
  label,
  error,
  helpText,
  required,
  children,
  className,
  id: providedId,
}: FormFieldProps) {
  const generatedId = useId()
  // A child that already carries an id keeps it (the clone below only fills
  // one in when it is missing), so the label and the described-by ids have to
  // follow that id rather than the generated one they would never match.
  const fieldId = providedId ?? findChildId(children) ?? generatedId
  const errorId = `${fieldId}-error`
  const helpId = `${fieldId}-help`

  // Determine aria-describedby value
  const describedBy = error ? errorId : helpText ? helpId : undefined

  // Clone children to add accessibility props
  const childrenWithAriaProps = Children.map(children, (child) => {
    if (isValidElement(child)) {
      const childElement = child as ReactElement<{
        id?: string
        name?: string
        'aria-describedby'?: string
        'aria-invalid'?: boolean
        'aria-required'?: boolean
      }>
      const ariaProps: Record<string, unknown> = {}

      // Add id if not already present
      if (!childElement.props.id) {
        ariaProps.id = fieldId
      }

      // Add accessibility attributes
      if (describedBy) {
        ariaProps['aria-describedby'] = describedBy
      }
      if (error) {
        ariaProps['aria-invalid'] = true
      }
      if (required) {
        ariaProps['aria-required'] = true
      }

      if (Object.keys(ariaProps).length > 0) {
        return cloneElement(childElement, ariaProps)
      }
    }
    return child
  })

  return (
    <div className={cn('space-y-2', className)}>
      {label && (
        <Label htmlFor={fieldId}>
          {label}
          {required && (
            <span className="text-red-500 ml-1" aria-hidden="true">
              *
            </span>
          )}
        </Label>
      )}
      {childrenWithAriaProps}
      {helpText && !error && (
        <p id={helpId} className="text-sm text-slate-500 dark:text-slate-400">
          {helpText}
        </p>
      )}
      {error && (
        <p
          id={errorId}
          role="alert"
          className="text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      )}
    </div>
  )
}
