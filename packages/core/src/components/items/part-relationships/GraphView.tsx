// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Background, Controls, ReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { GitBranch, RefreshCw } from 'lucide-react'
import type { DirectionMode } from './types'
import type { useRelationshipGraph } from './useRelationshipGraph'
import { EdgeDirectionLegend } from '@/components/graph/EdgeDirectionLegend'
import {
  Button,
  Card,
  CardContent,
  FullscreenGraphWrapper,
} from '@/components/ui'

/**
 * The relationship graph tab: filters, then a React Flow canvas.
 *
 * Pure rendering. Every piece of state it reads is owned by
 * `useRelationshipGraph`, called from the panel — see that file for why the
 * expansion caches cannot live here.
 */
export function GraphView({
  graph,
  theme,
}: {
  graph: ReturnType<typeof useRelationshipGraph>
  theme: 'light' | 'dark'
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        {/* Graph Controls */}
        <div className="flex items-center justify-between mb-4 pb-4 border-b border-slate-300 dark:border-slate-700">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <label className="text-sm text-slate-600 dark:text-slate-400">
                Mode:
              </label>
              <select
                value={graph.direction}
                onChange={(e) =>
                  graph.setDirection(e.target.value as DirectionMode)
                }
                disabled={graph.loading}
                className="text-sm rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              >
                <option value="all">All relationships</option>
                <option value="outgoing">Uses (outgoing)</option>
                <option value="incoming">Where-used (incoming)</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm text-slate-600 dark:text-slate-400">
                Depth:
              </label>
              <select
                value={graph.depth}
                onChange={(e) => graph.setDepth(parseInt(e.target.value, 10))}
                disabled={graph.loading}
                className="text-sm rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              >
                <option value={0}>This item only</option>
                <option value={1}>1 level</option>
                <option value={2}>2 levels</option>
                <option value={3}>3 levels</option>
                <option value={4}>4 levels</option>
                <option value={5}>5 levels</option>
              </select>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => graph.refetch()}
            disabled={graph.loading}
          >
            <RefreshCw
              className={`h-4 w-4 ${graph.loading ? 'animate-spin' : ''}`}
            />
          </Button>
        </div>

        {/* Relationship Type Filter */}
        {graph.availableTypes.length > 0 && (
          <div className="mb-4 pb-4 border-b border-slate-300 dark:border-slate-700">
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Relationship Types:
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => graph.clearTypes()}
                  disabled={graph.loading || graph.selectedTypes.length === 0}
                  className="text-xs text-cyan-600 hover:text-cyan-700 dark:text-cyan-400 dark:hover:text-cyan-300 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  All
                </button>
                <span className="text-xs text-slate-400">|</span>
                <button
                  type="button"
                  onClick={graph.selectAllTypes}
                  disabled={
                    graph.loading ||
                    graph.selectedTypes.length === graph.availableTypes.length
                  }
                  className="text-xs text-cyan-600 hover:text-cyan-700 dark:text-cyan-400 dark:hover:text-cyan-300 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  None
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {graph.availableTypes.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => graph.toggleType(type)}
                  disabled={graph.loading}
                  className={`
                    px-3 py-1 text-xs rounded-full border transition-colors
                    ${
                      graph.selectedTypes.length === 0 ||
                      graph.selectedTypes.includes(type)
                        ? 'bg-cyan-100 dark:bg-cyan-900 border-cyan-500 text-cyan-700 dark:text-cyan-300'
                        : 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-600 text-slate-500 dark:text-slate-400'
                    }
                    ${graph.loading ? 'opacity-50 cursor-not-allowed' : 'hover:border-cyan-600 cursor-pointer'}
                  `}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Graph Display */}
        {graph.error ? (
          <div className="text-center py-8">
            <p className="text-red-500 dark:text-red-400">{graph.error}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => graph.refetch()}
            >
              <RefreshCw className="h-4 w-4 mr-1" />
              Retry
            </Button>
          </div>
        ) : graph.loading && graph.nodes.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-slate-500">
            <RefreshCw className="h-6 w-6 animate-spin mr-2" />
            Loading graph...
          </div>
        ) : graph.nodes.length === 0 ? (
          <div className="text-center py-8">
            <GitBranch className="h-12 w-12 mx-auto mb-4 opacity-50 text-slate-400" />
            <p className="text-slate-500 dark:text-slate-400">
              No relationships found
            </p>
          </div>
        ) : (
          <FullscreenGraphWrapper
            title="Relationship Graph"
            subtitle={`${graph.nodes.length} item${graph.nodes.length !== 1 ? 's' : ''}, ${graph.edges.length} relationship${graph.edges.length !== 1 ? 's' : ''}`}
            inlineHeight="500px"
            headerControls={
              <Button
                variant="outline"
                size="sm"
                onClick={() => graph.refetch()}
                disabled={graph.loading}
              >
                <RefreshCw
                  className={`h-4 w-4 ${graph.loading ? 'animate-spin' : ''}`}
                />
              </Button>
            }
            footer={
              <div className="text-sm text-slate-600 dark:text-slate-400">
                <p>
                  Showing {graph.nodes.length} item
                  {graph.nodes.length !== 1 ? 's' : ''} and {graph.edges.length}{' '}
                  relationship
                  {graph.edges.length !== 1 ? 's' : ''}
                </p>
                <div className="mt-2">
                  <EdgeDirectionLegend example="a Part that Satisfies a Requirement points at the Requirement" />
                </div>
                <p className="mt-1 text-xs">
                  Use mouse wheel to zoom, drag to pan. Click item numbers to
                  navigate. Click +/- buttons to expand or collapse neighbors —
                  attached files appear below their item when it is expanded
                  downstream. Drag edge labels to reposition, double-click to
                  reset.
                </p>
              </div>
            }
          >
            <div className="h-full border rounded-lg bg-slate-50 dark:bg-slate-950">
              <ReactFlow
                nodes={graph.nodes}
                edges={graph.edges}
                onNodesChange={graph.onNodesChange}
                onEdgesChange={graph.onEdgesChange}
                nodeTypes={graph.nodeTypes}
                edgeTypes={graph.edgeTypes}
                onInit={(instance) => {
                  graph.reactFlowRef.current = instance
                }}
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
    </Card>
  )
}
