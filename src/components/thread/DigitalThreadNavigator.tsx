import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  GitCompare,
  RefreshCw,
  Wrench,
} from 'lucide-react'
import { ThreadNode } from './ThreadNode'
import { ThreadComparisonDialog } from './ThreadComparisonDialog'
import { swimLaneLayout } from './swimLaneLayout'

import type { Edge, Node } from '@xyflow/react'
import type { ThreadResponse } from '@/lib/services/ThreadService'
import { Card, CardContent, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { FullscreenGraphWrapper } from '@/components/ui/FullscreenGraphWrapper'

interface DigitalThreadNavigatorProps {
  itemId: string
  itemNumber?: string
  itemName?: string | null
  designId?: string
  defaultExpanded?: boolean
}

export function DigitalThreadNavigator({
  itemId,
  itemNumber = '',
  itemName = null,
  designId = '',
  defaultExpanded = false,
}: DigitalThreadNavigatorProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  const [upstreamDepth, setUpstreamDepth] = useState(3)
  const [downstreamDepth, setDownstreamDepth] = useState(3)
  const [bomDepth, setBomDepth] = useState(2)
  const [direction, setDirection] = useState<'TB' | 'LR'>('TB')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [stats, setStats] = useState<ThreadResponse['stats'] | null>(null)
  const [comparisonDialogOpen, setComparisonDialogOpen] = useState(false)
  const [focalItemNumber, setFocalItemNumber] = useState(itemNumber)
  const [focalItemName, setFocalItemName] = useState(itemName)
  const [focalDesignId, setFocalDesignId] = useState(designId)
  const cachedThreadData = useRef<ThreadResponse | null>(null)
  const directionRef = useRef(direction)
  directionRef.current = direction

  const nodeTypes = useMemo(() => ({ threadNode: ThreadNode }), [])

  const applyLayout = useCallback(
    (data: ThreadResponse, rankdir: 'TB' | 'LR') => {
      const allNodes = [
        ...data.domains.engineering,
        ...data.domains.manufacturing,
      ]
      const { nodes: layoutedNodes, edges: layoutedEdges } = swimLaneLayout(
        allNodes,
        data.relationships,
        { rankdir },
      )
      setNodes(layoutedNodes)
      setEdges(layoutedEdges)
    },
    [setNodes, setEdges],
  )

  const loadThreadData = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams({
        upstreamDepth: upstreamDepth.toString(),
        downstreamDepth: downstreamDepth.toString(),
        bomDepth: bomDepth.toString(),
        domains: 'engineering,manufacturing',
      })

      const response = await fetch(`/api/thread/${itemId}?${params}`)

      if (!response.ok) {
        throw new Error('Failed to load digital thread data')
      }

      const { data } = (await response.json()) as { data: ThreadResponse }

      setFocalItemNumber(data.focalItem.itemNumber)
      setFocalItemName(data.focalItem.name)
      setFocalDesignId(data.focalItem.designId)

      cachedThreadData.current = data
      applyLayout(data, directionRef.current)
      setStats(data.stats)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [itemId, upstreamDepth, downstreamDepth, bomDepth, applyLayout])

  useEffect(() => {
    if (isExpanded) {
      loadThreadData()
    }
  }, [isExpanded, loadThreadData])

  const handleRefresh = () => {
    loadThreadData()
  }

  const handleToggleDirection = useCallback(() => {
    const newDir = direction === 'TB' ? 'LR' : 'TB'
    setDirection(newDir)
    if (cachedThreadData.current) {
      applyLayout(cachedThreadData.current, newDir)
    }
  }, [direction, applyLayout])

  // Count nodes by domain
  const engineeringCount = nodes.filter(
    (n) => n.data.domain === 'engineering',
  ).length
  const manufacturingCount = nodes.filter(
    (n) => n.data.domain === 'manufacturing',
  ).length

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
          <div className="flex items-center gap-6 mb-4 pb-4 border-b border-slate-300 dark:border-slate-700">
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
            {stats && stats.mbomCoverage > 0 && (
              <div className="ml-auto text-sm text-slate-500">
                MBOM Coverage: {stats.mbomCoverage}%
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
              Error: {error}
            </div>
          )}

          {!loading && !error && nodes.length === 0 && (
            <div className="text-center py-8 text-slate-500">
              No thread relationships found. This item is not linked to any
              Engineering or Manufacturing designs.
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
                    Showing {engineeringCount} engineering and{' '}
                    {manufacturingCount} manufacturing items. Dashed lines
                    indicate cross-domain links.
                  </p>
                  <p className="mt-1 text-xs">
                    Use mouse wheel to zoom, drag to pan. Click item numbers to
                    navigate.
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
                  fitView
                  attributionPosition="bottom-right"
                  minZoom={0.1}
                  maxZoom={2}
                >
                  <Background color="#aaa" gap={16} />
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
