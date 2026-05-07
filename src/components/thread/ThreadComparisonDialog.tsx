import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  AlertCircle,
  ArrowLeft,
  Cog,
  Factory,
  FileText,
  FlaskConical,
  GitCompare,
  Loader2,
} from 'lucide-react'
import { ContextSelector } from './ContextSelector'
import { ComparisonSummaryCards } from './ComparisonSummaryCards'
import { DiffLegend } from './DiffLegend'
import { ThreadNodeDiff } from './ThreadNodeDiff'
import { swimLaneLayout } from './swimLaneLayout'

import type { Edge, Node } from '@xyflow/react'
import type { ThreadDomain } from '@/lib/services/ThreadService'
import type {
  ComparisonTargets,
  ThreadComparison,
} from '@/lib/services/ThreadComparisonService'
import type { VersionContext } from '@/lib/services/VersionResolver'
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

interface ThreadComparisonDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  itemId: string
  itemNumber: string
  itemName?: string | null
  designId: string
}

type WizardStep = 'configure' | 'comparing' | 'results'

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
 * Wizard-style dialog for comparing digital threads at different version contexts.
 */
export function ThreadComparisonDialog({
  open,
  onOpenChange,
  itemId,
  itemNumber,
  itemName,
  designId,
}: ThreadComparisonDialogProps) {
  // Wizard state
  const [step, setStep] = useState<WizardStep>('configure')

  // Comparison targets (tags, branches, commits)
  const [targets, setTargets] = useState<ComparisonTargets | null>(null)
  const [loadingTargets, setLoadingTargets] = useState(false)

  // Configuration
  const [beforeContext, setBeforeContext] = useState<VersionContext | null>(
    null,
  )
  const [afterContext, setAfterContext] = useState<VersionContext | null>({
    type: 'released',
    designId,
  })
  const [includeDomains, setIncludeDomains] = useState<Array<ThreadDomain>>([
    'engineering',
    'manufacturing',
  ])
  const [showOnlyChanges, setShowOnlyChanges] = useState(false)

  // Results
  const [result, setResult] = useState<ThreadComparison | null>(null)
  const [error, setError] = useState<string | null>(null)

  // React Flow state
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const nodeTypes = useMemo(() => ({ threadNodeDiff: ThreadNodeDiff }), [])

  // Load comparison targets when dialog opens
  useEffect(() => {
    if (open && !targets && !loadingTargets) {
      setLoadingTargets(true)
      apiFetch<{ data: ComparisonTargets }>(
        `/api/v1/thread/${itemId}/comparison-targets`,
      )
        .then((response) => {
          setTargets(response.data)
        })
        .catch((err) => {
          setError(
            err instanceof Error ? err.message : 'Failed to load targets',
          )
        })
        .finally(() => {
          setLoadingTargets(false)
        })
    }
  }, [open, itemId, targets, loadingTargets])

  // Toggle domain selection
  const toggleDomain = (domain: ThreadDomain) => {
    if (includeDomains.includes(domain)) {
      setIncludeDomains(includeDomains.filter((d) => d !== domain))
    } else {
      setIncludeDomains([...includeDomains, domain])
    }
  }

  // Run comparison
  const runComparison = useCallback(async () => {
    if (!beforeContext || !afterContext) return

    setStep('comparing')
    setError(null)
    setResult(null)

    try {
      const response = await apiFetch<{ data: ThreadComparison }>(
        `/api/v1/thread/${itemId}/compare`,
        {
          method: 'POST',
          body: JSON.stringify({
            beforeContext,
            afterContext,
            domains: includeDomains,
            includeFieldChanges: true,
          }),
        },
      )

      setResult(response.data)

      // Build nodes for visualization
      const allNodeDiffs = [
        response.data.focalItem,
        ...response.data.domains.requirements,
        ...response.data.domains.engineering,
        ...response.data.domains.manufacturing,
        ...response.data.domains.validation,
      ]

      // Filter if showing only changes
      const filteredDiffs = showOnlyChanges
        ? allNodeDiffs.filter((d) => d.status !== 'unchanged')
        : allNodeDiffs

      // Convert to ThreadNode format for layout
      const threadNodes = filteredDiffs.map((diff) => diff.node)

      // Build edges with diff status
      const threadEdges = response.data.relationships.map((edgeDiff) => ({
        ...edgeDiff.edge,
        diffStatus: edgeDiff.status,
      }))

      // Apply swim lane layout
      const { nodes: layoutedNodes, edges: layoutedEdges } = swimLaneLayout(
        threadNodes,
        threadEdges,
      )

      // Add diff status to nodes
      const nodesWithDiff = layoutedNodes.map((node) => {
        const nodeDiff = allNodeDiffs.find((d) => d.node.id === node.id)
        return {
          ...node,
          type: 'threadNodeDiff',
          data: (nodeDiff ?? {}) as Record<string, unknown>,
        }
      })

      // Style edges based on diff status
      const edgesWithDiff = layoutedEdges.map((edge) => {
        const edgeDiff = response.data.relationships.find(
          (d) => d.edge.id === edge.id,
        )
        const status = edgeDiff?.status ?? 'unchanged'

        let strokeColor = '#94a3b8' // default gray
        let strokeDasharray = ''
        if (status === 'added') {
          strokeColor = '#22c55e' // green
        } else if (status === 'removed') {
          strokeColor = '#ef4444' // red
          strokeDasharray = '5,5'
        } else if (status === 'modified') {
          strokeColor = '#f59e0b' // amber
        }

        return {
          ...edge,
          style: {
            ...edge.style,
            stroke: strokeColor,
            strokeDasharray,
          },
        }
      })

      setNodes(nodesWithDiff)
      setEdges(edgesWithDiff)
      setStep('results')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Comparison failed')
      setStep('configure')
    }
  }, [
    itemId,
    beforeContext,
    afterContext,
    includeDomains,
    showOnlyChanges,
    setNodes,
    setEdges,
  ])

  // Reset dialog state when closed
  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      setStep('configure')
      setResult(null)
      setError(null)
      setNodes([])
      setEdges([])
      // Don't reset targets - cache them
    }
    onOpenChange(isOpen)
  }

  const canCompare =
    beforeContext !== null && afterContext !== null && includeDomains.length > 0

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className={cn(
          'max-h-[90vh] overflow-y-auto',
          step === 'results' ? 'max-w-6xl' : 'max-w-3xl',
        )}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitCompare className="h-5 w-5" />
            Compare Thread Versions
          </DialogTitle>
          <DialogDescription>
            Compare the digital thread for{' '}
            <span className="font-medium text-slate-900 dark:text-slate-100">
              {itemNumber}
            </span>
            {itemName && <> ({itemName})</>} at different version contexts.
          </DialogDescription>
        </DialogHeader>

        {/* Configure Step */}
        {step === 'configure' && (
          <div className="space-y-6 py-4">
            {loadingTargets ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
                <span className="ml-2 text-slate-500">
                  Loading version contexts...
                </span>
              </div>
            ) : targets ? (
              <>
                {/* Before Context */}
                <ContextSelector
                  targets={targets}
                  designId={designId}
                  value={beforeContext}
                  onChange={setBeforeContext}
                  label="Before (baseline)"
                />

                {/* After Context */}
                <ContextSelector
                  targets={targets}
                  designId={designId}
                  value={afterContext}
                  onChange={setAfterContext}
                  label="After (compare to)"
                />

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
                        <Icon className="h-4 w-4" />
                        <span className="text-sm">{label}</span>
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

                {/* Show only changes toggle */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={showOnlyChanges}
                    onCheckedChange={(checked) =>
                      setShowOnlyChanges(checked === true)
                    }
                  />
                  <span className="text-sm text-slate-600 dark:text-slate-400">
                    Show only changed items (hide unchanged)
                  </span>
                </label>
              </>
            ) : (
              <div className="text-center py-8 text-slate-500">
                <AlertCircle className="h-8 w-8 mx-auto mb-2 text-red-400" />
                <p>Failed to load version contexts.</p>
                {error && <p className="text-red-500 text-sm mt-1">{error}</p>}
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950 text-red-600 dark:text-red-400 text-sm flex items-center gap-2">
                <AlertCircle className="h-4 w-4" />
                {error}
              </div>
            )}
          </div>
        )}

        {/* Comparing Step */}
        {step === 'comparing' && (
          <div className="py-12 flex flex-col items-center justify-center gap-4">
            <Loader2 className="h-8 w-8 animate-spin text-cyan-600" />
            <p className="text-slate-600 dark:text-slate-400">
              Comparing threads...
            </p>
            <p className="text-sm text-slate-500">
              Analyzing changes between version contexts
            </p>
          </div>
        )}

        {/* Results Step */}
        {step === 'results' && result && (
          <div className="space-y-6 py-4">
            {/* Context labels */}
            <div className="flex items-center justify-between p-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700">
              <div>
                <span className="text-xs text-slate-500">Before:</span>
                <p className="text-sm font-medium">
                  {result.beforeContext.label}
                </p>
              </div>
              <GitCompare className="h-5 w-5 text-slate-400" />
              <div className="text-right">
                <span className="text-xs text-slate-500">After:</span>
                <p className="text-sm font-medium">
                  {result.afterContext.label}
                </p>
              </div>
            </div>

            {/* Summary cards */}
            <ComparisonSummaryCards stats={result.stats} />

            {/* Diff legend */}
            <DiffLegend />

            {/* Thread visualization */}
            {nodes.length > 0 && (
              <div className="h-[400px] border rounded-lg bg-slate-50 dark:bg-slate-950">
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  nodeTypes={nodeTypes}
                  fitView
                  attributionPosition="bottom-right"
                  minZoom={0.1}
                  maxZoom={2}
                >
                  <Background color="#aaa" gap={16} />
                  <Controls />
                </ReactFlow>
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
              <Button onClick={runComparison} disabled={!canCompare}>
                <GitCompare className="h-4 w-4 mr-2" />
                Compare
              </Button>
            </>
          )}

          {step === 'comparing' && (
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
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
