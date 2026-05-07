import { useEffect, useState } from 'react'
import { useForm, useStore } from '@tanstack/react-form'
import { z } from 'zod'
import type { CreateDesignInput, Design } from '@/lib/types/design'
import type { Program } from '@/lib/types/program'
import { zodValidator } from '@/lib/form-validation'
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

interface FamilyDesign {
  id: string
  code: string
  name: string
}

const designFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  code: z
    .string()
    .min(1, 'Code is required')
    .max(50)
    .regex(/^[A-Z0-9-]+$/, 'Code must be uppercase alphanumeric with hyphens'),
  description: z.string().optional(),
  designType: z.enum(['Engineering', 'Library', 'Family']).optional(),
  programId: z
    .string()
    .transform((val) => (val === '' ? null : val))
    .nullable()
    .refine(
      (val) => val === null || z.string().uuid().safeParse(val).success,
      'Invalid program selection',
    ),
  parentDesignId: z
    .string()
    .transform((val) => (val === '' || val === 'none' ? null : val))
    .nullable()
    .refine(
      (val) => val === null || z.string().uuid().safeParse(val).success,
      'Invalid family selection',
    ),
  plannedQuantity: z
    .string()
    .transform((val) => (val === '' ? null : parseInt(val, 10)))
    .nullable()
    .refine(
      (val) => val === null || (Number.isInteger(val) && val > 0),
      'Must be a positive integer',
    ),
})

interface DesignFormProps {
  design?: Partial<Design>
  programs?: Array<Program>
  defaultProgramId?: string
  onSubmit: (data: CreateDesignInput) => void | Promise<void>
  onCancel?: () => void
  isSubmitting?: boolean
}

export function DesignForm({
  design,
  programs = [],
  defaultProgramId,
  onSubmit,
  onCancel,
  isSubmitting,
}: DesignFormProps) {
  const [families, setFamilies] = useState<Array<FamilyDesign>>([])
  const [loadingFamilies, setLoadingFamilies] = useState(false)

  const form = useForm({
    defaultValues: {
      name: design?.name || '',
      code: design?.code || '',
      description: design?.description || '',
      designType:
        (design?.designType as
          | 'Engineering'
          | 'Library'
          | 'Family'
          | undefined) ?? 'Engineering',
      programId: design?.programId || defaultProgramId || '',
      parentDesignId: design?.parentDesignId || '',
      plannedQuantity: design?.plannedQuantity?.toString() || '',
    },
    validators: {
      onSubmit: zodValidator(designFormSchema),
    },
    onSubmit: async ({ value }) => {
      // Form stores values as strings; convert for submission
      const submissionData: CreateDesignInput = {
        name: value.name,
        code: value.code.toUpperCase(),
        description: value.description || undefined,
        designType: value.designType,
        programId: value.programId || null,
        parentDesignId: value.parentDesignId || null,
        plannedQuantity: value.plannedQuantity
          ? parseInt(value.plannedQuantity, 10)
          : undefined,
      }
      await onSubmit(submissionData)
    },
  })

  // Watch programId and designType to fetch families
  const programId = useStore(form.store, (state) => state.values.programId)
  const designType = useStore(form.store, (state) => state.values.designType)

  // Fetch available families when programId changes
  useEffect(() => {
    const fetchFamilies = async () => {
      setLoadingFamilies(true)
      try {
        const params = programId ? `?programId=${programId}` : ''
        const response = await fetch(`/api/v1/designs/families${params}`)
        if (response.ok) {
          const { data } = await response.json()
          setFamilies(data?.families || [])
        }
      } catch {
        setFamilies([])
      } finally {
        setLoadingFamilies(false)
      }
    }

    fetchFamilies()
  }, [programId])

  // Clear parentDesignId when changing to family type
  useEffect(() => {
    if (designType === 'Family') {
      form.setFieldValue('parentDesignId', '')
    }
  }, [designType, form])

  const isEditMode = !!design?.id
  const showParentSelector = designType !== 'Family' && designType !== 'Library'

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
              label="Design Name"
              required
              error={field.state.meta.errors[0] as string | undefined}
              className="md:col-span-2"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="UAV Type 1 Configuration"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Code */}
        <form.Field name="code">
          {(field) => (
            <FormField
              label="Design Code"
              required
              error={field.state.meta.errors[0] as string | undefined}
              helpText="Unique identifier (uppercase, hyphens allowed)"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) =>
                  field.handleChange(e.target.value.toUpperCase())
                }
                onBlur={field.handleBlur}
                placeholder="UAV-T1"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Design Type */}
        <form.Field name="designType">
          {(field) => (
            <FormField
              label="Type"
              error={field.state.meta.errors[0] as string | undefined}
              helpText={
                field.state.value === 'Family'
                  ? 'A family groups related variant designs'
                  : undefined
              }
            >
              <Select
                value={field.state.value}
                onValueChange={(value) =>
                  field.handleChange(
                    value as 'Engineering' | 'Library' | 'Family',
                  )
                }
                disabled={isEditMode}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Engineering">Engineering</SelectItem>
                  <SelectItem value="Family">Family</SelectItem>
                  <SelectItem value="Library">Library</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}
        </form.Field>

        {/* Program */}
        <form.Field name="programId">
          {(field) => (
            <FormField
              label="Program"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="Optional program association"
            >
              <Select
                value={field.state.value || 'none'}
                onValueChange={(value) =>
                  field.handleChange(value === 'none' ? '' : value)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select program (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No Program</SelectItem>
                  {programs.map((program) => (
                    <SelectItem key={program.id} value={program.id}>
                      {program.code} - {program.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )}
        </form.Field>

        {/* Parent Family (only for design type) */}
        {showParentSelector && (
          <form.Field name="parentDesignId">
            {(field) => (
              <FormField
                label="Parent Family"
                error={field.state.meta.errors[0] as string | undefined}
                helpText="Optional: group this design under a family"
              >
                <Select
                  value={field.state.value || 'none'}
                  onValueChange={(value) =>
                    field.handleChange(value === 'none' ? '' : value)
                  }
                  disabled={loadingFamilies}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={
                        loadingFamilies
                          ? 'Loading families...'
                          : 'Select family (optional)'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No Family</SelectItem>
                    {families.map((family) => (
                      <SelectItem key={family.id} value={family.id}>
                        {family.code} - {family.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            )}
          </form.Field>
        )}

        {/* Planned Quantity */}
        <form.Field name="plannedQuantity">
          {(field) => (
            <FormField
              label="Planned Quantity"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="Number of units planned"
            >
              <Input
                name={field.name}
                type="number"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="100"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Description */}
        <form.Field name="description">
          {(field) => (
            <FormField
              label="Description"
              error={field.state.meta.errors[0] as string | undefined}
              className="md:col-span-2"
            >
              <Textarea
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Design description..."
                rows={3}
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>
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
            : design?.id
              ? 'Update Design'
              : 'Create Design'}
        </Button>
      </div>
    </form>
  )
}
