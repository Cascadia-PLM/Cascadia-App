// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { useForm } from '@tanstack/react-form'
import { z } from 'zod'
import {
  DEFAULT_BRANCH_PROTECTION_SCOPE,
  branchProtectionScopeOf,
  branchProtectionScopeSchema,
} from '@cascadia/commons/types/program'
import type {
  BranchProtectionScope,
  CreateProgramInput,
  Program,
} from '@cascadia/commons/types/program'
import { zodValidator } from '@/form-validation'
import { useSystemAccess } from '@/hooks/usePermissions'
import {
  Button,
  FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@/components/ui'
import { AttributesEditor } from '@/components/items/AttributesEditor'

const programFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  code: z
    .string()
    .min(1, 'Code is required')
    .max(50)
    .regex(/^[A-Z0-9-]+$/, 'Code must be uppercase alphanumeric with hyphens'),
  description: z.string().optional(),
  contractNumber: z.string().max(100).optional(),
  customer: z.string().max(200).optional(),
  startDate: z.string().optional(),
  targetEndDate: z.string().optional(),
  status: z.enum(['Active', 'On Hold', 'Completed', 'Cancelled']).optional(),
  branchProtectionScope: branchProtectionScopeSchema,
})

interface ProgramFormProps {
  program?: Partial<Program>
  onSubmit: (data: CreateProgramInput) => void | Promise<void>
  onCancel?: () => void
  isSubmitting?: boolean
}

export function ProgramForm({
  program,
  onSubmit,
  onCancel,
  isSubmitting,
}: ProgramFormProps) {
  const [attributes, setAttributes] = useState<Record<string, unknown>>(
    program?.attributes || {},
  )
  // The scope decides what a protected main refuses for every design in the
  // program; the server charges `system:manage` to change it. Offered only to
  // those who hold it — the server enforces it regardless.
  const { canManage: mayChangeScope } = useSystemAccess()
  const storedScope = program
    ? branchProtectionScopeOf(program.settings)
    : DEFAULT_BRANCH_PROTECTION_SCOPE

  const form = useForm({
    defaultValues: {
      name: program?.name || '',
      code: program?.code || '',
      description: program?.description || '',
      contractNumber: program?.contractNumber || '',
      customer: program?.customer || '',
      startDate: program?.startDate
        ? new Date(program.startDate).toISOString().split('T')[0]
        : '',
      targetEndDate: program?.targetEndDate
        ? new Date(program.targetEndDate).toISOString().split('T')[0]
        : '',
      status:
        (program?.status as
          'Active' | 'On Hold' | 'Completed' | 'Cancelled' | undefined) ??
        'Active',
      branchProtectionScope: storedScope,
    },
    validators: {
      onSubmit: zodValidator(programFormSchema),
    },
    onSubmit: async ({ value }) => {
      const submissionData: CreateProgramInput = {
        name: value.name,
        code: value.code.toUpperCase(),
        description: value.description || undefined,
        contractNumber: value.contractNumber || undefined,
        customer: value.customer || undefined,
        startDate: value.startDate || undefined,
        targetEndDate: value.targetEndDate || undefined,
        status: value.status,
        attributes: attributes,
        // Only the key this form edits, and only when it changed: the server
        // merges settings into what is stored, so echoing the rest back could
        // only fail on a key it no longer accepts, and an unchanged scope needs
        // no authority.
        ...(value.branchProtectionScope !== storedScope && {
          settings: { branchProtectionScope: value.branchProtectionScope },
        }),
      }
      await onSubmit(submissionData)
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        e.stopPropagation()
        form.handleSubmit()
      }}
      className="space-y-6"
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Name */}
        <form.Field name="name">
          {(field) => (
            <FormField
              label="Program Name"
              required
              error={field.state.meta.errors[0]}
              className="md:col-span-2"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="F-35 Lightning II Program"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Code */}
        <form.Field name="code">
          {(field) => (
            <FormField
              label="Program Code"
              required
              error={field.state.meta.errors[0]}
              helpText="Unique identifier (uppercase, hyphens allowed)"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) =>
                  field.handleChange(e.target.value.toUpperCase())
                }
                onBlur={field.handleBlur}
                placeholder="F35-PROG"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Status */}
        <form.Field name="status">
          {(field) => (
            <FormField label="Status" error={field.state.meta.errors[0]}>
              <Select
                value={field.state.value}
                onValueChange={(value) =>
                  field.handleChange(
                    value as 'Active' | 'On Hold' | 'Completed' | 'Cancelled',
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Active">Active</SelectItem>
                  <SelectItem value="On Hold">On Hold</SelectItem>
                  <SelectItem value="Completed">Completed</SelectItem>
                  <SelectItem value="Cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}
        </form.Field>

        {/* Description */}
        <form.Field name="description">
          {(field) => (
            <FormField
              label="Description"
              error={field.state.meta.errors[0]}
              className="md:col-span-2"
            >
              <Textarea
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Program description..."
                rows={3}
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Customer */}
        <form.Field name="customer">
          {(field) => (
            <FormField label="Customer" error={field.state.meta.errors[0]}>
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="U.S. Department of Defense"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Contract Number */}
        <form.Field name="contractNumber">
          {(field) => (
            <FormField
              label="Contract Number"
              error={field.state.meta.errors[0]}
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="FA8615-09-C-6000"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Start Date */}
        <form.Field name="startDate">
          {(field) => (
            <FormField label="Start Date" error={field.state.meta.errors[0]}>
              <Input
                name={field.name}
                type="date"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Target End Date */}
        <form.Field name="targetEndDate">
          {(field) => (
            <FormField
              label="Target End Date"
              error={field.state.meta.errors[0]}
            >
              <Input
                name={field.name}
                type="date"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Branch protection scope */}
        <form.Field name="branchProtectionScope">
          {(field) => (
            <FormField
              label="Branch protection"
              helpText={
                mayChangeScope
                  ? 'What main protects once a design in this program has released items. "Released items only" still protects everything in the structure beneath a released item.'
                  : 'What main protects once a design in this program has released items. Changing it requires an administrator.'
              }
              error={field.state.meta.errors[0]}
              className="md:col-span-2"
            >
              <Select
                value={field.state.value}
                onValueChange={(value) =>
                  field.handleChange(value as BranchProtectionScope)
                }
                disabled={!mayChangeScope}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select protection scope" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="design">
                    Whole design (default) — any release protects all items
                  </SelectItem>
                  <SelectItem value="released-items">
                    Released items only — and everything beneath them in the
                    structure; other drafts stay editable on main
                  </SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}
        </form.Field>
      </div>

      {/* Custom Attributes */}
      <div className="mt-6">
        <AttributesEditor
          value={attributes}
          onChange={setAttributes}
          disabled={isSubmitting}
        />
      </div>

      {/* Form Actions */}
      <div className="flex justify-end gap-3 pt-4 border-t">
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting
            ? 'Saving...'
            : program?.id
              ? 'Update Program'
              : 'Create Program'}
        </Button>
      </div>
    </form>
  )
}
