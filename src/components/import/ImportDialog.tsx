import { useCallback, useMemo, useState } from 'react'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  Loader2,
} from 'lucide-react'

// Import step components
import { ContextSelectStep } from './steps/ContextSelectStep'
import { FileUploadStep } from './steps/FileUploadStep'
import { ColumnMappingStep } from './steps/ColumnMappingStep'
import { ValidationPreviewStep } from './steps/ValidationPreviewStep'
import { ImportProgressStep } from './steps/ImportProgressStep'
import type {
  BomDetectionResult,
  BomImportResult,
  BomRelationship,
  ColumnMapping,
  ImportContext,
  ImportItemType,
  ParsedFile,
  ValidatedRow,
} from '@/lib/import'
import {
  applyMappings,
  checkRequiredFieldsMapped,
  detectBomFormat,
  extractBomRelationships,
  getImportConfig,
  getValidRows,
  validateRows,
} from '@/lib/import'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog'

type ImportStep =
  | 'context'
  | 'upload'
  | 'mapping'
  | 'validation'
  | 'importing'
  | 'complete'

interface ImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Item type to import */
  itemType?: ImportItemType
  /** Pre-select a program */
  initialProgramId?: string
  /** Pre-select a design */
  initialDesignId?: string
  /** Pre-select a branch */
  initialBranchId?: string
  /** Callback when import completes */
  onComplete?: () => void
}

/**
 * Multi-step import wizard dialog for bulk item imports.
 */
export function ImportDialog({
  open,
  onOpenChange,
  itemType = 'Part',
  initialProgramId,
  initialDesignId,
  initialBranchId,
  onComplete,
}: ImportDialogProps) {
  // Get config for this item type
  const config = getImportConfig(itemType)

  // Determine steps based on item type
  const STEPS: Array<{ id: ImportStep; label: string }> = useMemo(() => {
    const steps: Array<{ id: ImportStep; label: string }> = []

    // Context step only for items that require design
    if (config.requiresDesign) {
      steps.push({ id: 'context', label: 'Select Design' })
    } else {
      // Issues get optional program selection
      steps.push({ id: 'context', label: 'Select Program' })
    }

    steps.push(
      { id: 'upload', label: 'Upload File' },
      { id: 'mapping', label: 'Map Columns' },
      { id: 'validation', label: 'Review' },
      { id: 'importing', label: 'Import' },
    )

    return steps
  }, [config.requiresDesign])

  // Current step
  const [currentStep, setCurrentStep] = useState<ImportStep>('context')

  // Context state
  const [context, setContext] = useState<ImportContext | null>(null)

  // File state
  const [parsedFile, setParsedFile] = useState<ParsedFile | null>(null)

  // Mapping state
  const [mappings, setMappings] = useState<Array<ColumnMapping>>([])

  // Validation state
  const [validatedRows, setValidatedRows] = useState<Array<ValidatedRow>>([])

  // BOM state
  const [bomFormat, setBomFormat] = useState<BomDetectionResult | null>(null)
  const [bomRelationships, setBomRelationships] = useState<
    Array<BomRelationship>
  >([])

  // Import result state (result is stored for potential future use, setter used for reset)
  const [_importResult, setImportResult] = useState<BomImportResult | null>(
    null,
  )

  // Loading state for validation
  const [isProcessing, setIsProcessing] = useState(false)

  // Reset all state when dialog closes
  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!newOpen) {
        // Reset state when closing
        setCurrentStep('context')
        setContext(null)
        setParsedFile(null)
        setMappings([])
        setValidatedRows([])
        setBomFormat(null)
        setBomRelationships([])
        setImportResult(null)
      }
      onOpenChange(newOpen)
    },
    [onOpenChange],
  )

  // Handle file upload
  const handleFileUpload = useCallback(
    (file: ParsedFile, autoMappings: Array<ColumnMapping>) => {
      setParsedFile(file)
      setMappings(autoMappings)
    },
    [],
  )

  // Handle file clear (reset file-related state without page reload)
  const handleFileClear = useCallback(() => {
    setParsedFile(null)
    setMappings([])
    setValidatedRows([])
    setBomFormat(null)
    setBomRelationships([])
  }, [])

  // Step navigation
  const getCurrentStepIndex = () => STEPS.findIndex((s) => s.id === currentStep)

  const canGoBack = () => {
    const idx = getCurrentStepIndex()
    return idx > 0 && currentStep !== 'importing' && currentStep !== 'complete'
  }

  const goBack = () => {
    const idx = getCurrentStepIndex()
    if (idx > 0) {
      setCurrentStep(STEPS[idx - 1].id)
    }
  }

  const handleClose = () => {
    if (currentStep === 'complete') {
      onComplete?.()
    }
    handleOpenChange(false)
  }

  // Get step completion status
  const isStepComplete = (stepId: ImportStep): boolean => {
    const currentIdx = getCurrentStepIndex()
    const stepIdx = STEPS.findIndex((s) => s.id === stepId)
    return stepIdx < currentIdx || currentStep === 'complete'
  }

  // Determine if can continue based on current step
  const canContinue = useMemo(() => {
    switch (currentStep) {
      case 'context':
        // Issues don't require context (free lifecycle)
        if (!config.requiresDesign) return true
        return !!context
      case 'upload':
        return !!parsedFile
      case 'mapping': {
        const { allMapped } = checkRequiredFieldsMapped(mappings, itemType)
        return allMapped
      }
      case 'validation':
        return getValidRows(validatedRows).length > 0
      default:
        return false
    }
  }, [
    currentStep,
    context,
    parsedFile,
    mappings,
    validatedRows,
    itemType,
    config.requiresDesign,
  ])

  // Get continue button label
  const continueLabel = useMemo(() => {
    if (currentStep === 'validation') {
      const count = getValidRows(validatedRows).length
      const label = count === 1 ? config.singularLabel : config.pluralLabel
      return `Import ${count} ${label}`
    }
    return 'Continue'
  }, [currentStep, validatedRows, config.singularLabel, config.pluralLabel])

  // Handle continue button click
  const handleContinue = useCallback(() => {
    switch (currentStep) {
      case 'context':
        setCurrentStep('upload')
        break
      case 'upload':
        setCurrentStep('mapping')
        break
      case 'mapping':
        // Do validation before advancing
        setIsProcessing(true)
        try {
          const mappedRows = applyMappings(parsedFile!.rows, mappings, {
            collectUnmappedAsAttributes: true,
          })
          const validated = validateRows(mappedRows, parsedFile!.rows, itemType)
          setValidatedRows(validated)

          // Detect BOM format and extract relationships (only for Parts)
          if (config.supportsBom) {
            const format = detectBomFormat(mappings)
            setBomFormat(format)
            if (format.format !== 'flat') {
              const relationships = extractBomRelationships(validated, format)
              setBomRelationships(relationships)
            } else {
              setBomRelationships([])
            }
          } else {
            setBomFormat(null)
            setBomRelationships([])
          }

          setCurrentStep('validation')
        } finally {
          setIsProcessing(false)
        }
        break
      case 'validation':
        setCurrentStep('importing')
        break
    }
  }, [currentStep, parsedFile, mappings, itemType, config.supportsBom])

  // Render step content
  const renderStepContent = () => {
    switch (currentStep) {
      case 'context':
        return (
          <ContextSelectStep
            itemType={itemType}
            initialProgramId={initialProgramId}
            initialDesignId={initialDesignId}
            initialBranchId={initialBranchId}
            value={context}
            onChange={setContext}
          />
        )

      case 'upload':
        return (
          <FileUploadStep
            itemType={itemType}
            value={parsedFile}
            onChange={handleFileUpload}
            onClear={handleFileClear}
          />
        )

      case 'mapping':
        return (
          <ColumnMappingStep
            itemType={itemType}
            parsedFile={parsedFile!}
            mappings={mappings}
            onMappingsChange={setMappings}
          />
        )

      case 'validation':
        return (
          <ValidationPreviewStep
            itemType={itemType}
            validatedRows={validatedRows}
            bomFormat={bomFormat}
            bomRelationships={bomRelationships}
          />
        )

      case 'importing':
      case 'complete':
        return (
          <ImportProgressStep
            itemType={itemType}
            context={context!}
            validatedRows={validatedRows}
            bomRelationships={bomRelationships}
            onComplete={(result) => {
              setImportResult(result)
              setCurrentStep('complete')
            }}
          />
        )

      default:
        return null
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="!max-w-3xl w-[700px] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            Import {config.pluralLabel}
          </DialogTitle>
          <DialogDescription>
            Import {config.pluralLabel.toLowerCase()} from an Excel (.xlsx) or
            CSV file
          </DialogDescription>
        </DialogHeader>

        {/* Stepper */}
        <div className="flex items-center justify-center gap-1 py-3 border-b">
          {STEPS.map((step, idx) => {
            const isComplete = isStepComplete(step.id)
            const isCurrent = step.id === currentStep
            const isLast = idx === STEPS.length - 1

            return (
              <div key={step.id} className="flex items-center">
                <div className="flex items-center gap-1.5">
                  <div
                    className={cn(
                      'w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium transition-colors',
                      isComplete
                        ? 'bg-green-500 text-white'
                        : isCurrent
                          ? 'bg-cyan-600 text-white'
                          : 'bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400',
                    )}
                  >
                    {isComplete ? <Check className="h-3.5 w-3.5" /> : idx + 1}
                  </div>
                  <span
                    className={cn(
                      'text-xs font-medium whitespace-nowrap',
                      isCurrent
                        ? 'text-slate-900 dark:text-slate-100'
                        : 'text-slate-500 dark:text-slate-400',
                    )}
                  >
                    {step.label}
                  </span>
                </div>
                {!isLast && (
                  <div
                    className={cn(
                      'w-6 h-0.5 mx-2',
                      isComplete
                        ? 'bg-green-500'
                        : 'bg-slate-200 dark:bg-slate-700',
                    )}
                  />
                )}
              </div>
            )
          })}
        </div>

        {/* Step Content */}
        <div className="flex-1 overflow-y-auto py-4 min-h-[300px]">
          {renderStepContent()}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-4 border-t">
          <Button
            variant="ghost"
            onClick={goBack}
            disabled={!canGoBack()}
            className={cn(!canGoBack() && 'invisible')}
          >
            <ChevronLeft className="h-4 w-4 mr-1" />
            Back
          </Button>

          <div className="flex items-center gap-3">
            {currentStep === 'complete' ? (
              <Button onClick={handleClose}>
                Done
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            ) : currentStep === 'importing' ? (
              <Button disabled>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Importing...
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={handleClose}>
                  Cancel
                </Button>
                <Button
                  onClick={handleContinue}
                  disabled={!canContinue || isProcessing}
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    <>
                      {continueLabel}
                      <ChevronRight className="h-4 w-4 ml-1" />
                    </>
                  )}
                </Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
