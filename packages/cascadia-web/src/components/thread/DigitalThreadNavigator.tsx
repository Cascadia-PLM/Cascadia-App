// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  ArrowDown,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Factory,
  FlaskConical,
  GitCompare,
  ListChecks,
  Package,
  RefreshCw,
  Wrench,
} from 'lucide-react'
import { ThreadNode } from './ThreadNode'
import { ThreadComparisonDialog } from './ThreadComparisonDialog'
import {
  buildThreadAdjacency,
  computeVisibleThreadIds,
  swimLaneLayout,
} from './swimLaneLayout'

import type { Edge, Node } from '@xyflow/react'
import type { ThreadExpandState } from './ThreadNode'
import type { ThreadResponse } from '@/lib/services/ThreadService'
import { Card, CardContent, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { FullscreenGraphWrapper } from '@/components/ui/FullscreenGraphWrapper'
import { itemThreadQuery } from '@/lib/query'
import { useTheme } from '@/lib/theme'

interface DigitalThreadNavigatorProps {
  itemId: string
  itemNumber?: string
  itemName?: string | null
  designId?: string
  defaultExpanded?: boolean
}

/** Every domain the navigator draws; the endpoint defaults to a narrower set. */
const THREAD_DOMAINS = [
  'requirements',
  'validation',
  'engineering',
  'manufacturing',
  'physical',
]

export function DigitalThreadNavigator({
  itemId,
  itemNumber = '',
  itemName = null,
  designId = '',
  defaultExpanded = false,
}: DigitalThreadNavigatorProps) {
  const { theme } = useTheme()
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  const [upstreamDepth, setUpstreamDepth] = useState(3)
  const [downstreamDepth, setDownstreamDepth] = useState(3)
  const [bomDepth, setBomDepth] = useState(2)
  const [direction, setDirection] = useState<'TB' | 'LR'>('TB')
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [comparisonDialogOpen, setComparisonDialogOpen] = useState(false)
  const cachedThreadData = useRef<ThreadResponse | null>(null)
  const directionRef = useRef(direction)
  directionRef.current = direction
  // Per-node collapse state; a missing entry means fully expanded.
  const collapsedRef = useRef(new Map<string, { up: boolean; down: boolean }>())
  // Ref indirection keeps the callback injected into node data stable while
  // always invoking the latest toggle implementation (assigned below).
  const toggleExpandRef = useRef<(nodeId: string, dir: 'up' | 'down') => void>(
    () => {},
  )
  const stableToggleExpand = useCallback(
    (nodeId: string, dir: 'up' | 'down') => {
      toggleExpandRef.current(nodeId, dir)
    },
    [],
  )

  // The thread itself, asked only once the card is open. Keyed beneath the
  // item and by the depth budget, so a relationship or version write elsewhere
  // refreshes a mounted navigator and moving a depth control re-keys the read.
  const threadQuery = useQuery(
    itemThreadQuery<ThreadResponse>(
      itemId,
      { upstreamDepth, downstreamDepth, bomDepth, domains: THREAD_DOMAINS },
      isExpanded,
    ),
  )
  const threadData = threadQuery.data
  const loading = threadQuery.isFetching
  const error = threadQuery.error
  const stats = threadData?.stats ?? null

  // The server resolves the focal item; the props are only the caller's guess
  // until it answers.
  const focalItem = threadData?.focalItem
  const focalItemNumber = focalItem ? focalItem.itemNumber : itemNumber
  const focalItemName = focalItem ? focalItem.name : itemName
  const focalDesignId = focalItem ? (focalItem.designId ?? '') : designId

  const nodeTypes = useMemo(() => ({ threadNode: ThreadNode }), [])

  const applyLayout = useCallback(
    (data: ThreadResponse, rankdir: 'TB' | 'LR') => {
      const allNodes = [
        ...data.domains.requirements,
        ...data.domains.validation,
        ...data.domains.engineering,
        ...data.domains.manufacturing,
        ...data.domains.physical,
      ]
      const adjacency = buildThreadAdjacency(allNodes, data.relationships)
      const visibleIds = computeVisibleThreadIds(
        data.focalItem.id,
        allNodes,
        adjacency,
        collapsedRef.current,
      )
      const visibleNodes = allNodes.filter((n) => visibleIds.has(n.id))

      const { nodes: layoutedNodes, edges: layoutedEdges } = swimLaneLayout(
        visibleNodes,
        data.relationships,
        { rankdir },
      )

      // Toggle buttons only make sense when the focal item anchors the
      // visibility walk; without it every node is always shown.
      const focalInLanes = allNodes.some((n) => n.id === data.focalItem.id)
      const expandStateOf = (
        nodeId: string,
        dir: 'up' | 'down',
      ): ThreadExpandState => {
        const neighbors = adjacency[dir].get(nodeId)
        if (!neighbors || neighbors.size === 0) return 'leaf'
        return collapsedRef.current.get(nodeId)?.[dir]
          ? 'collapsed'
          : 'expanded'
      }

      setNodes(
        focalInLanes
          ? layoutedNodes.map((node) => ({
              ...node,
              data: {
                ...node.data,
                expandState: {
                  up: expandStateOf(node.id, 'up'),
                  down: expandStateOf(node.id, 'down'),
                },
                isHorizontal: rankdir === 'LR',
                onToggleExpand: stableToggleExpand,
              },
            }))
          : layoutedNodes,
      )
      setEdges(layoutedEdges)
    },
    [setNodes, setEdges, stableToggleExpand],
  )

  // Assigned every render so the stable callback always sees current state.
  toggleExpandRef.current = (nodeId: string, dir: 'up' | 'down') => {
    const current = collapsedRef.current.get(nodeId) ?? {
      up: false,
      down: false,
    }
    collapsedRef.current.set(nodeId, { ...current, [dir]: !current[dir] })
    if (cachedThreadData.current) {
      applyLayout(cachedThreadData.current, directionRef.current)
    }
  }

  // React Flow's model is derived state: rebuild it whenever the query hands
  // back a different thread. `applyLayout` is stable and the direction comes
  // from a ref, so laying out never re-runs this.
  useEffect(() => {
    if (!threadData) return
    cachedThreadData.current = threadData
    applyLayout(threadData, directionRef.current)
  }, [threadData, applyLayout])

  const handleRefresh = () => {
    void threadQuery.refetch()
  }

  const handleToggleDirection = useCallback(() => {
    const newDir = direction === 'TB' ? 'LR' : 'TB'
    setDirection(newDir)
    if (cachedThreadData.current) {
      applyLayout(cachedThreadData.current, newDir)
    }
  }, [direction, applyLayout])

  // Count nodes by domain
  const requirementsCount = nodes.filter(
    (n) => n.data.domain === 'requirements',
  ).length
  const validationCount = nodes.filter(
    (n) => n.data.domain === 'validation',
  ).length
  const engineeringCount = nodes.filter(
    (n) => n.data.domain === 'engineering',
  ).length
  const manufacturingCount = nodes.filter(
    (n) => n.data.domain === 'manufacturing',
  ).length
  const physicalCount = nodes.filter((n) => n.data.domain === 'physical').length

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center gap-2 text-lg font-semibold hover:text-cyan-600 dark:hover:text-cyan-400 transition-colors"
          >
            {isExpanded ? (
              <ChevronDown className="h-5 w-5" />
            ) : (
              <ChevronRight className="h-5 w-5" />
            )}
            <span>Digital Thread</span>
          </button>
          {isExpanded && (
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <label className="text-sm text-slate-600 dark:text-slate-400">
                  Upstream:
                </label>
                <select
                  value={upstreamDepth}
                  onChange={(e) =>
                    setUpstreamDepth(parseInt(e.target.value, 10))
                  }
                  disabled={loading}
                  className="text-sm rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                >
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                  <option value={5}>5</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-sm text-slate-600 dark:text-slate-400">
                  Downstream:
                </label>
                <select
                  value={downstreamDepth}
                  onChange={(e) =>
                    setDownstreamDepth(parseInt(e.target.value, 10))
                  }
                  disabled={loading}
                  className="text-sm rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                >
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                  <option value={5}>5</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-sm text-slate-600 dark:text-slate-400">
                  BOM Depth:
                </label>
                <select
                  value={bomDepth}
                  onChange={(e) => setBomDepth(parseInt(e.target.value, 10))}
                  disabled={loading}
                  className="text-sm rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                >
                  <option value={0}>0</option>
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                </select>
              </div>
              <div className="flex items-center rounded-md border border-slate-300 dark:border-slate-700">
                <button
                  type="button"
                  onClick={() => {
                    if (direction !== 'TB') handleToggleDirection()
                  }}
                  className={`px-2 py-1 text-sm rounded-l-md transition-colors ${
                    direction === 'TB'
                      ? 'bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-slate-100'
                      : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                  }`}
                  title="Vertical layout"
                >
                  <ArrowDown className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (direction !== 'LR') handleToggleDirection()
                  }}
                  className={`px-2 py-1 text-sm rounded-r-md transition-colors ${
                    direction === 'LR'
                      ? 'bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-slate-100'
                      : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                  }`}
                  title="Horizontal layout"
                >
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={loading}
              >
                <RefreshCw
                  className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`}
                />
              </Button>
              {focalDesignId && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setComparisonDialogOpen(true)}
                  disabled={loading}
                >
                  <GitCompare className="h-4 w-4 mr-2" />
                  Compare
                </Button>
              )}
            </div>
          )}
        </div>
      </CardHeader>

      {isExpanded && (
        <CardContent>
          {/* Domain Legend */}
          <div className="flex items-center gap-6 mb-4 pb-4 border-b border-slate-300 dark:border-slate-700 flex-wrap">
            {requirementsCount > 0 && (
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded bg-purple-100 dark:bg-purple-900 border border-purple-300 dark:border-purple-700" />
                <ListChecks className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                <span className="text-sm text-slate-600 dark:text-slate-400">
                  Requirements
                </span>
                <span className="text-xs text-slate-500">
                  ({requirementsCount})
                </span>
              </div>
            )}
            {validationCount > 0 && (
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded bg-teal-100 dark:bg-teal-900 border border-teal-300 dark:border-teal-700" />
                <FlaskConical className="h-4 w-4 text-teal-600 dark:text-teal-400" />
                <span className="text-sm text-slate-600 dark:text-slate-400">
                  Validation (Tests)
                </span>
                <span className="text-xs text-slate-500">
                  ({validationCount})
                </span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded bg-blue-100 dark:bg-blue-900 border border-blue-300 dark:border-blue-700" />
              <Wrench className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              <span className="text-sm text-slate-600 dark:text-slate-400">
                Engineering (EBOM)
              </span>
              {engineeringCount > 0 && (
                <span className="text-xs text-slate-500">
                  ({engineeringCount})
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded bg-amber-100 dark:bg-amber-900 border border-amber-300 dark:border-amber-700" />
              <Factory className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              <span className="text-sm text-slate-600 dark:text-slate-400">
                Manufacturing (MBOM)
              </span>
              {manufacturingCount > 0 && (
                <span className="text-xs text-slate-500">
                  ({manufacturingCount})
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded bg-emerald-100 dark:bg-emerald-900 border border-emerald-300 dark:border-emerald-700" />
              <Package className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <span className="text-sm text-slate-600 dark:text-slate-400">
                Physical (As-Built)
              </span>
              {physicalCount > 0 && (
                <span className="text-xs text-slate-500">
                  ({physicalCount})
                </span>
              )}
            </div>
            {stats &&
              (stats.mbomCoverage > 0 ||
                stats.requirementsCoverage > 0 ||
                stats.testCoverage > 0) && (
                <div className="ml-auto flex items-center gap-4 text-sm text-slate-500">
                  {stats.mbomCoverage > 0 && (
                    <span>MBOM Coverage: {stats.mbomCoverage}%</span>
                  )}
                  {stats.requirementsCoverage > 0 && (
                    <span>Req Coverage: {stats.requirementsCoverage}%</span>
                  )}
                  {stats.testCoverage > 0 && (
                    <span>Test Coverage: {stats.testCoverage}%</span>
                  )}
                </div>
              )}
          </div>

          {loading && nodes.length === 0 && (
            <div className="flex items-center justify-center py-12 text-slate-500">
              <RefreshCw className="h-6 w-6 animate-spin mr-2" />
              Loading digital thread...
            </div>
          )}

          {error && (
            <div className="text-center py-8 text-red-600 dark:text-red-400">
              Error: {error.message}
            </div>
          )}

          {!loading && !error && nodes.length === 0 && (
            <div className="text-center py-8 text-slate-500">
              No thread relationships found. This item is not linked to any
              requirements, Engineering or Manufacturing designs, tests, work
              orders, or physical parts.
            </div>
          )}

          {nodes.length > 0 && (
            <FullscreenGraphWrapper
              title="Digital Thread"
              subtitle={`${stats?.totalNodes || nodes.length} items, ${stats?.totalRelationships || edges.length} relationships`}
              inlineHeight="500px"
              headerControls={
                <div className="flex items-center gap-2">
                  <div className="flex items-center rounded-md border border-slate-300 dark:border-slate-700">
                    <button
                      type="button"
                      onClick={() => {
                        if (direction !== 'TB') handleToggleDirection()
                      }}
                      className={`px-2 py-1 text-sm rounded-l-md transition-colors ${
                        direction === 'TB'
                          ? 'bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-slate-100'
                          : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                      }`}
                      title="Vertical layout"
                    >
                      <ArrowDown className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (direction !== 'LR') handleToggleDirection()
                      }}
                      className={`px-2 py-1 text-sm rounded-r-md transition-colors ${
                        direction === 'LR'
                          ? 'bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-slate-100'
                          : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                      }`}
                      title="Horizontal layout"
                    >
                      <ArrowRight className="h-4 w-4" />
                    </button>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleRefresh}
                    disabled={loading}
                  >
                    <RefreshCw
                      className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`}
                    />
                  </Button>
                </div>
              }
              footer={
                <div className="text-sm text-slate-600 dark:text-slate-400">
                  <p>
                    Showing {engineeringCount} engineering, {manufacturingCount}{' '}
                    manufacturing, {physicalCount} physical, {requirementsCount}{' '}
                    requirement, and {validationCount} test items. Dashed lines
                    indicate cross-domain links.
                  </p>
                  <p className="mt-1 text-xs">
                    Use mouse wheel to zoom, drag to pan. Click item numbers to
                    navigate. Use the +/− buttons on a node to expand or
                    collapse its neighbors.
                  </p>
                </div>
              }
            >
              <div className="h-full border rounded-lg bg-slate-50 dark:bg-slate-950">
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  nodeTypes={nodeTypes}
                  colorMode={theme}
                  fitView
                  attributionPosition="bottom-right"
                  minZoom={0.1}
                  maxZoom={2}
                >
                  <Background gap={16} />
                  <Controls />
                </ReactFlow>
              </div>
            </FullscreenGraphWrapper>
          )}
        </CardContent>
      )}

      {/* Thread Comparison Dialog */}
      {focalDesignId && (
        <ThreadComparisonDialog
          open={comparisonDialogOpen}
          onOpenChange={setComparisonDialogOpen}
          itemId={itemId}
          itemNumber={focalItemNumber}
          itemName={focalItemName}
          designId={focalDesignId}
        />
      )}
    </Card>
  )
}
