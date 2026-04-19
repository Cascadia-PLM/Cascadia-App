import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  FormInput,
  Image as ImageIcon,
  Loader2,
  Plus,
  Trash2,
  Type,
  Upload,
  Variable,
} from 'lucide-react'
import { ParametricBlockEditor } from './ParametricBlockEditor'
import { DataFieldBlockEditor } from './DataFieldBlockEditor'
import type {
  StepContent,
  StepContentBlock,
  WorkInstructionOperation,
  WorkInstructionStep,
} from '@/lib/items/types/work-instruction'
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  Input,
  Textarea,
} from '@/components/ui'
import { cn } from '@/lib/utils'

interface StepEditorProps {
  steps: Array<WorkInstructionStep>
  workInstructionId: string
  onAddStep: (step: Partial<WorkInstructionStep>) => Promise<void>
  onUpdateStep: (
    stepId: string,
    data: Partial<WorkInstructionStep>,
  ) => Promise<void>
  onDeleteStep: (stepId: string) => Promise<void>
  onReorderSteps: (
    steps: Array<{ id: string; orderIndex: number }>,
  ) => Promise<void>
  onError?: (error: Error) => void
  isLoading?: boolean
  // Operations support
  operations?: Array<WorkInstructionOperation>
  onAssignToOperation?: (
    stepId: string,
    operationId: string | null,
  ) => Promise<void>
}

interface StepBlockEditorProps {
  block: StepContentBlock
  workInstructionId: string
  onUpdate: (block: StepContentBlock) => void
  onDelete: () => void
  onError?: (error: Error) => void
}

function StepBlockEditor({
  block,
  workInstructionId,
  onUpdate,
  onDelete,
  onError,
}: StepBlockEditorProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const handleFileUpload = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      onError?.(new Error('Please select an image file'))
      return
    }

    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file_0', file)

      const response = await fetch(
        `/api/items/${workInstructionId}/files/upload`,
        {
          method: 'POST',
          body: formData,
        },
      )

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.details || error.error || 'Upload failed')
      }

      const result = await response.json()
      const uploadedFile = result.files?.[0]

      if (uploadedFile?.id) {
        onUpdate({
          ...block,
          fileId: uploadedFile.id,
          alt: file.name,
        })
      }
    } catch (error) {
      onError?.(error as Error)
    } finally {
      setUploading(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) {
      handleFileUpload(file)
    }
  }

  // Local state for text content to prevent typing lag
  const [localText, setLocalText] = useState(block.content || '')
  const [localCaption, setLocalCaption] = useState(block.caption || '')
  const [localAlt, setLocalAlt] = useState(block.alt || '')
  const textTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined)
  const captionTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined)
  const altTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined)

  // Sync from props when block identity changes externally
  useEffect(() => {
    setLocalText(block.content || '')
    setLocalCaption(block.caption || '')
    setLocalAlt(block.alt || '')
  }, [block.id])

  if (block.type === 'text') {
    return (
      <div className="relative group">
        <Textarea
          value={localText}
          onChange={(e) => {
            const val = e.target.value
            setLocalText(val)
            // Debounce the parent update
            if (textTimeoutRef.current) clearTimeout(textTimeoutRef.current)
            textTimeoutRef.current = setTimeout(() => {
              onUpdate({ ...block, content: val })
            }, 300)
          }}
          placeholder="Enter instruction text..."
          rows={3}
          className="pr-10"
        />
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6"
          onClick={onDelete}
        >
          <Trash2 className="h-4 w-4 text-red-500" />
        </Button>
      </div>
    )
  }

  if (block.type === 'image') {
    return (
      <div className="relative group border rounded-lg p-4 bg-slate-50 dark:bg-slate-800">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleFileUpload(file)
          }}
        />
        <div
          className={cn(
            'flex items-center justify-center min-h-[100px] transition-colors rounded-lg',
            dragOver &&
              'bg-sky-50 dark:bg-sky-900/20 border-2 border-dashed border-sky-400',
          )}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          {uploading ? (
            <div className="text-center py-8">
              <Loader2 className="h-8 w-8 mx-auto mb-2 animate-spin text-sky-500" />
              <p className="text-sm text-slate-500">Uploading image...</p>
            </div>
          ) : block.fileId ? (
            <div className="text-center w-full">
              <img
                src={`/api/files/${block.fileId}`}
                alt={block.alt || 'Step image'}
                className="max-w-full max-h-64 rounded mx-auto"
              />
              <div className="mt-3 flex justify-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="h-4 w-4 mr-2" />
                  Replace Image
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    onUpdate({ ...block, fileId: undefined, alt: undefined })
                  }
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Remove
                </Button>
              </div>
            </div>
          ) : (
            <div
              className="text-center py-8 cursor-pointer w-full"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="h-8 w-8 mx-auto mb-2 text-slate-400" />
              <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Click to upload or drag and drop
              </p>
              <p className="text-xs text-slate-500 mt-1">
                PNG, JPG, GIF up to 10MB
              </p>
            </div>
          )}
        </div>
        <Input
          placeholder="Image caption (optional)"
          className="mt-3"
          value={localCaption}
          onChange={(e) => {
            const val = e.target.value
            setLocalCaption(val)
            if (captionTimeoutRef.current)
              clearTimeout(captionTimeoutRef.current)
            captionTimeoutRef.current = setTimeout(() => {
              onUpdate({ ...block, caption: val })
            }, 300)
          }}
        />
        <Input
          placeholder="Alt text for accessibility"
          className="mt-2"
          value={localAlt}
          onChange={(e) => {
            const val = e.target.value
            setLocalAlt(val)
            if (altTimeoutRef.current) clearTimeout(altTimeoutRef.current)
            altTimeoutRef.current = setTimeout(() => {
              onUpdate({ ...block, alt: val })
            }, 300)
          }}
        />
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6"
          onClick={onDelete}
        >
          <Trash2 className="h-4 w-4 text-red-500" />
        </Button>
      </div>
    )
  }

  if (block.type === 'parametric') {
    return (
      <ParametricBlockEditor
        block={block}
        workInstructionId={workInstructionId}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onError={onError}
      />
    )
  }

  if (block.type === 'dataField') {
    return (
      <DataFieldBlockEditor
        block={block}
        onUpdate={onUpdate}
        onDelete={onDelete}
      />
    )
  }

  return null
}

interface SingleStepEditorProps {
  step: WorkInstructionStep
  index: number
  workInstructionId: string
  isExpanded: boolean
  onToggleExpand: () => void
  onUpdate: (data: Partial<WorkInstructionStep>) => void
  onDelete: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  canMoveUp: boolean
  canMoveDown: boolean
  onError?: (error: Error) => void
  // Operations support
  operations?: Array<WorkInstructionOperation>
  onAssignToOperation?: (
    stepId: string,
    operationId: string | null,
  ) => Promise<void>
}

function SingleStepEditor({
  step,
  index,
  workInstructionId,
  isExpanded,
  onToggleExpand,
  onUpdate,
  onDelete,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  onError,
  operations,
  onAssignToOperation,
}: SingleStepEditorProps) {
  // Local state for title to prevent typing lag
  const [localTitle, setLocalTitle] = useState(step.title || '')
  const titleTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined)

  // Sync from props only when step identity changes
  useEffect(() => {
    setLocalTitle(step.title || '')
  }, [step.id])

  const content: StepContent = step.content || { blocks: [] }

  const updateBlock = (blockIndex: number, updatedBlock: StepContentBlock) => {
    const newBlocks = [...content.blocks]
    newBlocks[blockIndex] = updatedBlock
    onUpdate({ content: { blocks: newBlocks } })
  }

  const deleteBlock = (blockIndex: number) => {
    const newBlocks = content.blocks.filter((_, i) => i !== blockIndex)
    onUpdate({ content: { blocks: newBlocks } })
  }

  const addBlock = (type: 'text' | 'image' | 'parametric' | 'dataField') => {
    const newBlock: StepContentBlock = {
      id: crypto.randomUUID(),
      type,
      content: type === 'text' ? '' : undefined,
      fieldType: type === 'dataField' ? 'text' : undefined,
      fieldLabel: type === 'dataField' ? '' : undefined,
      fieldRequired: type === 'dataField' ? false : undefined,
    }
    onUpdate({ content: { blocks: [...content.blocks, newBlock] } })
  }

  return (
    <Card className="mb-4">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="flex flex-col gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              onClick={onMoveUp}
              disabled={!canMoveUp}
            >
              <ChevronUp className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              onClick={onMoveDown}
              disabled={!canMoveDown}
            >
              <ChevronDown className="h-3 w-3" />
            </Button>
          </div>
          <div
            className="flex-1 cursor-pointer flex items-center gap-3"
            onClick={onToggleExpand}
          >
            <span className="flex items-center justify-center h-8 w-8 rounded-full bg-sky-100 text-sky-700 font-medium text-sm dark:bg-sky-900 dark:text-sky-300">
              {index + 1}
            </span>
            <Input
              value={localTitle}
              onChange={(e) => {
                e.stopPropagation()
                const val = e.target.value
                setLocalTitle(val)
                if (titleTimeoutRef.current)
                  clearTimeout(titleTimeoutRef.current)
                titleTimeoutRef.current = setTimeout(() => {
                  onUpdate({ title: val })
                }, 300)
              }}
              onClick={(e) => e.stopPropagation()}
              placeholder={`Step ${index + 1}`}
              className="flex-1 font-medium"
            />
          </div>
          <div className="flex items-center gap-1">
            {/* Move to Operation dropdown */}
            {operations && operations.length > 0 && onAssignToOperation && (
              <select
                className="text-xs border rounded px-2 py-1 bg-white dark:bg-slate-800 dark:border-slate-600"
                value={step.operationId || ''}
                onChange={(e) => {
                  const value = e.target.value || null
                  onAssignToOperation(step.id, value)
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <option value="">No operation</option>
                {operations.map((op) => (
                  <option key={op.id} value={op.id}>
                    {op.title}
                  </option>
                ))}
              </select>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={(e) => {
                e.stopPropagation()
                onToggleExpand()
              }}
            >
              {isExpanded ? (
                <ChevronUp className="h-4 w-4 text-slate-500" />
              ) : (
                <ChevronDown className="h-4 w-4 text-slate-500" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-red-500 hover:text-red-700"
              onClick={(e) => {
                e.stopPropagation()
                onDelete()
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      {isExpanded && (
        <CardContent className="space-y-4">
          {content.blocks.map((block, blockIndex) => (
            <StepBlockEditor
              key={block.id}
              block={block}
              workInstructionId={workInstructionId}
              onUpdate={(updatedBlock) => updateBlock(blockIndex, updatedBlock)}
              onDelete={() => deleteBlock(blockIndex)}
              onError={onError}
            />
          ))}

          {content.blocks.length === 0 && (
            <div className="text-center py-8 text-slate-500">
              <p className="mb-4">
                No content yet. Add a block to get started.
              </p>
            </div>
          )}

          <div className="flex gap-2 justify-center pt-2 border-t">
            <Button
              variant="outline"
              size="sm"
              onClick={() => addBlock('text')}
            >
              <Type className="h-4 w-4 mr-2" />
              Add Text
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => addBlock('image')}
            >
              <ImageIcon className="h-4 w-4 mr-2" />
              Add Image
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => addBlock('parametric')}
            >
              <Variable className="h-4 w-4 mr-2" />
              Add Parametric Value
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => addBlock('dataField')}
            >
              <FormInput className="h-4 w-4 mr-2" />
              Add Data Field
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  )
}

export function StepEditor({
  steps,
  workInstructionId,
  onAddStep,
  onUpdateStep,
  onDeleteStep,
  onReorderSteps,
  onError,
  isLoading,
  operations,
  onAssignToOperation,
}: StepEditorProps) {
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set())
  const pendingUpdatesRef = useRef<Map<string, NodeJS.Timeout>>(new Map())

  const toggleExpand = (stepId: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev)
      if (next.has(stepId)) {
        next.delete(stepId)
      } else {
        next.add(stepId)
      }
      return next
    })
  }

  // Debounced update to avoid too many API calls
  const debouncedUpdate = useCallback(
    (stepId: string, data: Partial<WorkInstructionStep>) => {
      // Clear existing timeout for this step
      const existingTimeout = pendingUpdatesRef.current.get(stepId)
      if (existingTimeout) {
        clearTimeout(existingTimeout)
      }

      // Set new timeout
      const timeout = setTimeout(() => {
        onUpdateStep(stepId, data)
        pendingUpdatesRef.current.delete(stepId)
      }, 500)

      pendingUpdatesRef.current.set(stepId, timeout)
    },
    [onUpdateStep],
  )

  const handleAddStep = async () => {
    const newOrderIndex = steps.length
    await onAddStep({
      workInstructionId,
      orderIndex: newOrderIndex,
      title: '',
      content: { blocks: [] },
    })
  }

  const handleMoveStep = async (
    currentIndex: number,
    direction: 'up' | 'down',
  ) => {
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1
    if (targetIndex < 0 || targetIndex >= steps.length) return

    const newSteps = [...steps]
    const [movedStep] = newSteps.splice(currentIndex, 1)
    newSteps.splice(targetIndex, 0, movedStep)

    const reorderedSteps = newSteps.map((step, idx) => ({
      id: step.id,
      orderIndex: idx,
    }))

    await onReorderSteps(reorderedSteps)
  }

  const sortedSteps = [...steps].sort((a, b) => a.orderIndex - b.orderIndex)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
          Steps
        </h3>
        <Button onClick={handleAddStep} disabled={isLoading}>
          <Plus className="h-4 w-4 mr-2" />
          Add Step
        </Button>
      </div>

      {sortedSteps.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-slate-500 mb-4">
              No steps yet. Click "Add Step" to create your first step.
            </p>
            <Button onClick={handleAddStep} disabled={isLoading}>
              <Plus className="h-4 w-4 mr-2" />
              Add First Step
            </Button>
          </CardContent>
        </Card>
      ) : (
        sortedSteps.map((step, index) => (
          <SingleStepEditor
            key={step.id}
            step={step}
            index={index}
            workInstructionId={workInstructionId}
            isExpanded={expandedSteps.has(step.id)}
            onToggleExpand={() => toggleExpand(step.id)}
            onUpdate={(data) => debouncedUpdate(step.id, data)}
            onDelete={() => onDeleteStep(step.id)}
            onMoveUp={() => handleMoveStep(index, 'up')}
            onMoveDown={() => handleMoveStep(index, 'down')}
            canMoveUp={index > 0}
            canMoveDown={index < sortedSteps.length - 1}
            onError={onError}
            operations={operations}
            onAssignToOperation={onAssignToOperation}
          />
        ))
      )}
    </div>
  )
}
