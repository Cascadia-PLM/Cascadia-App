import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import dagre from 'dagre'
import { LayoutGrid, Loader2, Plus, Save } from 'lucide-react'
import { InstanceStatePropertiesPanel } from './InstanceStatePropertiesPanel'
import { InstanceTransitionPropertiesPanel } from './InstanceTransitionPropertiesPanel'
import type { Connection, Edge, Node, OnConnect } from '@xyflow/react'
import type { StateNodeType } from '@/components/workflows/StateNode'
import type { TransitionEdgeType } from '@/components/workflows/TransitionEdge'
import type {
  InstanceWorkflowState,
  InstanceWorkflowTransition,
  WorkflowState,
} from '@/lib/workflows/types'
import { StateNode } from '@/components/workflows/StateNode'
import { TransitionEdge } from '@/components/workflows/TransitionEdge'
import { Button } from '@/components/ui/Button'

interface WorkflowInstanceEditorProps {
  changeOrderId: string
  instanceId: string
  states: Array<WorkflowState>
  transitions: Array<InstanceWorkflowTransition>
  currentState: string
  canEdit: boolean
  onStructureChange?: () => void
}

const nodeTypes = {
  stateNode: StateNode,
}

const edgeTypes = {
  transitionEdge: TransitionEdge,
}

// Dagre layout for auto-arranging nodes
function getLayoutedElements(
  nodes: Array<Node>,
  edges: Array<Edge>,
  direction: 'TB' | 'LR' = 'TB',
): { nodes: Array<Node>; edges: Array<Edge> } {
  const dagreGraph = new dagre.graphlib.Graph()
  dagreGraph.setDefaultEdgeLabel(() => ({}))

  const nodeWidth = 180
  const nodeHeight = 80

  dagreGraph.setGraph({
    rankdir: direction,
    ranksep: 100,
    nodesep: 50,
    marginx: 20,
    marginy: 20,
  })

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight })
  })

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target)
  })

  dagre.layout(dagreGraph)

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id)
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - nodeWidth / 2,
        y: nodeWithPosition.y - nodeHeight / 2,
      },
    }
  })

  return { nodes: layoutedNodes, edges }
}

// Inner component that uses useReactFlow
function WorkflowInstanceEditorInner({
  changeOrderId,
  states,
  transitions,
  currentState,
  canEdit,
  onStructureChange,
}: WorkflowInstanceEditorProps) {
  const { screenToFlowPosition } = useReactFlow()

  // Convert states/transitions to React Flow nodes/edges
  const initialNodes = useMemo(() => {
    return states.map((state) => ({
      id: state.id,
      type: 'stateNode',
      position: state.position || { x: 0, y: 0 },
      data: {
        state,
        isCurrent: state.id === currentState,
      },
    })) as Array<StateNodeType>
  }, [])

  const initialEdges = useMemo(() => {
    return transitions.map((transition) => ({
      id: transition.id,
      source: transition.fromStateId,
      target: transition.toStateId,
      type: 'transitionEdge',
      markerEnd: { type: MarkerType.ArrowClosed },
      data: {
        transition,
        definitionType: 'workflow' as const,
        readOnly: !canEdit,
      },
    })) as Array<TransitionEdgeType>
  }, [])

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)
  const [selectedState, setSelectedState] =
    useState<InstanceWorkflowState | null>(null)
  const [selectedTransition, setSelectedTransition] =
    useState<InstanceWorkflowTransition | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isInitialRender = useRef(true)

  // Track changes
  useEffect(() => {
    if (isInitialRender.current) {
      isInitialRender.current = false
      return
    }
    setHasChanges(true)
  }, [nodes, edges])

  // Update node data to show current state highlighting
  useEffect(() => {
    setNodes((nds) =>
      nds.map((node) => ({
        ...node,
        data: {
          ...node.data,
          isCurrent: node.id === currentState,
        },
      })),
    )
  }, [currentState, setNodes])

  // Handle node selection
  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const state = nodes.find((n) => n.id === node.id)?.data
        .state as InstanceWorkflowState
      setSelectedState(state)
      setSelectedTransition(null)
    },
    [nodes],
  )

  // Handle edge selection
  const handleEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      const transition = edges.find((e) => e.id === edge.id)?.data
        ?.transition as InstanceWorkflowTransition
      setSelectedTransition(transition)
      setSelectedState(null)
    },
    [edges],
  )

  // Handle pane click to deselect
  const handlePaneClick = useCallback(() => {
    setSelectedState(null)
    setSelectedTransition(null)
  }, [])

  // Handle connecting nodes (creating transitions)
  const onConnect: OnConnect = useCallback(
    (params: Connection) => {
      if (!canEdit) return

      const newTransition: InstanceWorkflowTransition = {
        id: `transition-${Date.now()}`,
        name: 'New Transition',
        fromStateId: params.source,
        toStateId: params.target,
      }

      setEdges((eds) =>
        addEdge(
          {
            ...params,
            id: newTransition.id,
            type: 'transitionEdge',
            markerEnd: { type: MarkerType.ArrowClosed },
            data: {
              transition: newTransition,
              definitionType: 'workflow',
              readOnly: false,
            },
          },
          eds,
        ),
      )
    },
    [canEdit, setEdges],
  )

  // Add new state
  const addState = useCallback(() => {
    if (!canEdit) return

    const newState: InstanceWorkflowState = {
      id: `state-${Date.now()}`,
      name: 'New State',
      color: 'blue',
      isInitial: false,
      isFinal: false,
      position: { x: 250, y: 150 },
    }

    setNodes((nds) => [
      ...nds,
      {
        id: newState.id,
        type: 'stateNode',
        position: newState.position!,
        data: { state: newState, isCurrent: false },
      } as StateNodeType,
    ])
  }, [canEdit, setNodes])

  // Update state
  const updateState = useCallback(
    (updatedState: InstanceWorkflowState) => {
      setNodes((nds) =>
        nds.map((node) =>
          node.id === updatedState.id
            ? {
                ...node,
                data: {
                  ...node.data,
                  state: updatedState,
                },
              }
            : node,
        ),
      )
      setSelectedState(updatedState)
    },
    [setNodes],
  )

  // Delete state
  const deleteState = useCallback(
    (stateId: string) => {
      if (!canEdit || stateId === currentState) return

      setNodes((nds) => nds.filter((node) => node.id !== stateId))
      setEdges((eds) =>
        eds.filter(
          (edge) => edge.source !== stateId && edge.target !== stateId,
        ),
      )
      setSelectedState(null)
    },
    [canEdit, currentState, setNodes, setEdges],
  )

  // Update transition
  const updateTransition = useCallback(
    (updatedTransition: InstanceWorkflowTransition) => {
      setEdges((eds) =>
        eds.map((edge) =>
          edge.id === updatedTransition.id
            ? {
                ...edge,
                data: {
                  ...edge.data,
                  transition: updatedTransition,
                },
              }
            : edge,
        ),
      )
      setSelectedTransition(updatedTransition)
    },
    [setEdges],
  )

  // Delete transition
  const deleteTransition = useCallback(
    (transitionId: string) => {
      if (!canEdit) return

      setEdges((eds) => eds.filter((edge) => edge.id !== transitionId))
      setSelectedTransition(null)
    },
    [canEdit, setEdges],
  )

  // Auto layout
  const autoLayout = useCallback(() => {
    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
      nodes,
      edges,
    )
    setNodes(layoutedNodes as Array<StateNodeType>)
    setEdges(layoutedEdges as Array<TransitionEdgeType>)
  }, [nodes, edges, setNodes, setEdges])

  // Save changes
  const handleSave = useCallback(async () => {
    setIsSaving(true)
    setError(null)

    try {
      // Extract states with positions from nodes
      const updatedStates: Array<WorkflowState> = nodes.map((node) => ({
        ...node.data.state,
        position: node.position,
      }))

      // Extract transitions from edges
      const updatedTransitions: Array<InstanceWorkflowTransition> = edges.map(
        (edge) => ({
          ...edge.data?.transition,
          fromStateId: edge.source,
          toStateId: edge.target,
        }),
      )

      const response = await fetch(
        `/api/change-orders/${changeOrderId}/workflow/structure`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            states: updatedStates,
            transitions: updatedTransitions,
          }),
        },
      )

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to save')
      }

      setHasChanges(false)
      onStructureChange?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setIsSaving(false)
    }
  }, [nodes, edges, changeOrderId, onStructureChange])

  // Update node/edge data with callbacks
  const nodesWithCallbacks = useMemo(() => {
    return nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        onEdit: canEdit
          ? (state: WorkflowState) =>
              setSelectedState(state as InstanceWorkflowState)
          : undefined,
        onDelete:
          canEdit && node.id !== currentState
            ? (stateId: string) => deleteState(stateId)
            : undefined,
      },
    }))
  }, [nodes, canEdit, currentState, deleteState])

  const edgesWithCallbacks = useMemo(() => {
    return edges.map((edge) => ({
      ...edge,
      data: {
        ...edge.data,
        onEdit: canEdit
          ? (transition: InstanceWorkflowTransition) =>
              setSelectedTransition(transition)
          : undefined,
        onDelete: canEdit
          ? (transitionId: string) => deleteTransition(transitionId)
          : undefined,
      },
    }))
  }, [edges, canEdit, deleteTransition])

  return (
    <div className="h-full w-full relative">
      <ReactFlow
        nodes={nodesWithCallbacks}
        edges={edgesWithCallbacks}
        onNodesChange={canEdit ? onNodesChange : undefined}
        onEdgesChange={canEdit ? (onEdgesChange as any) : undefined}
        onConnect={canEdit ? onConnect : undefined}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        onPaneClick={handlePaneClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        minZoom={0.5}
        maxZoom={2}
        defaultEdgeOptions={{
          type: 'transitionEdge',
          markerEnd: { type: MarkerType.ArrowClosed },
        }}
      >
        <Background />
        <Controls />
        <MiniMap />

        {/* Toolbar */}
        <Panel position="top-left" className="flex gap-2">
          {canEdit && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addState}
              >
                <Plus className="h-4 w-4 mr-1" />
                Add State
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={autoLayout}
              >
                <LayoutGrid className="h-4 w-4 mr-1" />
                Auto Layout
              </Button>
            </>
          )}
        </Panel>

        {/* Save button */}
        <Panel position="top-right" className="flex flex-col gap-2">
          {canEdit && hasChanges && (
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={handleSave}
              disabled={isSaving}
            >
              {isSaving ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-1" />
              )}
              Save Changes
            </Button>
          )}
          {error && (
            <div className="max-w-xs p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md dark:bg-red-900/20 dark:text-red-400 dark:border-red-800">
              {error}
            </div>
          )}
        </Panel>
      </ReactFlow>

      {/* Properties panels */}
      {selectedState && (
        <div className="absolute top-4 right-4 z-10">
          <InstanceStatePropertiesPanel
            state={selectedState}
            isCurrent={selectedState.id === currentState}
            onUpdate={updateState}
            onClose={() => setSelectedState(null)}
            readOnly={!canEdit}
          />
        </div>
      )}

      {selectedTransition && (
        <div className="absolute top-4 right-4 z-10">
          <InstanceTransitionPropertiesPanel
            transition={selectedTransition}
            onUpdate={updateTransition}
            onDelete={deleteTransition}
            onClose={() => setSelectedTransition(null)}
            readOnly={!canEdit}
          />
        </div>
      )}
    </div>
  )
}

// Main component with provider
export function WorkflowInstanceEditor(props: WorkflowInstanceEditorProps) {
  return (
    <ReactFlowProvider>
      <WorkflowInstanceEditorInner {...props} />
    </ReactFlowProvider>
  )
}
