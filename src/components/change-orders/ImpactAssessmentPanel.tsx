import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  Box,
  Check,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  GitBranch,
  Layers,
  Loader2,
  Plus,
  Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Risk } from '@/lib/items/types/change-order'
import { apiFetch } from '@/lib/api/client'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui'

interface WhereUsedNode {
  itemId: string
  masterId?: string
  itemNumber: string
  revision: string
  name: string
  itemType: string
  state: string
  depth: number
  designId?: string | null
  designCode?: string | null
  designName?: string | null
  affectedByCount?: number
  sourceAffectedItems?: Array<{
    affectedItemId: string
    itemNumber: string
    changeAction: string
  }>
  recommendation?: 'revise' | null
}

type ImpactRelationshipType =
  | 'bom_where_used'
  | 'definition_instance'
  | 'definition_source'
  | 'usage_cousin'
  | 'cross_design_ref'

interface CrossDesignImpactedPart {
  itemId: string
  itemNumber: string
  name: string
  changeAction: string
  revision: string
  relationshipType?: ImpactRelationshipType
  relationshipLabel?: string
  // The item in the external design that is impacted
  targetItemId?: string
  targetItemNumber?: string
  targetItemName?: string
}

interface CrossDesignImpact {
  designId: string
  designCode: string
  designName: string
  impactedParts: Array<CrossDesignImpactedPart>
  summary: Record<string, number>
  relationshipSummary?: Record<string, number>
}

export interface ImpactData {
  whereUsed: Array<WhereUsedNode>
  documents: Array<any>
  relatedChanges: Array<any>
  totalImpactedItems: number
  maxDepth: number
  risks: Array<Risk>
  crossDesignImpacts?: Array<CrossDesignImpact>
}

export interface ImpactAssessmentPanelProps {
  changeOrderId: string
  impactData?: ImpactData | null
  isLoading?: boolean
  onRunAssessment?: () => void | Promise<void>
}

const riskSeverityColors: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive'
> = {
  low: 'success',
  medium: 'warning',
  high: 'destructive',
  critical: 'destructive',
}

const riskCategoryIcons: Record<string, any> = {
  production: GitBranch,
  compliance: FileText,
  schedule: AlertTriangle,
  quality: CheckCircle,
  cost: AlertCircle,
  inventory: AlertCircle,
  'cross-design': Layers,
}

const changeActionColors: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive'
> = {
  revise: 'warning',
  release: 'success',
  obsolete: 'destructive',
  add: 'default',
  remove: 'destructive',
}

const relationshipTypeLabels: Record<string, string> = {
  bom_where_used: 'BOM Where-Used',
  definition_instance: 'Definition Instance',
  definition_source: 'Definition Source',
  usage_cousin: 'Usage Cousin',
  cross_design_ref: 'Cross-Design Reference',
}

const relationshipTypeIcons: Record<string, LucideIcon> = {
  bom_where_used: GitBranch,
  definition_instance: Box,
  definition_source: Box,
  usage_cousin: Users,
  cross_design_ref: ExternalLink,
}

function formatCrossDesignSummary(impact: CrossDesignImpact): string {
  // Enhanced format when relationship summary is available
  if (
    impact.relationshipSummary &&
    Object.keys(impact.relationshipSummary).length > 0
  ) {
    const parts = Object.entries(impact.relationshipSummary).map(
      ([type, count]) =>
        `${count} via ${relationshipTypeLabels[type]?.toLowerCase() ?? type}`,
    )
    if (parts.length <= 1) return `Impacted by ${parts[0] ?? ''}`
    return `Impacted by ${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
  }

  // Fallback: original format by change action
  const actionLabels: Record<string, string> = {
    revise: 'revised',
    release: 'released',
    obsolete: 'obsoleted',
    add: 'added',
    remove: 'removed',
  }
  const parts = Object.entries(impact.summary).map(
    ([action, count]) =>
      `${count} part${count !== 1 ? 's' : ''} being ${actionLabels[action] ?? action}`,
  )
  if (parts.length <= 1) return parts[0] ?? ''
  return parts.slice(0, -1).join(', ') + ' and ' + parts.at(-1)
}

function RelationshipGroup({
  type,
  parts,
  designId,
}: {
  type: string
  parts: Array<CrossDesignImpactedPart>
  designId: string
}) {
  const [expanded, setExpanded] = useState(false)
  const Icon = relationshipTypeIcons[type] ?? GitBranch
  const label = relationshipTypeLabels[type] ?? type
  const visibleParts = expanded ? parts : parts.slice(0, 3)
  const hasMore = parts.length > 3

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-600 dark:text-slate-400 py-1">
        <Icon className="h-4 w-4" />
        {label} ({parts.length})
      </div>
      <div className="ml-6 space-y-1">
        {visibleParts.map((part) => (
          <div
            key={`${designId}-${part.itemId}-${part.targetItemId ?? ''}-${type}`}
            className="py-1.5 text-sm space-y-0.5"
          >
            {part.targetItemNumber && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">Impacted:</span>
                <span className="font-mono text-slate-300">
                  {part.targetItemNumber}
                </span>
                <span className="flex-1 truncate text-slate-500">
                  {part.targetItemName}
                </span>
              </div>
            )}
            <div className="flex items-center gap-2">
              {part.targetItemNumber && (
                <span className="text-xs text-slate-500">Source:</span>
              )}
              <span className="font-mono">{part.itemNumber}</span>
              <span className="text-slate-400">{part.revision}</span>
              <span className="flex-1 truncate text-slate-600 dark:text-slate-400">
                {part.name}
              </span>
              <Badge
                variant={changeActionColors[part.changeAction] ?? 'secondary'}
                className="text-xs"
              >
                {part.changeAction}
              </Badge>
            </div>
          </div>
        ))}
        {hasMore && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-sm text-blue-500 hover:text-blue-600 py-1"
          >
            {expanded ? (
              <>
                <ChevronDown className="h-4 w-4" />
                Show less
              </>
            ) : (
              <>
                <ChevronRight className="h-4 w-4" />+{parts.length - 3} more
              </>
            )}
          </button>
        )}
      </div>
    </div>
  )
}

function CrossDesignImpactCard({
  impacts,
}: {
  impacts: Array<CrossDesignImpact>
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-blue-500" />
            Cross-Design Impact
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {impacts.map((impact) => {
            const hasRelationshipSummary =
              impact.relationshipSummary &&
              Object.keys(impact.relationshipSummary).length > 0

            // Group parts by relationship type (default to bom_where_used)
            const partsByType = new Map<
              string,
              Array<CrossDesignImpactedPart>
            >()
            for (const part of impact.impactedParts) {
              const type = part.relationshipType ?? 'bom_where_used'
              if (!partsByType.has(type)) {
                partsByType.set(type, [])
              }
              partsByType.get(type)!.push(part)
            }

            return (
              <div
                key={impact.designId}
                className="border rounded-lg overflow-hidden"
              >
                <div className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-medium">
                        {impact.designCode}
                      </span>
                      <span className="text-slate-500">
                        {impact.designName !== impact.designCode &&
                          impact.designName}
                      </span>
                      <Badge variant="secondary">
                        {impact.impactedParts.length} part
                        {impact.impactedParts.length !== 1 ? 's' : ''}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-1">
                      {Object.entries(impact.summary).map(([action, count]) => (
                        <Badge
                          key={action}
                          variant={changeActionColors[action] ?? 'secondary'}
                          className="text-xs"
                        >
                          {count} {action}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  {/* Relationship type badges */}
                  {hasRelationshipSummary && (
                    <div className="flex items-center gap-1 mb-2">
                      {Object.entries(impact.relationshipSummary!).map(
                        ([type, count]) => {
                          const Icon = relationshipTypeIcons[type] ?? GitBranch
                          return (
                            <Badge
                              key={type}
                              variant="secondary"
                              className="text-xs flex items-center gap-1"
                            >
                              <Icon className="h-3 w-3" />
                              {count} {relationshipTypeLabels[type] ?? type}
                            </Badge>
                          )
                        },
                      )}
                    </div>
                  )}
                  <p className="text-sm text-slate-500">
                    {formatCrossDesignSummary(impact)}
                  </p>
                </div>

                <div className="border-t px-4 py-2 space-y-2">
                  {hasRelationshipSummary && partsByType.size > 1 ? (
                    // Group by relationship type with sub-headers
                    Array.from(partsByType.entries()).map(([type, parts]) => (
                      <RelationshipGroup
                        key={type}
                        type={type}
                        parts={parts}
                        designId={impact.designId}
                      />
                    ))
                  ) : (
                    // Flat list (old format or single type)
                    <FlatPartsList
                      parts={impact.impactedParts}
                      designId={impact.designId}
                    />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

function FlatPartsList({
  parts,
  designId,
}: {
  parts: Array<CrossDesignImpactedPart>
  designId: string
}) {
  const [expanded, setExpanded] = useState(false)
  const visibleParts = expanded ? parts : parts.slice(0, 5)
  const hasMore = parts.length > 5

  return (
    <div className="space-y-1">
      {visibleParts.map((part) => (
        <div
          key={`${designId}-${part.itemId}-${part.targetItemId ?? ''}`}
          className="py-1.5 text-sm space-y-0.5"
        >
          {part.targetItemNumber && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">Impacted:</span>
              <span className="font-mono text-slate-300">
                {part.targetItemNumber}
              </span>
              <span className="flex-1 truncate text-slate-500">
                {part.targetItemName}
              </span>
            </div>
          )}
          <div className="flex items-center gap-2">
            {part.targetItemNumber && (
              <span className="text-xs text-slate-500">Source:</span>
            )}
            <span className="font-mono">{part.itemNumber}</span>
            <span className="text-slate-400">{part.revision}</span>
            <span className="flex-1 truncate text-slate-600 dark:text-slate-400">
              {part.name}
            </span>
            <Badge
              variant={changeActionColors[part.changeAction] ?? 'secondary'}
              className="text-xs"
            >
              {part.changeAction}
            </Badge>
          </div>
        </div>
      ))}
      {hasMore && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-sm text-blue-500 hover:text-blue-600 py-1"
        >
          {expanded ? (
            <>
              <ChevronDown className="h-4 w-4" />
              Show less
            </>
          ) : (
            <>
              <ChevronRight className="h-4 w-4" />+{parts.length - 5} more
            </>
          )}
        </button>
      )}
    </div>
  )
}

export function ImpactAssessmentPanel({
  changeOrderId,
  impactData: externalImpactData,
  isLoading: externalIsLoading,
  onRunAssessment: externalOnRunAssessment,
}: ImpactAssessmentPanelProps) {
  // Internal state for self-managed mode
  const [internalImpactData, setInternalImpactData] =
    useState<ImpactData | null>(null)
  const [internalIsLoading, setInternalIsLoading] = useState(false)
  const [expandedLevels, setExpandedLevels] = useState<Set<number>>(new Set())
  const [addedToEco, setAddedToEco] = useState<Set<string>>(new Set())
  const [addToEcoErrors, setAddToEcoErrors] = useState<Record<string, string>>(
    {},
  )

  // Use external props if provided, otherwise use internal state
  const impactData = externalImpactData ?? internalImpactData
  const isLoading = externalIsLoading ?? internalIsLoading

  // Load existing impact report on mount (self-managed mode)
  const loadExistingReport = useCallback(async () => {
    setInternalIsLoading(true)
    try {
      const response = await apiFetch<{
        data: { impactReport: { reportData: ImpactData } }
      }>(`/api/v1/change-orders/${changeOrderId}/impact-assessment`)
      setInternalImpactData(response.data.impactReport.reportData)
    } catch {
      // No existing report — that's fine, user can run one
      setInternalImpactData(null)
    } finally {
      setInternalIsLoading(false)
    }
  }, [changeOrderId])

  // Run impact assessment via POST (self-managed mode)
  const runAssessment = useCallback(async () => {
    setInternalIsLoading(true)
    try {
      const response = await apiFetch<{
        data: { impactAnalysis: ImpactData }
      }>(`/api/v1/change-orders/${changeOrderId}/impact-assessment`, {
        method: 'POST',
      })
      setInternalImpactData(response.data.impactAnalysis)
    } catch {
      setInternalImpactData(null)
    } finally {
      setInternalIsLoading(false)
    }
  }, [changeOrderId])

  // Auto-fetch on mount if in self-managed mode
  useEffect(() => {
    if (!externalImpactData && !externalOnRunAssessment) {
      loadExistingReport()
    }
  }, [externalImpactData, externalOnRunAssessment, loadExistingReport])

  const handleRunAssessment = useCallback(async () => {
    if (externalOnRunAssessment) {
      await externalOnRunAssessment()
      return
    }
    await runAssessment()
  }, [externalOnRunAssessment, runAssessment])

  // Handle "Add to ECO" action
  const handleAddToEco = useCallback(
    async (node: WhereUsedNode) => {
      const nodeKey = node.masterId ?? node.itemId
      try {
        await apiFetch(`/api/v1/change-orders/${changeOrderId}/affected-items`, {
          method: 'POST',
          body: JSON.stringify({
            affectedItemId: node.itemId,
            changeAction: 'revise',
          }),
        })
        setAddedToEco((prev) => new Set(prev).add(nodeKey))
        setAddToEcoErrors((prev) => {
          const next = { ...prev }
          delete next[nodeKey]
          return next
        })
      } catch (err: any) {
        const message =
          err?.data?.error ?? err?.message ?? 'Failed to add to ECO'
        setAddToEcoErrors((prev) => ({ ...prev, [nodeKey]: message }))
      }
    },
    [changeOrderId],
  )

  if (!impactData && !isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Impact Assessment</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8">
            <AlertTriangle className="h-12 w-12 mx-auto text-slate-400 mb-4" />
            <p className="text-slate-500 dark:text-slate-400 mb-4">
              Impact assessment has not been run yet
            </p>
            <Button onClick={handleRunAssessment}>Run Impact Assessment</Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Impact Assessment</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8">
            <Loader2 className="h-12 w-12 mx-auto text-slate-400 mb-4 animate-spin" />
            <p className="text-slate-500 dark:text-slate-400">
              Analyzing impact...
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!impactData) return null

  // Group where-used by depth for hierarchical display (with defensive dedup for old reports)
  const whereUsedByDepth = impactData.whereUsed.reduce(
    (acc, node) => {
      if (!(node.depth in acc)) {
        acc[node.depth] = []
      }
      // Dedup by masterId (falls back to itemId for old reports without masterId)
      const dedupKey = node.masterId ?? node.itemId
      if (!acc[node.depth].some((n) => (n.masterId ?? n.itemId) === dedupKey)) {
        acc[node.depth].push(node)
      }
      return acc
    },
    {} as Record<number, Array<WhereUsedNode>>,
  )

  return (
    <div className="space-y-6">
      {/* Summary Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Impact Assessment Summary</CardTitle>
            <Button variant="outline" size="sm" onClick={handleRunAssessment}>
              Refresh Assessment
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className="p-4 border rounded-lg">
              <div className="text-2xl font-bold">
                {impactData.totalImpactedItems}
              </div>
              <div className="text-sm text-slate-500">Total Impacted Items</div>
            </div>
            <div className="p-4 border rounded-lg">
              <div className="text-2xl font-bold">
                {impactData.whereUsed.length}
              </div>
              <div className="text-sm text-slate-500">
                Where-Used Assemblies
              </div>
            </div>
            <div className="p-4 border rounded-lg">
              <div className="text-2xl font-bold">{impactData.maxDepth}</div>
              <div className="text-sm text-slate-500">Max BOM Depth</div>
            </div>
            <div className="p-4 border rounded-lg">
              <div className="text-2xl font-bold">
                {impactData.risks.length}
              </div>
              <div className="text-sm text-slate-500">Identified Risks</div>
            </div>
            <div className="p-4 border rounded-lg">
              <div className="text-2xl font-bold">
                {impactData.crossDesignImpacts?.length ?? 0}
              </div>
              <div className="text-sm text-slate-500">External Designs</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Risks Card */}
      {impactData.risks.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Identified Risks</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {impactData.risks.map((risk, idx) => {
                const Icon = riskCategoryIcons[risk.category] || AlertCircle
                return (
                  <div
                    key={idx}
                    className="p-4 border rounded-lg flex items-start gap-3"
                  >
                    <Icon className="h-5 w-5 text-slate-500 mt-0.5 flex-shrink-0" />
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant={riskSeverityColors[risk.severity]}>
                          {risk.severity}
                        </Badge>
                        <span className="text-sm text-slate-500 capitalize">
                          {risk.category}
                        </span>
                        {risk.requiresAcknowledgement && (
                          <Badge variant="destructive" className="text-xs">
                            Requires Acknowledgement
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm">{risk.description}</p>
                      {risk.mitigation && (
                        <p className="text-sm text-slate-500 mt-2">
                          <strong>Mitigation:</strong> {risk.mitigation}
                        </p>
                      )}
                      {risk.affectedItems && risk.affectedItems.length > 0 && (
                        <div className="mt-2 flex flex-wrap items-center gap-1">
                          <span className="text-xs text-slate-500 mr-1">
                            Affected Parts:
                          </span>
                          {risk.affectedItems
                            .slice(0, 5)
                            .map((itemNum: string) => (
                              <Badge
                                key={itemNum}
                                variant="secondary"
                                className="text-xs font-mono"
                              >
                                {itemNum}
                              </Badge>
                            ))}
                          {risk.affectedItems.length > 5 && (
                            <Badge variant="secondary" className="text-xs">
                              +{risk.affectedItems.length - 5} more
                            </Badge>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Cross-Design Impact */}
      {impactData.crossDesignImpacts &&
        impactData.crossDesignImpacts.length > 0 && (
          <CrossDesignImpactCard impacts={impactData.crossDesignImpacts} />
        )}

      {/* Where-Used Hierarchical View */}
      {impactData.whereUsed.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Where-Used Impact</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {Object.entries(whereUsedByDepth)
                .sort(([a], [b]) => parseInt(a) - parseInt(b))
                .map(([depth, nodes]) => (
                  <div key={depth} className="space-y-1">
                    <div className="text-sm font-medium text-slate-500 mb-2">
                      Level {depth} ({nodes.length} items)
                    </div>
                    <div className="space-y-1 ml-4">
                      {(expandedLevels.has(parseInt(depth))
                        ? nodes
                        : nodes.slice(0, 10)
                      ).map((node) => {
                        const nodeKey = node.masterId ?? node.itemId
                        const isAdded = addedToEco.has(nodeKey)
                        const error = addToEcoErrors[nodeKey]
                        return (
                          <div
                            key={nodeKey}
                            className="p-2 text-sm border rounded hover:bg-slate-50 dark:hover:bg-slate-900 space-y-1"
                          >
                            {/* Main line */}
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className="text-xs">
                                {node.itemType}
                              </Badge>
                              <span className="font-mono">
                                {node.itemNumber}
                              </span>
                              <span className="text-slate-500">
                                {node.revision}
                              </span>
                              <span className="flex-1 truncate">
                                {node.name}
                              </span>
                              {node.designCode && (
                                <span className="text-xs text-slate-400 font-mono">
                                  {node.designCode}
                                </span>
                              )}
                              <Badge
                                variant={
                                  node.state === 'Released'
                                    ? 'success'
                                    : 'secondary'
                                }
                              >
                                {node.state}
                              </Badge>
                            </div>
                            {/* Source line: which affected items this parent contains */}
                            {node.sourceAffectedItems &&
                              node.sourceAffectedItems.length > 0 && (
                                <div className="flex items-center gap-1 text-xs text-slate-500 ml-1">
                                  <span>Contains:</span>
                                  {node.sourceAffectedItems.map((src) => (
                                    <Badge
                                      key={src.affectedItemId}
                                      variant={
                                        changeActionColors[src.changeAction] ??
                                        'secondary'
                                      }
                                      className="text-xs font-mono"
                                    >
                                      {src.itemNumber} ({src.changeAction})
                                    </Badge>
                                  ))}
                                </div>
                              )}
                            {/* Recommendation line for released assemblies */}
                            {(node.recommendation === 'revise' ||
                              node.state === 'Released') && (
                              <div className="flex items-center gap-2 ml-1">
                                <span className="text-xs text-amber-600 dark:text-amber-400">
                                  Released assembly — consider revising to
                                  incorporate changes
                                </span>
                                {isAdded ? (
                                  <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                                    <Check className="h-3 w-3" />
                                    Added to ECO
                                  </span>
                                ) : (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-6 text-xs px-2"
                                    onClick={() => handleAddToEco(node)}
                                  >
                                    <Plus className="h-3 w-3 mr-1" />
                                    Add to ECO
                                  </Button>
                                )}
                                {error && (
                                  <span className="text-xs text-red-500">
                                    {error}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })}
                      {nodes.length > 10 && (
                        <button
                          onClick={() => {
                            setExpandedLevels((prev) => {
                              const next = new Set(prev)
                              const level = parseInt(depth)
                              if (next.has(level)) {
                                next.delete(level)
                              } else {
                                next.add(level)
                              }
                              return next
                            })
                          }}
                          className="text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 text-center py-2 w-full"
                        >
                          {expandedLevels.has(parseInt(depth))
                            ? 'Show less'
                            : `+ ${nodes.length - 10} more at this level`}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Related Changes */}
      {impactData.relatedChanges.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              <div className="flex items-center gap-2">
                <AlertCircle className="h-5 w-5 text-orange-500" />
                Conflicting Change Orders
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {impactData.relatedChanges.map((change: any, idx: number) => (
                <div
                  key={idx}
                  className="p-3 border rounded-lg flex items-center justify-between"
                >
                  <div>
                    <span className="font-medium">{change.itemNumber}</span>
                    <span className="text-sm text-slate-500 ml-2">
                      State: {change.state}
                    </span>
                  </div>
                  <Button variant="outline" size="sm">
                    View
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Documents */}
      {impactData.documents.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              Impacted Documents ({impactData.documents.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm text-slate-500">
              {impactData.documents.length} documents may require updates
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
