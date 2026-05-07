import { useForm, useStore } from '@tanstack/react-form'
import { useEffect, useState } from 'react'
import { Info } from 'lucide-react'
import type { Document } from '@/lib/items/types/document'
import type { Design } from '@/lib/types/design'
import type { DesignStatus } from '@/components/versioning/DesignPhaseIndicator'
import { documentSchema } from '@/lib/items/types/document'
import { DesignSelector } from '@/components/versioning/DesignSelector'
import { DesignPhaseIndicator } from '@/components/versioning/DesignPhaseIndicator'
import { BranchSelector } from '@/components/versioning/BranchSelector'
import { AttributesEditor } from '@/components/items/AttributesEditor'
import { apiFetch } from '@/lib/api/client'
import { zodValidator } from '@/lib/form-validation'
import { Button, FormField, Input, Textarea } from '@/components/ui'

interface DocumentFormProps {
  document?: Partial<Document>
  /** List of designs to select from */
  designs?: Array<Design>
  /** Default design ID for new documents */
  defaultDesignId?: string
  /** Called when form is submitted. Includes branchId if design is in post-release phase. */
  onSubmit: (data: Document, branchId?: string) => void | Promise<void>
  onCancel?: () => void
  isSubmitting?: boolean
}

export function DocumentForm({
  document,
  designs = [],
  defaultDesignId,
  onSubmit,
  onCancel,
  isSubmitting,
}: DocumentFormProps) {
  // Track selected design's protection status
  const [designStatus, setDesignStatus] = useState<DesignStatus | null>(null)
  const [selectedBranchId, setSelectedBranchId] = useState<string | undefined>()
  const [loadingStatus, setLoadingStatus] = useState(false)
  const [attributes, setAttributes] = useState<Record<string, string>>(
    document?.attributes ?? {},
  )
  const form = useForm({
    defaultValues: {
      itemType: 'Document' as const,
      state: 'Draft',
      revision: 'A',
      designId: document?.designId || defaultDesignId || '',
      itemNumber: '',
      name: '',
      description: '',
      fileName: '',
      mimeType: '',
      fileSize: undefined as number | undefined,
      storagePath: '',
      ...document,
    },
    validators: {
      onSubmit: zodValidator(documentSchema),
    },
    onSubmit: async ({ value }) => {
      const submissionData = {
        ...value,
        revision: value.revision.trim() || 'A',
        attributes,
      } as Document
      // Pass branchId if product is in post-release phase
      await onSubmit(submissionData, selectedBranchId)
    },
  })

  // Watch for design changes and fetch status
  const currentDesignId = useStore(form.store, (state) => state.values.designId)

  useEffect(() => {
    if (!currentDesignId) {
      setDesignStatus(null)
      setSelectedBranchId(undefined)
      return
    }

    async function fetchDesignStatus() {
      setLoadingStatus(true)
      try {
        const result = await apiFetch<{ data: DesignStatus }>(
          `/api/v1/designs/${currentDesignId}/status`,
        )
        setDesignStatus(result.data)
        // Clear branch selection when design changes
        setSelectedBranchId(undefined)
      } catch {
        setDesignStatus(null)
      } finally {
        setLoadingStatus(false)
      }
    }

    fetchDesignStatus()
  }, [currentDesignId])

  // Check if we're in post-release phase and need branch selection
  const isPostRelease = designStatus?.protection.phase === 'post-release'
  // In post-release, branch is required. In pre-release, branch is optional (for private work).
  const showBranchSelector = currentDesignId && !document?.id
  const branchRequired = isPostRelease

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        e.stopPropagation()
        form.handleSubmit()
      }}
      className="space-y-6"
      data-testid="document-form"
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Design - Required for versioning */}
        <form.Field name="designId">
          {(field) => (
            <FormField
              label="Design"
              required
              error={field.state.meta.errors[0] as string | undefined}
              helpText="The design this document belongs to"
              className="md:col-span-2"
            >
              <div className="flex items-center gap-4">
                <DesignSelector
                  designs={designs}
                  value={field.state.value}
                  onChange={(value) => field.handleChange(value)}
                  required
                  disabled={!!document?.id}
                />
                {field.state.value && !loadingStatus && designStatus && (
                  <DesignPhaseIndicator
                    designId={field.state.value}
                    status={designStatus}
                  />
                )}
              </div>
            </FormField>
          )}
        </form.Field>

        {/* Branch Selection - Available for new items in both phases */}
        {showBranchSelector && (
          <FormField
            label="Target Branch"
            required={branchRequired}
            error={
              branchRequired && !selectedBranchId
                ? 'Please select a branch to create this document on'
                : undefined
            }
            helpText={
              branchRequired
                ? 'Select an ECO or workspace branch for the new document'
                : 'Optional: Create on a workspace branch for private development'
            }
            className="md:col-span-2"
          >
            <BranchSelector
              designId={currentDesignId}
              value={selectedBranchId}
              onChange={setSelectedBranchId}
              showMainOption={!branchRequired}
              placeholder={
                branchRequired ? 'Select branch...' : 'Main branch (default)'
              }
            />
            {branchRequired && (
              <div className="flex items-start gap-2 mt-2 p-3 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 text-sm rounded-md">
                <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>
                  This design is under change control. New documents must be
                  created on an ECO or workspace branch.
                </span>
              </div>
            )}
            {!branchRequired && !selectedBranchId && (
              <div className="flex items-start gap-2 mt-2 p-3 bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 text-sm rounded-md">
                <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>
                  No branch selected - document will be created on the main
                  branch. Select a workspace branch for private development
                  work.
                </span>
              </div>
            )}
          </FormField>
        )}

        {/* Item Number */}
        <form.Field name="itemNumber">
          {(field) => (
            <FormField
              label="Item Number"
              error={field.state.meta.errors[0] as string | undefined}
              helpText="Leave blank to auto-generate (e.g., DOC-000001)"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Auto-generated if blank"
                error={!!field.state.meta.errors.length}
                data-testid="document-item-number"
              />
            </FormField>
          )}
        </form.Field>

        {/* Revision */}
        <form.Field name="revision">
          {(field) => (
            <FormField
              label="Revision"
              required
              error={field.state.meta.errors[0] as string | undefined}
              helpText="Version identifier (A, B, C, etc.)"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="A"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Name */}
        <form.Field name="name">
          {(field) => (
            <FormField
              label="Name"
              error={field.state.meta.errors[0] as string | undefined}
              className="md:col-span-2"
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Technical Specification"
                error={!!field.state.meta.errors.length}
                data-testid="document-name"
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
                placeholder="Detailed description of the document..."
                rows={4}
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* File Name */}
        <form.Field name="fileName">
          {(field) => (
            <FormField
              label="File Name"
              error={field.state.meta.errors[0] as string | undefined}
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="specification.pdf"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* MIME Type */}
        <form.Field name="mimeType">
          {(field) => (
            <FormField
              label="MIME Type"
              error={field.state.meta.errors[0] as string | undefined}
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="application/pdf"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* File Size */}
        <form.Field name="fileSize">
          {(field) => (
            <FormField
              label="File Size (bytes)"
              error={field.state.meta.errors[0] as string | undefined}
            >
              <Input
                name={field.name}
                value={field.state.value ?? ''}
                onChange={(e) => {
                  const value = e.target.value
                  field.handleChange(value ? parseInt(value, 10) : undefined)
                }}
                onBlur={field.handleBlur}
                type="number"
                placeholder="1024000"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>

        {/* Storage Path */}
        <form.Field name="storagePath">
          {(field) => (
            <FormField
              label="Storage Path"
              error={field.state.meta.errors[0] as string | undefined}
            >
              <Input
                name={field.name}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="/vault/documents/spec.pdf"
                error={!!field.state.meta.errors.length}
              />
            </FormField>
          )}
        </form.Field>
      </div>

      {/* Custom Attributes */}
      <AttributesEditor
        value={attributes}
        onChange={setAttributes}
        disabled={isSubmitting}
      />

      {/* Form Actions */}
      <div className="flex justify-end gap-3 pt-4 border-t">
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isSubmitting}
            data-testid="document-cancel"
          >
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          disabled={isSubmitting || (branchRequired && !selectedBranchId)}
          data-testid="document-submit"
        >
          {isSubmitting
            ? 'Saving...'
            : document?.id
              ? 'Update Document'
              : 'Create Document'}
        </Button>
      </div>
    </form>
  )
}
