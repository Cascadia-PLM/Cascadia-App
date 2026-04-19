import { useCallback, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Cog,
  Factory,
  FileText,
  FlaskConical,
  Loader2,
  Search,
} from 'lucide-react'
import { ImpactSummaryCards } from './ImpactSummaryCards'
import { ImpactResultsTable } from './ImpactResultsTable'
import type {
  ChangeType,
  ImpactAnalysisResult,
  ImpactDirection,
} from '@/lib/services/ImpactAnalysisService'
import type { ThreadDomain } from '@/lib/services/ThreadService'
import { apiFetch } from '@/lib/api/client'
import { cn } from '@/lib/utils'
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
} from '@/components/ui'

interface ImpactAnalysisDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  itemId: string
  itemNumber: string
  itemName?: string | null
}

type WizardStep = 'configure' | 'analyzing' | 'results'

const changeTypeOptions: Array<{
  value: ChangeType
  label: string
  description: string
}> = [
  {
    value: 'revision',
    label: 'Revision',
    description: 'Creating a new revision of this item',
  },
  {
    value: 'obsolescence',
    label: 'Obsolescence',
    description: 'Making this item obsolete',
  },
  {
    value: 'bom_removal',
    label: 'BOM Removal',
    description: 'Removing this item from assemblies',
  },
  {
    value: 'specification_change',
    label: 'Specification Change',
    description: 'Changing specifications or requirements',
  },
]

const directionOptions: Array<{
  value: ImpactDirection
  label: string
  description: string
}> = [
  {
    value: 'downstream',
    label: 'Downstream',
    description: 'Find items that depend on this item',
  },
  {
    value: 'upstream',
    label: 'Upstream',
    description: 'Find items that this item depends on',
  },
  {
    value: 'both',
    label: 'Both Directions',
    description: 'Analyze full impact in both directions',
  },
]

const domainOptions: Array<{
  value: ThreadDomain
  label: string
  Icon: typeof Cog
}> = [
  { value: 'requirements', label: 'Requirements', Icon: FileText },
  { value: 'engineering', label: 'Engineering', Icon: Cog },
  { value: 'manufacturing', label: 'Manufacturing', Icon: Factory },
  { value: 'validation', label: 'Validation', Icon: FlaskConical },
]

/**
 * Wizard-style dialog for running impact analysis on an item.
 */
export function ImpactAnalysisDialog({
  open,
  onOpenChange,
  itemId,
  itemNumber,
  itemName,
}: ImpactAnalysisDialogProps) {
  const navigate = useNavigate()

  // Wizard state
  const [step, setStep] = useState<WizardStep>('configure')

  // Configuration
  const [changeType, setChangeType] = useState<ChangeType>('revision')
  const [direction, setDirection] = useState<ImpactDirection>('both')
  const [maxDepth, setMaxDepth] = useState(5)
  const [includeDomains, setIncludeDomains] = useState<Array<ThreadDomain>>([
    'requirements',
    'engineering',
    'manufacturing',
    'validation',
  ])

  // Results
  const [result, setResult] = useState<ImpactAnalysisResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedItemIds, setSelectedItemIds] = useState<Array<string>>([])

  // Toggle domain selection
  const toggleDomain = (domain: ThreadDomain) => {
    if (includeDomains.includes(domain)) {
      setIncludeDomains(includeDomains.filter((d) => d !== domain))
    } else {
      setIncludeDomains([...includeDomains, domain])
    }
  }

  // Run analysis
  const runAnalysis = useCallback(async () => {
    setStep('analyzing')
    setError(null)
    setResult(null)

    try {
      const response = await apiFetch<{ data: ImpactAnalysisResult }>(
        `/api/items/${itemId}/impact-analysis`,
        {
          method: 'POST',
          body: JSON.stringify({
            changeType,
            direction,
            maxDepth,
            includeDomains,
          }),
        },
      )

      setResult(response.data)
      setStep('results')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed')
      setStep('configure')
    }
  }, [itemId, changeType, direction, maxDepth, includeDomains])

  // Create ECO from selection
  const createEcoFromSelection = useCallback(async () => {
    if (selectedItemIds.length === 0) return

    // Navigate to ECO creation with pre-selected items
    // The query param will be picked up by the ECO form
    const affectedIds = selectedItemIds.join(',')
    await navigate({
      to: '/change-orders/new',
      search: { affectedItems: affectedIds, sourceItem: itemId },
    } as any)

    onOpenChange(false)
  }, [selectedItemIds, itemId, navigate, onOpenChange])

  // Reset dialog state when closed
  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setStep('configure')
      setResult(null)
      setError(null)
      setSelectedItemIds([])
    }
    onOpenChange(open)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className={cn(
          'overflow-y-auto',
          step === 'results'
            ? '!w-[95vw] !max-w-[95vw] h-[95vh] max-h-[95vh]'
            : 'max-w-2xl max-h-[90vh]',
        )}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Search className="h-5 w-5" />
            Impact Analysis
          </DialogTitle>
          <DialogDescription>
            Analyze the potential impact of changes to{' '}
            <span className="font-medium text-slate-900 dark:text-slate-100">
              {itemNumber}
            </span>
            {itemName && <> ({itemName})</>}
          </DialogDescription>
        </DialogHeader>

        {/* Configure Step */}
        {step === 'configure' && (
          <div className="space-y-6 py-4">
            {/* Change Type */}
            <div className="space-y-3">
              <Label className="text-sm font-medium">
                What type of change are you considering?
              </Label>
              <div className="grid grid-cols-2 gap-3">
                {changeTypeOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setChangeType(option.value)}
                    className={cn(
                      'flex flex-col items-start p-3 rounded-lg border text-left transition-colors',
                      changeType === option.value
                        ? 'border-cyan-600 bg-cyan-50 dark:bg-cyan-950'
                        : 'border-slate-300 dark:border-slate-700 hover:border-slate-300',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {changeType === option.value ? (
                        <CheckCircle2 className="h-4 w-4 text-cyan-600" />
                      ) : (
                        <div className="h-4 w-4 rounded-full border-2 border-slate-300 dark:border-slate-600" />
                      )}
                      <span className="font-medium text-sm text-slate-900 dark:text-slate-100">
                        {option.label}
                      </span>
                    </div>
                    <span className="text-xs text-slate-500 dark:text-slate-400 mt-1 ml-6">
                      {option.description}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Direction */}
            <div className="space-y-3">
              <Label className="text-sm font-medium">
                Which direction should we analyze?
              </Label>
              <div className="grid grid-cols-3 gap-3">
                {directionOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setDirection(option.value)}
                    className={cn(
                      'flex flex-col items-start p-3 rounded-lg border text-left transition-colors',
                      direction === option.value
                        ? 'border-cyan-600 bg-cyan-50 dark:bg-cyan-950'
                        : 'border-slate-300 dark:border-slate-700 hover:border-slate-300',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {direction === option.value ? (
                        <CheckCircle2 className="h-4 w-4 text-cyan-600" />
                      ) : (
                        <div className="h-4 w-4 rounded-full border-2 border-slate-300 dark:border-slate-600" />
                      )}
                      <span className="font-medium text-sm text-slate-900 dark:text-slate-100">
                        {option.label}
                      </span>
                    </div>
                    <span className="text-xs text-slate-500 dark:text-slate-400 mt-1 ml-6">
                      {option.description}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Max Depth */}
            <div className="space-y-3">
              <div className="flex justify-between">
                <Label className="text-sm font-medium">Maximum Depth</Label>
                <span className="text-sm text-slate-500">
                  {maxDepth} levels
                </span>
              </div>
              <input
                type="range"
                value={maxDepth}
                onChange={(e) => setMaxDepth(parseInt(e.target.value, 10))}
                min={1}
                max={10}
                step={1}
                className="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-600"
              />
              <div className="flex justify-between text-xs text-slate-400">
                <span>1 (direct only)</span>
                <span>10 (full depth)</span>
              </div>
            </div>

            {/* Domains */}
            <div className="space-y-3">
              <Label className="text-sm font-medium">Include Domains</Label>
              <div className="flex flex-wrap gap-3">
                {domainOptions.map(({ value, label, Icon }) => (
                  <label
                    key={value}
                    className={cn(
                      'flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors',
                      includeDomains.includes(value)
                        ? 'border-cyan-600 bg-cyan-50 dark:bg-cyan-950'
                        : 'border-slate-300 dark:border-slate-700 hover:border-slate-300',
                    )}
                  >
                    <Checkbox
                      checked={includeDomains.includes(value)}
                      onCheckedChange={() => toggleDomain(value)}
                    />
                    <Icon className="h-4 w-4 text-slate-700 dark:text-slate-100" />
                    <span className="text-sm text-slate-900 dark:text-slate-100">
                      {label}
                    </span>
                  </label>
                ))}
              </div>
              {includeDomains.length === 0 && (
                <p className="text-sm text-orange-600 flex items-center gap-1">
                  <AlertCircle className="h-4 w-4" />
                  Select at least one domain
                </p>
              )}
            </div>

            {/* Error */}
            {error && (
              <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950 text-red-600 dark:text-red-400 text-sm flex items-center gap-2">
                <AlertCircle className="h-4 w-4" />
                {error}
              </div>
            )}
          </div>
        )}

        {/* Analyzing Step */}
        {step === 'analyzing' && (
          <div className="py-12 flex flex-col items-center justify-center gap-4">
            <Loader2 className="h-8 w-8 animate-spin text-cyan-600" />
            <p className="text-slate-600 dark:text-slate-400">
              Analyzing impact...
            </p>
            <p className="text-sm text-slate-500">
              Traversing relationships up to {maxDepth} levels deep
            </p>
          </div>
        )}

        {/* Results Step */}
        {step === 'results' && result && (
          <div className="space-y-6 py-4 w-full max-w-full min-w-0 overflow-x-hidden">
            {/* Summary */}
            <ImpactSummaryCards result={result} />

            {/* Detailed Results */}
            {result.impactedItems.length > 0 && (
              <div className="space-y-3 w-full max-w-full min-w-0">
                <h3 className="text-lg font-medium text-slate-900 dark:text-slate-100">
                  Impacted Items
                </h3>
                <ImpactResultsTable
                  items={result.impactedItems}
                  onSelectionChange={setSelectedItemIds}
                />
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {step === 'configure' && (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={runAnalysis}
                disabled={includeDomains.length === 0}
              >
                <Search className="h-4 w-4 mr-2" />
                Analyze Impact
              </Button>
            </>
          )}

          {step === 'analyzing' && (
            <Button variant="outline" onClick={() => setStep('configure')}>
              Cancel
            </Button>
          )}

          {step === 'results' && (
            <>
              <Button
                variant="outline"
                onClick={() => setStep('configure')}
                className="mr-auto"
              >
                <ArrowLeft className="h-4 w-4 mr-2" />
                Reconfigure
              </Button>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Close
              </Button>
              {result && result.impactedItems.length > 0 && (
                <Button
                  onClick={createEcoFromSelection}
                  disabled={selectedItemIds.length === 0}
                >
                  Create ECO
                  {selectedItemIds.length > 0 && (
                    <span className="ml-1">({selectedItemIds.length})</span>
                  )}
                  <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
