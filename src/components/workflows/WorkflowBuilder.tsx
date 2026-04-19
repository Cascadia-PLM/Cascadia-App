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
import { Layers, LayoutGrid, Plus, Save } from 'lucide-react'
import { StateNode } from './StateNode'
import { TransitionEdge } from './TransitionEdge'
import { PhaseGroupNode } from './PhaseGroupNode'
import { StatePropertiesPanel } from './StatePropertiesPanel'
import { TransitionPropertiesPanel } from './TransitionPropertiesPanel'
import { PhasePropertiesPanel } from './PhasePropertiesPanel'
import type { TransitionEdgeType } from './TransitionEdge'
import type { PhaseGroupNodeType } from './PhaseGroupNode'
import type {
  Connection,
  Edge,
  Node,
  OnConnect,
  OnConnectEnd,
  OnConnectStart,
} from '@xyflow/react'
import type { StateNodeType } from './StateNode'
import type {
  DefinitionType,
  WorkflowDefinition,
  WorkflowState,
  WorkflowTransition,
} from '@/lib/workflows/types'
import type { LifecyclePhaseConfig } from '@/lib/types/lifecycle'
import { Button } from '@/components/ui/Button'

interface WorkflowBuilderProps {
  definition?: Partial<WorkflowDefinition>
  definitionType: DefinitionType
  /** Lifecycle type for determining available actions (e.g., TransitionDrivenItem for Driving) */
  lifecycleType?: 'Free' | 'Driven' | 'Driving'
  onChange: (definition: Partial<WorkflowDefinition>) => void
  onSave?: () => void
  readOnly?: boolean
  /** Disable transitions (for Driven lifecycles that only define states) */
  disableTransitions?: boolean
}

const nodeTypes = {
  stateNode: StateNode,
  phaseGroup: PhaseGroupNode,
}

const edgeTypes = {
  transitionEdge: TransitionEdge,
}

// Dagre layout for auto-arranging nodes with phase grouping
function getLayoutedElements(
  nodes: Array<Node>,
  edges: Array<Edge>,
  phases?: Array<LifecyclePhaseConfig>,
  direction: 'TB' | 'LR' = 'TB',
): { nodes: Array<Node>; edges: Array<Edge> } {
  // Filter to only state nodes for layout
  const stateNodes = nodes.filter((n) => n.type === 'stateNode')

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

  stateNodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight })
  })

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target)
  })

  dagre.layout(dagreGraph)

  // Apply positions from dagre
  const layoutedStateNodes = stateNodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id)
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - nodeWidth / 2,
        y: nodeWithPosition.y - nodeHeight / 2,
      },
    }
  })

  // If no phases, return just state nodes
  if (!phases || phases.length === 0) {
    return { nodes: layoutedStateNodes, edges }
  }

  // Group state nodes by phaseId
  const phaseMembers = new Map<string, Array<Node>>()
  const unassigned: Array<Node> = []

  for (const node of layoutedStateNodes) {
    const state = (node.data as { state: WorkflowState }).state
    if (state.phaseId && phases.some((p) => p.id === state.phaseId)) {
      const members = phaseMembers.get(state.phaseId) || []
      members.push(node)
      phaseMembers.set(state.phaseId, members)
    } else {
      unassigned.push(node)
    }
  }

  // Build phase group nodes and adjust member positions to be relative
  const PADDING_TOP = 40 // space for header
  const PADDING_SIDE = 20
  const PADDING_BOTTOM = 20

  const phaseGroupNodes: Array<PhaseGroupNodeType> = []
  const adjustedStateNodes: Array<Node> = [...unassigned]

  for (const phase of phases) {
    const members = phaseMembers.get(phase.id)
    if (!members || members.length === 0) {
      // Create empty phase group with default size
      phaseGroupNodes.push({
        id: `phase-${phase.id}`,
        type: 'phaseGroup',
        position: {
          x: phaseGroupNodes.length * 280,
          y: 0,
        },
        data: { phase },
        style: { width: 240, height: 160 },
        connectable: false,
      } as PhaseGroupNodeType)
      continue
    }

    // Compute bounding box of members
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity

    for (const m of members) {
      minX = Math.min(minX, m.position.x)
      minY = Math.min(minY, m.position.y)
      maxX = Math.max(maxX, m.position.x + nodeWidth)
      maxY = Math.max(maxY, m.position.y + nodeHeight)
    }

    const groupX = minX - PADDING_SIDE
    const groupY = minY - PADDING_TOP
    const groupW = maxX - minX + PADDING_SIDE * 2
    const groupH = maxY - minY + PADDING_TOP + PADDING_BOTTOM

    phaseGroupNodes.push({
      id: `phase-${phase.id}`,
      type: 'phaseGroup',
      position: { x: groupX, y: groupY },
      data: { phase },
      style: { width: groupW, height: groupH },
      connectable: false,
    } as PhaseGroupNodeType)

    // Adjust member positions to be relative to group
    for (const m of members) {
      adjustedStateNodes.push({
        ...m,
        parentId: `phase-${phase.id}`,
        extent: 'parent' as const,
        expandParent: true,
        position: {
          x: m.position.x - groupX,
          y: m.position.y - groupY,
        },
      })
    }
  }

  // Phase groups must come before their children in the array
  return { nodes: [...phaseGroupNodes, ...adjustedStateNodes], edges }
}

// Inner component that uses useReactFlow (must be inside ReactFlowProvider)
function WorkflowBuilderInner({
  definition,
  definitionType,
  lifecycleType,
  onChange,
  onSave,
  readOnly = false,
  disableTransitions = false,
}: WorkflowBuilderProps) {
  const { screenToFlowPosition } = useReactFlow()

  type BuilderNode = StateNodeType | PhaseGroupNodeType

  // Convert workflow states/transitions to React Flow nodes/edges
  const initialNodes = useMemo(() => {
    return (definition?.states || []).map((state) => ({
      id: state.id,
      type: 'stateNode' as const,
      position: state.position || { x: 0, y: 0 },
      data: { state },
    })) as Array<BuilderNode>
  }, [])

  const initialEdges = useMemo(() => {
    return (definition?.transitions || []).map((transition) => ({
      id: transition.id,
      source: transition.fromStateId,
      target: transition.toStateId,
      type: 'transitionEdge',
      markerEnd: { type: MarkerType.ArrowClosed },
      data: { transition, definitionType },
    })) as Array<TransitionEdgeType>
  }, [])

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)
  const [selectedState, setSelectedState] = useState<WorkflowState | null>(null)
  const [selectedTransition, setSelectedTransition] =
    useState<WorkflowTransition | null>(null)
  const [selectedPhase, setSelectedPhase] =
    useState<LifecyclePhaseConfig | null>(null)

  // Track connection drag for creating new states
  const connectingNodeId = useRef<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    flowX: number
    flowY: number
  } | null>(null)

  // Track if this is the initial render to avoid marking as "changed" on load
  const isInitialRender = useRef(true)

  // Update parent when nodes/edges change
  useEffect(() => {
    // Skip the initial render to avoid false "unsaved changes" on load
    if (isInitialRender.current) {
      isInitialRender.current = false
      return
    }

    const states: Array<WorkflowState> = nodes
      .filter((node) => (node.type as string) === 'stateNode')
      .map((node) => ({
        ...(node.data as StateNodeType['data']).state,
        position: node.position,
      }))

    const transitions: Array<WorkflowTransition> = edges.map((edge) => {
      const transition = edge.data?.transition
      return {
        ...transition,
        id: edge.id,
        name: transition?.name ?? 'Transition',
        fromStateId: edge.source,
        toStateId: edge.target,
        guards: transition?.guards ?? [],
        actions: transition?.actions ?? [],
      }
    })

    onChange({
      ...definition,
      states,
      transitions,
    })
  }, [nodes, edges])

  // Handle node selection
  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (readOnly) return
      setSelectedTransition(null)

      if ((node.type as string) === 'phaseGroup') {
        setSelectedState(null)
        const nodeData = node.data as PhaseGroupNodeType['data']
        setSelectedPhase(nodeData.phase)
      } else {
        setSelectedPhase(null)
        const nodeData = node.data as StateNodeType['data']
        setSelectedState(nodeData.state)
      }
    },
    [readOnly],
  )

  // Handle edge selection
  const onEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      if (readOnly) return
      setSelectedState(null)
      const edgeData = edge.data as
        | { transition?: WorkflowTransition }
        | undefined
      setSelectedTransition(edgeData?.transition ?? null)
    },
    [readOnly],
  )

  // Handle background click to deselect
  const onPaneClick = useCallback(() => {
    setSelectedState(null)
    setSelectedTransition(null)
    setSelectedPhase(null)
  }, [])

  // Handle new connections
  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (readOnly || disableTransitions) return
      if (!connection.source || !connection.target) return

      const newTransition: WorkflowTransition = {
        id: `transition-${Date.now()}`,
        name: 'New Transition',
        fromStateId: connection.source,
        toStateId: connection.target,
        guards: [],
        actions: [],
      }

      const newEdge: TransitionEdgeType = {
        id: newTransition.id,
        source: connection.source,
        target: connection.target,
        type: 'transitionEdge',
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { transition: newTransition, definitionType },
      }

      setEdges((eds) => addEdge(newEdge, eds))
    },
    [readOnly, definitionType, setEdges],
  )

  // Track when connection drag starts
  const onConnectStart: OnConnectStart = useCallback((_, { nodeId }) => {
    connectingNodeId.current = nodeId
  }, [])

  // Handle when connection drag ends (possibly without connecting)
  const onConnectEnd: OnConnectEnd = useCallback(
    (event) => {
      if (readOnly || disableTransitions || !connectingNodeId.current) return

      // Check if we dropped on the pane (not on a node)
      const targetIsPane = (event.target as HTMLElement).classList.contains(
        'react-flow__pane',
      )

      if (targetIsPane && event instanceof MouseEvent) {
        // Show context menu at drop position
        const flowPosition = screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        })
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          flowX: flowPosition.x,
          flowY: flowPosition.y,
        })
      }
    },
    [readOnly, screenToFlowPosition],
  )

  // Create a new state at position and connect from the dragged node
  const createStateAtPosition = useCallback(
    (flowX: number, flowY: number) => {
      if (!connectingNodeId.current) return

      const newState: WorkflowState = {
        id: `state-${Date.now()}`,
        name: 'New State',
        color: 'gray',
        isInitial: false,
        isFinal: false,
      }

      const newNode: StateNodeType = {
        id: newState.id,
        type: 'stateNode',
        position: { x: flowX - 90, y: flowY - 40 }, // Center the node on cursor
        data: { state: newState },
      }

      // Create transition from source node to new node
      const newTransition: WorkflowTransition = {
        id: `transition-${Date.now()}`,
        name: 'New Transition',
        fromStateId: connectingNodeId.current,
        toStateId: newState.id,
        guards: [],
        actions: [],
      }

      const newEdge: TransitionEdgeType = {
        id: newTransition.id,
        source: connectingNodeId.current,
        target: newState.id,
        type: 'transitionEdge',
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { transition: newTransition, definitionType },
      }

      setNodes((nds) => [...nds, newNode])
      setEdges((eds) => [...eds, newEdge])
      setContextMenu(null)
      connectingNodeId.current = null

      // Select the new state for editing
      setSelectedState(newState)
    },
    [definitionType, setNodes, setEdges],
  )

  // Close context menu
  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
    connectingNodeId.current = null
  }, [])

  // Add a new state
  const addState = useCallback(() => {
    const newState: WorkflowState = {
      id: `state-${Date.now()}`,
      name: 'New State',
      color: 'gray',
      isInitial: nodes.length === 0,
      isFinal: false,
    }

    const newNode: StateNodeType = {
      id: newState.id,
      type: 'stateNode',
      position: { x: 100 + nodes.length * 50, y: 100 + nodes.length * 30 },
      data: { state: newState },
    }

    setNodes((nds) => [...nds, newNode])
  }, [nodes.length, setNodes])

  // Update a state
  const updateState = useCallback(
    (updatedState: WorkflowState) => {
      setNodes((nds) =>
        nds.map(
          (node): BuilderNode =>
            node.id === updatedState.id
              ? ({
                  ...node,
                  data: { ...node.data, state: updatedState },
                } as StateNodeType)
              : node,
        ),
      )
      // Keep panel open - update selectedState with new data
      setSelectedState(updatedState)
    },
    [setNodes],
  )

  // Delete a state
  const deleteState = useCallback(
    (stateId: string) => {
      // Remove the node
      setNodes((nds) => nds.filter((node) => node.id !== stateId))
      // Remove any connected edges
      setEdges((eds) =>
        eds.filter(
          (edge) => edge.source !== stateId && edge.target !== stateId,
        ),
      )
      setSelectedState(null)
    },
    [setNodes, setEdges],
  )

  // Update a transition
  const updateTransition = useCallback(
    (updatedTransition: WorkflowTransition) => {
      setEdges((eds) =>
        eds.map((edge) =>
          edge.id === updatedTransition.id
            ? {
                ...edge,
                data: { ...edge.data, transition: updatedTransition },
              }
            : edge,
        ),
      )
      // Keep panel open - update selectedTransition with new data
      setSelectedTransition(updatedTransition)
    },
    [setEdges],
  )

  // Delete a transition
  const deleteTransition = useCallback(
    (transitionId: string) => {
      setEdges((eds) => eds.filter((edge) => edge.id !== transitionId))
      setSelectedTransition(null)
    },
    [setEdges],
  )

  // Update a transition's label position (for draggable waypoints)
  const updateLabelPosition = useCallback(
    (transitionId: string, position: { x: number; y: number } | undefined) => {
      setEdges((eds) =>
        eds.map((edge): TransitionEdgeType => {
          if (edge.id !== transitionId) return edge

          const currentTransition = edge.data?.transition
          const updatedTransition: WorkflowTransition = {
            ...currentTransition,
            id: currentTransition?.id ?? edge.id,
            name: currentTransition?.name ?? 'Transition',
            fromStateId: currentTransition?.fromStateId ?? edge.source,
            toStateId: currentTransition?.toStateId ?? edge.target,
            guards: currentTransition?.guards ?? [],
            actions: currentTransition?.actions ?? [],
            labelPosition: position,
          }

          return {
            ...edge,
            data: { ...edge.data, transition: updatedTransition },
          } as TransitionEdgeType
        }),
      )
    },
    [setEdges],
  )

  // Auto-layout (also resets custom label positions)
  const autoLayout = useCallback(() => {
    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
      nodes,
      edges,
      definition?.phases,
    )
    setNodes(layoutedNodes as Array<StateNodeType>)
    // Reset custom label positions when auto-layout is applied
    setEdges(
      layoutedEdges.map((edge): TransitionEdgeType => {
        const transition = edge.data?.transition as
          | WorkflowTransition
          | undefined
        return {
          ...edge,
          data: {
            ...edge.data,
            transition: transition
              ? { ...transition, labelPosition: undefined }
              : undefined,
          },
        } as TransitionEdgeType
      }),
    )
  }, [nodes, edges, definition?.phases, setNodes, setEdges])

  // Add a new phase
  const addPhase = useCallback(() => {
    const phases = definition?.phases ?? []
    const newPhase: LifecyclePhaseConfig = {
      id: `phase-${Date.now()}`,
      name: `Phase ${phases.length + 1}`,
      color: [
        'blue',
        'green',
        'purple',
        'orange',
        'cyan',
        'yellow',
        'red',
        'gray',
      ][phases.length % 8],
      order: phases.length,
    }
    onChange({
      ...definition,
      phases: [...phases, newPhase],
    })
  }, [definition, onChange])

  // Update a phase
  const updatePhase = useCallback(
    (updatedPhase: LifecyclePhaseConfig) => {
      const phases = (definition?.phases ?? []).map((p) =>
        p.id === updatedPhase.id ? updatedPhase : p,
      )
      onChange({ ...definition, phases })
      setSelectedPhase(updatedPhase)
    },
    [definition, onChange],
  )

  // Delete a phase (unassign member states)
  const deletePhase = useCallback(
    (phaseId: string) => {
      const phases = (definition?.phases ?? []).filter((p) => p.id !== phaseId)
      // Clear phaseId on all member states
      setNodes((nds) =>
        nds.map((node) => {
          if ((node.type as string) !== 'stateNode') return node
          const state = (node.data as StateNodeType['data']).state
          if (state.phaseId !== phaseId) return node
          return {
            ...node,
            parentId: undefined,
            extent: undefined,
            expandParent: undefined,
            data: {
              ...node.data,
              state: { ...state, phaseId: undefined },
            },
          } as BuilderNode
        }),
      )
      onChange({ ...definition, phases })
      setSelectedPhase(null)
    },
    [definition, onChange, setNodes],
  )

  // Add handlers to node data
  const nodesWithHandlers = useMemo(() => {
    return nodes.map((node): BuilderNode => {
      if ((node.type as string) === 'phaseGroup') {
        return {
          ...node,
          type: 'phaseGroup',
          data: {
            ...(node.data as PhaseGroupNodeType['data']),
            onEdit: readOnly
              ? undefined
              : (phase: LifecyclePhaseConfig) => setSelectedPhase(phase),
            onDelete: readOnly ? undefined : deletePhase,
          },
        } as PhaseGroupNodeType
      }
      return {
        ...node,
        type: 'stateNode',
        data: {
          ...(node.data as StateNodeType['data']),
          onEdit: readOnly
            ? undefined
            : (state: WorkflowState) => setSelectedState(state),
          onDelete: readOnly ? undefined : deleteState,
          hideHandles: disableTransitions,
        },
      } as StateNodeType
    })
  }, [nodes, readOnly, deleteState, deletePhase, disableTransitions])

  // Build a map of stateId → phaseId for cross-phase detection
  const statePhaseMap = useMemo(() => {
    const map = new Map<string, string | undefined>()
    for (const node of nodes) {
      if ((node.type as string) === 'stateNode') {
        const state = (node.data as StateNodeType['data']).state
        map.set(state.id, state.phaseId)
      }
    }
    return map
  }, [nodes])

  // Add handlers to edge data
  const edgesWithHandlers = useMemo((): Array<TransitionEdgeType> => {
    return edges.map((edge): TransitionEdgeType => {
      const existingData = edge.data as
        | { transition?: WorkflowTransition }
        | undefined
      const transition: WorkflowTransition = existingData?.transition ?? {
        id: edge.id,
        name: 'Transition',
        fromStateId: edge.source,
        toStateId: edge.target,
        guards: [],
        actions: [],
      }

      // Determine if this edge crosses a phase boundary
      const sourcePhaseId = statePhaseMap.get(edge.source)
      const targetPhaseId = statePhaseMap.get(edge.target)
      const isCrossPhase =
        !!sourcePhaseId && !!targetPhaseId && sourcePhaseId !== targetPhaseId

      return {
        ...edge,
        data: {
          ...existingData,
          transition,
          isCrossPhase,
          onEdit: readOnly
            ? undefined
            : (t: WorkflowTransition) => setSelectedTransition(t),
          onDelete: readOnly ? undefined : deleteTransition,
          onLabelPositionChange: readOnly ? undefined : updateLabelPosition,
          readOnly,
        },
      }
    })
  }, [edges, readOnly, deleteTransition, updateLabelPosition, statePhaseMap])

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={nodesWithHandlers}
        edges={edgesWithHandlers}
        onNodesChange={readOnly ? undefined : (onNodesChange as any)}
        onEdgesChange={readOnly ? undefined : (onEdgesChange as any)}
        onConnect={disableTransitions ? undefined : onConnect}
        onConnectStart={
          readOnly || disableTransitions ? undefined : onConnectStart
        }
        onConnectEnd={readOnly || disableTransitions ? undefined : onConnectEnd}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        attributionPosition="bottom-left"
        minZoom={0.25}
        maxZoom={2}
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        className="bg-slate-50 dark:bg-slate-950"
      >
        <Background color="#94a3b8" gap={20} />
        <Controls />
        <MiniMap
          nodeColor={(node) => {
            const nodeData = node.data as
              | { state?: { color?: string } }
              | undefined
            const color = nodeData?.state?.color || 'gray'
            const colorMap: Record<string, string> = {
              gray: '#94a3b8',
              blue: '#3b82f6',
              green: '#22c55e',
              yellow: '#eab308',
              orange: '#f97316',
              red: '#ef4444',
              purple: '#a855f7',
              cyan: '#06b6d4',
            }
            return colorMap[color] || colorMap.gray
          }}
          className="!bg-white dark:!bg-slate-900"
        />

        {/* Toolbar */}
        {!readOnly && (
          <Panel position="top-left" className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={addState}
              className="bg-white dark:bg-slate-800 shadow-sm"
            >
              <Plus className="h-4 w-4 mr-1" />
              Add State
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={addPhase}
              className="bg-white dark:bg-slate-800 shadow-sm"
            >
              <Layers className="h-4 w-4 mr-1" />
              Add Phase
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={autoLayout}
              className="bg-white dark:bg-slate-800 shadow-sm"
            >
              <LayoutGrid className="h-4 w-4 mr-1" />
              Auto Layout
            </Button>
            {onSave && (
              <Button
                type="button"
                size="sm"
                onClick={onSave}
                className="shadow-sm"
              >
                <Save className="h-4 w-4 mr-1" />
                Save
              </Button>
            )}
          </Panel>
        )}

        {/* Info panel */}
        <Panel
          position="bottom-right"
          className="text-xs text-slate-500 dark:text-slate-400"
        >
          {nodes.filter((n) => (n.type as string) === 'stateNode').length} state
          {nodes.filter((n) => (n.type as string) === 'stateNode').length !== 1
            ? 's'
            : ''}
          , {edges.length} transition
          {edges.length !== 1 ? 's' : ''}
          {(definition?.phases?.length ?? 0) > 0 &&
            `, ${definition?.phases?.length} phase${(definition?.phases?.length ?? 0) !== 1 ? 's' : ''}`}
        </Panel>
      </ReactFlow>

      {/* Properties Panels */}
      {selectedState && !readOnly && (
        <div className="absolute right-4 top-4 z-10">
          <StatePropertiesPanel
            state={selectedState}
            onUpdate={updateState}
            onClose={() => setSelectedState(null)}
            workflowDefinitionId={definition?.id}
            phases={definition?.phases}
          />
        </div>
      )}

      {selectedPhase && !readOnly && (
        <div className="absolute right-4 top-4 z-10">
          <PhasePropertiesPanel
            phase={selectedPhase}
            onUpdate={updatePhase}
            onDelete={deletePhase}
            onClose={() => setSelectedPhase(null)}
          />
        </div>
      )}

      {selectedTransition && !readOnly && (
        <div className="absolute right-4 top-4 z-10">
          <TransitionPropertiesPanel
            transition={selectedTransition}
            definitionType={definitionType}
            lifecycleType={lifecycleType}
            onUpdate={updateTransition}
            onDelete={deleteTransition}
            onClose={() => setSelectedTransition(null)}
          />
        </div>
      )}

      {/* Context menu for creating new state on drag release */}
      {contextMenu && (
        <>
          {/* Backdrop to close menu */}
          <div className="fixed inset-0 z-20" onClick={closeContextMenu} />
          {/* Menu */}
          <div
            className="fixed z-30 bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-slate-300 dark:border-slate-700 py-1 min-w-[160px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              className="w-full px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
              onClick={() =>
                createStateAtPosition(contextMenu.flowX, contextMenu.flowY)
              }
            >
              <Plus className="h-4 w-4" />
              Add State
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// Wrapper component that provides ReactFlow context
export function WorkflowBuilder(props: WorkflowBuilderProps) {
  return (
    <ReactFlowProvider>
      <WorkflowBuilderInner {...props} />
    </ReactFlowProvider>
  )
}
