import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { Tags } from 'lucide-react'
import type { Design } from '@/lib/types/design'
import type { Program } from '@/lib/types/program'
import { apiFetch } from '@/lib/api/client'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  LoadingSpinner,
} from '@/components/ui'
import {
  ViewEditNumber,
  ViewEditSelect,
  ViewEditTextarea,
} from '@/components/ui/view-edit-field'
import { AttributesEditor } from '@/components/items/AttributesEditor'

interface FamilyDesign {
  id: string
  code: string
  name: string
}

interface DesignWithDetails extends Design {
  program?: Program | null
  parentDesign?: { id: string; code: string; name: string } | null
}

export interface DesignDetailsSectionHandle {
  save: () => Promise<void>
}

interface DesignDetailsSectionProps {
  design: DesignWithDetails
  programs: Array<Program>
  isEditing: boolean
  onEditEnd: () => void
  onUpdate: () => void
}

export const DesignDetailsSection = forwardRef<
  DesignDetailsSectionHandle,
  DesignDetailsSectionProps
>(function DesignDetailsSection(
  { design, programs, isEditing, onEditEnd, onUpdate },
  ref,
) {
  const { handleError, showSuccess } = useErrorHandler()
  const [families, setFamilies] = useState<Array<FamilyDesign>>([])
  const [loadingFamilies, setLoadingFamilies] = useState(false)

  // Local edit state
  const [editValues, setEditValues] = useState({
    description: design.description || '',
    programId: design.programId || '',
    parentDesignId: design.parentDesignId || '',
    plannedQuantity: design.plannedQuantity?.toString() || '',
  })
  const [attributes, setAttributes] = useState<Record<string, string>>(
    Object.fromEntries(
      Object.entries(design.attributes || {}).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.join(', ') : String(value ?? ''),
      ]),
    ),
  )

  const updateField = (field: keyof typeof editValues, value: string) => {
    setEditValues((prev) => ({ ...prev, [field]: value }))
  }

  // Reset edit state when entering edit mode or design changes
  useEffect(() => {
    if (isEditing) {
      setEditValues({
        description: design.description || '',
        programId: design.programId || '',
        parentDesignId: design.parentDesignId || '',
        plannedQuantity: design.plannedQuantity?.toString() || '',
      })
      setAttributes(
        Object.fromEntries(
          Object.entries(design.attributes || {}).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(', ') : String(value ?? ''),
          ]),
        ),
      )
    }
  }, [isEditing, design])

  // Fetch available families when programId changes in edit mode
  useEffect(() => {
    if (!isEditing) return

    const fetchFamilies = async () => {
      setLoadingFamilies(true)
      try {
        const params = editValues.programId
          ? `?programId=${editValues.programId}`
          : ''
        const response = await fetch(`/api/designs/families${params}`)
        if (response.ok) {
          const { data } = await response.json()
          const filteredFamilies = (data?.families || []).filter(
            (f: FamilyDesign) => f.id !== design.id,
          )
          setFamilies(filteredFamilies)
        }
      } catch {
        setFamilies([])
      } finally {
        setLoadingFamilies(false)
      }
    }

    fetchFamilies()
  }, [editValues.programId, isEditing, design.id])

  // Expose save to parent via ref
  useImperativeHandle(
    ref,
    () => ({
      async save() {
        try {
          await apiFetch(`/api/designs/${design.id}`, {
            method: 'PUT',
            body: JSON.stringify({
              description: editValues.description || null,
              programId:
                editValues.programId && editValues.programId !== 'none'
                  ? editValues.programId
                  : null,
              parentDesignId:
                editValues.parentDesignId &&
                editValues.parentDesignId !== 'none'
                  ? editValues.parentDesignId
                  : null,
              plannedQuantity: editValues.plannedQuantity
                ? parseInt(editValues.plannedQuantity, 10)
                : null,
              attributes,
            }),
          })
          showSuccess('Design updated', 'Details have been saved')
          onEditEnd()
          onUpdate()
        } catch (error) {
          handleError(error, { title: 'Failed to update design' })
          throw error
        }
      },
    }),
    [
      editValues,
      attributes,
      design.id,
      onEditEnd,
      onUpdate,
      handleError,
      showSuccess,
    ],
  )

  // Don't show parent family selector for family or library types
  const showParentSelector =
    design.designType !== 'Family' && design.designType !== 'Library'

  const attributeCount = Object.keys(design.attributes || {}).length

  // Build program select options
  const programOptions = [
    { value: 'none', label: 'No Program' },
    ...programs.map((p) => ({ value: p.id, label: `${p.code} - ${p.name}` })),
  ]

  // Build family select options — include current parentDesign so view mode can display it
  const familyEntries = isEditing
    ? families.map((f) => ({ value: f.id, label: `${f.code} - ${f.name}` }))
    : design.parentDesign
      ? [
          {
            value: design.parentDesign.id,
            label: `${design.parentDesign.code} - ${design.parentDesign.name}`,
          },
        ]
      : []
  const familyOptions = [
    { value: 'none', label: 'No Family' },
    ...familyEntries,
  ]

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Main Content - Left 2 columns */}
      <div className="lg:col-span-2">
        <Card>
          <CardContent className="pt-6">
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Description */}
              <ViewEditTextarea
                label="Description"
                value={isEditing ? editValues.description : design.description}
                onChange={(v) => updateField('description', v)}
                isEditing={isEditing}
                placeholder="Design description..."
                emptyText="No description"
                rows={2}
                className="md:col-span-2"
              />

              {/* Program */}
              <ViewEditSelect
                label="Program"
                value={
                  isEditing
                    ? editValues.programId || 'none'
                    : design.programId || ''
                }
                onChange={(v) => updateField('programId', v)}
                isEditing={isEditing}
                options={programOptions}
                emptyText="No program"
              />

              {/* Planned Quantity */}
              <ViewEditNumber
                label="Planned Quantity"
                value={
                  isEditing
                    ? editValues.plannedQuantity
                    : design.plannedQuantity
                }
                onChange={(v) => updateField('plannedQuantity', v)}
                isEditing={isEditing}
                unit="units"
                placeholder="100"
                emptyText="Not set"
                min={1}
              />

              {/* Parent Family (only for design type) */}
              {showParentSelector && (
                <div className="relative">
                  <ViewEditSelect
                    label="Parent Family"
                    value={
                      isEditing
                        ? editValues.parentDesignId || 'none'
                        : design.parentDesignId || ''
                    }
                    onChange={(v) => updateField('parentDesignId', v)}
                    isEditing={isEditing}
                    options={familyOptions}
                    emptyText="No family"
                  />
                  {isEditing && loadingFamilies && (
                    <div className="absolute right-2 top-8">
                      <LoadingSpinner size="sm" />
                    </div>
                  )}
                </div>
              )}
            </dl>
          </CardContent>
        </Card>
      </div>

      {/* Sidebar - Right column */}
      <div className="space-y-6">
        {isEditing ? (
          /* Edit mode: AttributesEditor has its own collapsible header;
             wrap in Card and suppress its inner border to match view-mode styling */
          <Card>
            <AttributesEditor
              value={attributes}
              onChange={setAttributes}
              className="border-0 rounded-none"
            />
          </Card>
        ) : (
          /* View mode: Card with collapsible */
          <Card>
            <Collapsible defaultOpen={attributeCount > 0}>
              <CardHeader className="pb-3">
                <CollapsibleTrigger className="hover:opacity-70">
                  <div className="flex items-center gap-2">
                    <Tags className="h-4 w-4 text-slate-400" />
                    <CardTitle className="text-base">
                      Custom Attributes
                    </CardTitle>
                    {attributeCount > 0 && (
                      <Badge variant="secondary">{attributeCount}</Badge>
                    )}
                  </div>
                </CollapsibleTrigger>
              </CardHeader>
              <CollapsibleContent>
                <CardContent className="pt-0">
                  {attributeCount > 0 ? (
                    <dl className="space-y-3">
                      {Object.entries(design.attributes || {}).map(
                        ([key, value]) => (
                          <div key={key} className="space-y-1">
                            <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
                              {key}
                            </dt>
                            <dd className="text-slate-900 dark:text-white bg-slate-100 dark:bg-slate-900 px-3 py-1.5 rounded-md">
                              {Array.isArray(value)
                                ? value.join(', ')
                                : String(value)}
                            </dd>
                          </div>
                        ),
                      )}
                    </dl>
                  ) : (
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      No custom attributes defined.
                    </p>
                  )}
                </CardContent>
              </CollapsibleContent>
            </Collapsible>
          </Card>
        )}
      </div>
    </div>
  )
})
