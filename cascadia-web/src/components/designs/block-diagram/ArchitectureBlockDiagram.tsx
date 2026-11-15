// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
/**
 * The design's architecture as an editable block diagram.
 *
 * Blocks are the system elements, nested the way the DECOMPOSES tree nests
 * them, each with its ports down its edges. Lines are the design's
 * interfaces — items of their own — running between the ports they attach
 * to; an interface with more than two ends is drawn as a bus node the lines
 * meet at. Built from the same answer the tab's tree and graph render, so
 * the three views never disagree.
 *
 * What an edit here is, in the data:
 *
 * - drawing a line creates an Interface item and attaches it to a port at
 *   each end, creating the port when the line was dropped on a block's "new
 *   port" point. Renaming, re-attaching or deleting an interface is an edit
 *   of the interface; adding, renaming or deleting a port is an edit of the
 *   element. Both are engineering data under change control: on a branch
 *   the write lands on that branch, the server decides whether it is
 *   allowed, and a refusal is shown as it comes back;
 * - adding a block creates a system element, and its DECOMPOSES edge when
 *   it is added inside another;
 * - dragging a block or a bus node saves where it sits. That is
 *   presentation: one layout per design, outside change control.
 *
 * At a tag or a commit the diagram is read-only.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Background,
  ConnectionMode,
  Controls,
  MarkerType,
  Panel,
  ReactFlow,
  useNodesState,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { CircleDot, LayoutGrid, Plus } from 'lucide-react'
import {
  INTERFACE_KINDS,
  INTERFACE_KIND_LABELS,
} from '@cascadia/commons/items/types/interface'
import { SYSTEM_ELEMENT_KINDS } from '@cascadia/commons/items/types/system-element'
import { BlockNode, newPortHandleId, portHandleId } from './BlockNode'
import { HubNode, hubNodeId, interfaceIdOfHub } from './HubNode'
import {
  AddBlockDialog,
  ConnectDialog,
  InterfaceDialog,
  PortDialog,
} from './BlockDiagramDialogs'
import {
  INTERFACE_KIND_COLORS,
  interfaceColor,
  interfaceLabel,
} from './interface-kinds'
import {
  HUB_HEIGHT,
  HUB_WIDTH,
  absoluteBoxes,
  defaultHubPosition,
  facingSide,
  layoutBlocks,
  placePorts,
  portRowsOf,
} from './layout'
import type { Connection, Edge, EdgeMarker, OnNodeDrag } from '@xyflow/react'
import type {
  ArchitectureInterface,
  ArchitectureInterfaceEnd,
  ArchitectureLayout,
  ArchitectureNode,
  DesignArchitecture,
} from '@cascadia/commons/services/types/architecture'
import type {
  SystemElementKind,
  SystemPort,
  SystemPortDirection,
} from '@cascadia/commons/items/types/system-element'
import type { ConnectEnd } from './BlockDiagramDialogs'
import type { BlockNodeType } from './BlockNode'
import type { HubNodeType } from './HubNode'
import type { Box, PortRows } from './layout'
import { apiFetch } from '@/api/client'
import { Button } from '@/components/ui'
import { useErrorHandler } from '@/hooks/useErrorHandler'
import { qk, useResourceMutation } from '@/query'
import { useTheme } from '@/theme'

interface ArchitectureBlockDiagramProps {
  designId: string
  architecture: DesignArchitecture
  /** The branch edits land on; absent when the page is viewing main. */
  branchId?: string
  /** A tag or commit: nothing can be changed, not even the layout. */
  readOnly: boolean
}

type DiagramNode = BlockNodeType | HubNodeType

/** One end of a line being dragged: a block, at a port or at a new one. */
interface DraggedEnd {
  elementItemId: string
  portId?: string
}

// Dialogs hold ids, not objects, so what they show follows a refetch.
type DialogState =
  | { type: 'connect'; ends: [DraggedEnd, DraggedEnd] }
  | { type: 'interface'; interfaceItemId: string }
  | { type: 'attach'; interfaceItemId: string; elementItemId: string }
  | { type: 'port'; elementItemId: string; portId: string }
  | { type: 'addPort'; elementItemId: string }
  | { type: 'addBlock'; parentItemId: string | null }

/** A write the diagram makes: what to run, and what to call a failure. */
interface DiagramWrite {
  title: string
  run: () => Promise<unknown>
}

const nodeTypes = { block: BlockNode, hub: HubNode }
const json = (body: unknown) => JSON.stringify(body)

function indexElements(
  nodes: Array<ArchitectureNode>,
  into = new Map<string, ArchitectureNode>(),
): Map<string, ArchitectureNode> {
  for (const node of nodes) {
    into.set(node.itemId, node)
    indexElements(node.children, into)
  }
  return into
}

function elementLabel(element: ArchitectureNode | undefined): string {
  if (!element) return 'Unknown element'
  return element.name
    ? `${element.itemNumber} ${element.name}`
    : element.itemNumber
}

/** The kind one level below `kind`, for a block added inside another. */
function kindBelow(kind: string | null | undefined): SystemElementKind {
  const index = SYSTEM_ELEMENT_KINDS.indexOf(kind as SystemElementKind)
  return (
    SYSTEM_ELEMENT_KINDS[index + 1] ??
    SYSTEM_ELEMENT_KINDS[SYSTEM_ELEMENT_KINDS.length - 1] ??
    'module'
  )
}

/** An arrowhead belongs at an end things flow into. */
function arrowInto(
  port: SystemPort | undefined,
  color: string,
): EdgeMarker | undefined {
  return port && port.direction !== 'out'
    ? { type: MarkerType.ArrowClosed, color }
    : undefined
}

export function ArchitectureBlockDiagram({
  designId,
  architecture,
  branchId,
  readOnly,
}: ArchitectureBlockDiagramProps) {
  const { theme } = useTheme()
  const { handleError } = useErrorHandler()
  const queryClient = useQueryClient()
  const [dialog, setDialog] = useState<DialogState | null>(null)
  // Two-ended interfaces the user asked to see as a bus node.
  const [shownAsBus, setShownAsBus] = useState<ReadonlySet<string>>(new Set())

  const elementById = useMemo(
    () => indexElements(architecture.roots),
    [architecture.roots],
  )
  const interfaceById = useMemo(
    () => new Map(architecture.interfaces.map((item) => [item.itemId, item])),
    [architecture.interfaces],
  )
  const portOf = useCallback(
    (end: { elementItemId: string; portId?: string | null }) =>
      elementById
        .get(end.elementItemId)
        ?.ports.find((port) => port.id === end.portId),
    [elementById],
  )

  // ---- Layout -----------------------------------------------------------

  // Positions moved in this session, laid over what the server has saved, so
  // a drag shows at once and survives the refetch that follows a write. After
  // "auto-arrange" the saved ones are ignored until the refetch empties them.
  const [moved, setMoved] = useState<ArchitectureLayout>({})
  const [ignoreSaved, setIgnoreSaved] = useState(false)
  const positions = useMemo(
    () => (ignoreSaved ? moved : { ...architecture.layout, ...moved }),
    [architecture.layout, moved, ignoreSaved],
  )

  // Which side a port is drawn on depends on where the blocks are, and how
  // tall a block is depends on how many ports each side holds. One pass with
  // a guess (half its ports a side) settles the sides; the second uses them.
  const { blocks, placedPorts } = useMemo(() => {
    const guess: PortRows = new Map(
      [...elementById.values()].map((element) => [
        element.itemId,
        Math.ceil(element.ports.length / 2),
      ]),
    )
    const ports = placePorts(
      layoutBlocks(architecture.roots, positions, guess),
      architecture.interfaces,
    )
    return {
      blocks: layoutBlocks(architecture.roots, positions, portRowsOf(ports)),
      placedPorts: ports,
    }
  }, [architecture.roots, architecture.interfaces, elementById, positions])
  const boxes = useMemo(() => absoluteBoxes(blocks), [blocks])

  /** Interfaces drawn as a node: a bus, a loose end, or one asked for. */
  const hubs = useMemo(() => {
    let unattached = 0
    return architecture.interfaces
      .filter((item) => item.ends.length !== 2 || shownAsBus.has(item.itemId))
      .map((item) => {
        const ends = item.ends.flatMap(
          (end) => boxes.get(end.elementItemId) ?? [],
        )
        const fallback = defaultHubPosition(ends)
        // Interfaces attached to nothing line up above the diagram.
        if (ends.length === 0) fallback.x += unattached++ * (HUB_WIDTH + 16)
        const position = positions[item.masterId] ?? fallback
        return {
          item,
          box: { ...position, width: HUB_WIDTH, height: HUB_HEIGHT } as Box,
        }
      })
  }, [architecture.interfaces, boxes, positions, shownAsBus])

  const refreshArchitecture = () =>
    queryClient.invalidateQueries({
      queryKey: qk.sub('designs', designId, 'architecture'),
    })
  const saveLayout = useMutation({
    mutationFn: (next: ArchitectureLayout) =>
      apiFetch(`/api/v1/designs/${designId}/architecture/layout`, {
        method: 'PUT',
        body: json({ positions: next }),
      }),
    onSuccess: refreshArchitecture,
    onError: (error) =>
      handleError(error, { title: 'Could not save the diagram layout' }),
  })
  const resetLayout = useMutation({
    mutationFn: () =>
      apiFetch(`/api/v1/designs/${designId}/architecture/layout`, {
        method: 'DELETE',
      }),
    onSuccess: refreshArchitecture,
    onError: (error) =>
      handleError(error, { title: 'Could not reset the diagram layout' }),
  })

  // ---- Nodes and edges --------------------------------------------------

  const openPort = useCallback(
    (elementItemId: string, portId: string) =>
      setDialog({ type: 'port', elementItemId, portId }),
    [],
  )
  const builtNodes = useMemo<Array<DiagramNode>>(
    () => [
      ...blocks.map((block): BlockNodeType => ({
        id: block.element.itemId,
        type: 'block',
        position: { x: block.x, y: block.y },
        width: block.width,
        height: block.height,
        ...(block.parentItemId && { parentId: block.parentItemId }),
        data: {
          element: block.element,
          isContainer: block.isContainer,
          ports: placedPorts.get(block.element.itemId) ?? [],
          editable: !readOnly,
          onPortClick: openPort,
        },
      })),
      ...hubs.map(({ item, box }): HubNodeType => ({
        id: hubNodeId(item.itemId),
        type: 'hub',
        position: { x: box.x, y: box.y },
        width: box.width,
        height: box.height,
        // Above the containers it may sit over.
        zIndex: 1001,
        data: { item, editable: !readOnly },
      })),
    ],
    [blocks, hubs, placedPorts, readOnly, openPort],
  )
  const [nodes, setNodes, onNodesChange] = useNodesState<DiagramNode>([])
  useEffect(() => {
    // Rebuilt from data on every change; only the selection is the canvas's.
    setNodes((previous) => {
      const selected = new Set(
        previous.filter((node) => node.selected).map((node) => node.id),
      )
      return builtNodes.map((node) =>
        selected.has(node.id) ? { ...node, selected: true } : node,
      )
    })
  }, [builtNodes, setNodes])

  const edges = useMemo<Array<Edge>>(() => {
    const hubBoxById = new Map(hubs.map(({ item, box }) => [item.itemId, box]))
    /** The point on its block an end is drawn from. */
    const handleOf = (end: ArchitectureInterfaceEnd) =>
      portOf(end) && end.portId
        ? portHandleId(end.portId)
        : // A port that has gone: the line still shows, from the block's edge.
          newPortHandleId('right')
    const base = (item: ArchitectureInterface, dangling: boolean) => {
      const color = interfaceColor(item.kind)
      return {
        color,
        shared: {
          type: 'smoothstep',
          style: {
            stroke: color,
            strokeWidth: 2,
            ...(dangling && { strokeDasharray: '4 3' }),
          },
          interactionWidth: 24,
          // Above the containers a line may have to cross.
          zIndex: 1000,
        },
      }
    }

    return architecture.interfaces.flatMap((item): Array<Edge> => {
      const hubBox = hubBoxById.get(item.itemId)
      if (hubBox) {
        return item.ends.flatMap((end): Array<Edge> => {
          const box = boxes.get(end.elementItemId)
          if (!box) return []
          const { color, shared } = base(item, end.portMissing)
          return [
            {
              ...shared,
              id: `end:${end.relationshipId}`,
              source: end.elementItemId,
              sourceHandle: handleOf(end),
              target: hubNodeId(item.itemId),
              targetHandle: facingSide(hubBox, box),
              markerStart: arrowInto(portOf(end), color),
            },
          ]
        })
      }
      const [first, second] = item.ends
      if (!first || !second) return []
      const { color, shared } = base(
        item,
        first.portMissing || second.portMissing,
      )
      return [
        {
          ...shared,
          id: `if:${item.itemId}`,
          source: first.elementItemId,
          sourceHandle: handleOf(first),
          target: second.elementItemId,
          targetHandle: handleOf(second),
          label: interfaceLabel(item),
          markerStart: arrowInto(portOf(first), color),
          markerEnd: arrowInto(portOf(second), color),
        },
      ]
    })
  }, [architecture.interfaces, boxes, hubs, portOf])

  const selectedElement = useMemo(() => {
    const selected = nodes.filter((node) => node.selected)
    const only = selected.length === 1 ? selected[0] : undefined
    return only?.type === 'block' ? only.data.element : null
  }, [nodes])

  // ---- Edits ------------------------------------------------------------

  const onNodeDragStop = useCallback<OnNodeDrag<DiagramNode>>(
    (_event, _node, dragged) => {
      // Pin every block where it is now drawn, then move the dragged ones:
      // otherwise the blocks still placed automatically would repack around
      // the first one that gets a saved position. Bus nodes are pinned only
      // when dragged, so the rest keep following the blocks they join.
      const next: ArchitectureLayout = { ...moved }
      for (const block of blocks) {
        next[block.element.masterId] = { x: block.x, y: block.y }
      }
      for (const node of dragged) {
        const masterId =
          node.type === 'hub'
            ? node.data.item.masterId
            : node.data.element.masterId
        next[masterId] = {
          x: Math.round(node.position.x),
          y: Math.round(node.position.y),
        }
      }
      setMoved(next)
      saveLayout.mutate(next)
    },
    [blocks, moved, saveLayout],
  )

  const autoArrange = () => {
    setMoved({})
    setIgnoreSaved(true)
    resetLayout.mutate()
  }

  const closeDialog = () => setDialog(null)
  const write = useResourceMutation({
    mutationFn: (request: DiagramWrite) => request.run(),
    invalidates: ['system-elements', 'interfaces'],
    onSuccess: closeDialog,
    onError: (error, request) => handleError(error, { title: request.title }),
  })
  const branch = branchId ? { branchId } : {}
  const post = (path: string, body: unknown) =>
    apiFetch(path, { method: 'POST', body: json(body) })
  const architecturePath = `/api/v1/designs/${designId}/architecture`

  /** What the server is told about one end: its port, or the one to create. */
  const endInput = (
    end: DraggedEnd,
    newPort: { name: string; direction: SystemPortDirection } | null,
  ) =>
    end.portId
      ? { elementId: end.elementItemId, portId: end.portId }
      : { elementId: end.elementItemId, newPort }

  const attach = (
    interfaceItemId: string,
    end: DraggedEnd,
    newPort: { name: string; direction: SystemPortDirection } | null,
  ) =>
    write.mutate({
      title: 'Could not attach the interface',
      run: () =>
        post(`${architecturePath}/interfaces/${interfaceItemId}/ends`, {
          end: endInput(end, newPort),
          ...branch,
        }),
    })

  const onConnect = (connection: Connection) => {
    const parse = (
      nodeId: string,
      handle: string | null,
    ): { hub: string } | { end: DraggedEnd } => {
      const hub = interfaceIdOfHub(nodeId)
      if (hub) return { hub }
      return {
        end: {
          elementItemId: nodeId,
          ...(handle?.startsWith('port:') && { portId: handle.slice(5) }),
        },
      }
    }
    const from = parse(connection.source, connection.sourceHandle)
    const to = parse(connection.target, connection.targetHandle)

    if ('end' in from && 'end' in to) {
      if (from.end.elementItemId === to.end.elementItemId) return
      setDialog({ type: 'connect', ends: [from.end, to.end] })
      return
    }
    // A port dragged to a bus node (or the other way): one more end.
    const hub = 'hub' in from ? from.hub : 'hub' in to ? to.hub : null
    const end = 'end' in from ? from.end : 'end' in to ? to.end : null
    if (!hub || !end) return
    if (end.portId) attach(hub, end, null)
    else {
      setDialog({
        type: 'attach',
        interfaceItemId: hub,
        elementItemId: end.elementItemId,
      })
    }
  }

  const openInterface = (interfaceItemId: string | undefined) => {
    if (interfaceItemId && interfaceById.has(interfaceItemId)) {
      setDialog({ type: 'interface', interfaceItemId })
    }
  }

  // ---- Dialogs ----------------------------------------------------------

  const busy = write.isPending
  const renderDialog = () => {
    if (!dialog) return null
    switch (dialog.type) {
      case 'connect': {
        const ends = dialog.ends.map((end, index): ConnectEnd => {
          const port = portOf(end)
          return {
            elementItemId: end.elementItemId,
            elementLabel: elementLabel(elementById.get(end.elementItemId)),
            ...(port && { port: { id: port.id, name: port.name } }),
            // The line was dragged from the first end to the second.
            defaultDirection: index === 0 ? 'out' : 'in',
          }
        })
        return (
          <ConnectDialog
            ends={ends}
            busy={busy}
            onClose={closeDialog}
            onSubmit={(values) =>
              write.mutate({
                title: 'Could not connect',
                run: () =>
                  post(`${architecturePath}/interfaces`, {
                    name: values.name,
                    kind: values.kind,
                    ends: dialog.ends.map((end, index) =>
                      endInput(end, values.newPorts[index] ?? null),
                    ),
                    ...branch,
                  }),
              })
            }
          />
        )
      }
      case 'interface': {
        const item = interfaceById.get(dialog.interfaceItemId)
        if (!item) return null
        return (
          <InterfaceDialog
            item={item}
            ends={item.ends.map((end) => ({
              relationshipId: end.relationshipId,
              label: `${elementLabel(elementById.get(end.elementItemId))} · ${
                portOf(end)?.name ?? 'no port'
              }`,
              portMissing: end.portMissing,
            }))}
            busy={busy}
            onClose={closeDialog}
            onSubmit={(values) =>
              write.mutate({
                title: 'Could not update the interface',
                run: () =>
                  apiFetch(`/api/v1/interfaces/${item.itemId}`, {
                    method: 'PUT',
                    body: json({
                      name: values.name,
                      interfaceKind: values.kind,
                    }),
                  }),
              })
            }
            onDetach={(relationshipId) =>
              write.mutate({
                title: 'Could not detach the interface',
                run: () =>
                  apiFetch(
                    `${architecturePath}/interface-ends/${relationshipId}`,
                    { method: 'DELETE' },
                  ),
              })
            }
            onDelete={() =>
              write.mutate({
                title: 'Could not delete the interface',
                run: () =>
                  apiFetch(`/api/v1/interfaces/${item.itemId}`, {
                    method: 'DELETE',
                  }),
              })
            }
            onShowAsBus={
              item.ends.length === 2 && !shownAsBus.has(item.itemId)
                ? () => {
                    setShownAsBus(
                      (previous) => new Set([...previous, item.itemId]),
                    )
                    closeDialog()
                  }
                : undefined
            }
          />
        )
      }
      case 'attach': {
        const item = interfaceById.get(dialog.interfaceItemId)
        return (
          <PortDialog
            title={`Attach ${item ? interfaceLabel(item) : 'the interface'} through a new port`}
            elementLabel={elementLabel(elementById.get(dialog.elementItemId))}
            submitLabel="Attach"
            busy={busy}
            onClose={closeDialog}
            onSubmit={(values) =>
              attach(
                dialog.interfaceItemId,
                { elementItemId: dialog.elementItemId },
                values,
              )
            }
          />
        )
      }
      case 'addPort':
        return (
          <PortDialog
            title="Add port"
            elementLabel={elementLabel(elementById.get(dialog.elementItemId))}
            submitLabel="Add port"
            busy={busy}
            onClose={closeDialog}
            onSubmit={(values) =>
              write.mutate({
                title: 'Could not add the port',
                run: () =>
                  post(
                    `/api/v1/system-elements/${dialog.elementItemId}/ports`,
                    { ...values, ...branch },
                  ),
              })
            }
          />
        )
      case 'port': {
        const port = portOf(dialog)
        if (!port) return null
        const path = `/api/v1/system-elements/${dialog.elementItemId}/ports/${port.id}`
        return (
          <PortDialog
            title={`Port ${port.name}`}
            elementLabel={elementLabel(elementById.get(dialog.elementItemId))}
            existing={port}
            submitLabel="Save"
            busy={busy}
            onClose={closeDialog}
            onSubmit={(values) =>
              write.mutate({
                title: 'Could not update the port',
                run: () =>
                  apiFetch(path, {
                    method: 'PUT',
                    body: json({ ...values, ...branch }),
                  }),
              })
            }
            onDelete={() =>
              write.mutate({
                title: 'Could not delete the port',
                run: () =>
                  apiFetch(branchId ? `${path}?branchId=${branchId}` : path, {
                    method: 'DELETE',
                  }),
              })
            }
          />
        )
      }
      case 'addBlock': {
        const parent = dialog.parentItemId
          ? elementById.get(dialog.parentItemId)
          : undefined
        return (
          <AddBlockDialog
            parentLabel={parent ? elementLabel(parent) : undefined}
            defaultKind={parent ? kindBelow(parent.elementKind) : 'system'}
            busy={busy}
            onClose={closeDialog}
            onSubmit={(values) =>
              write.mutate({
                title: 'Could not add the block',
                run: async () => {
                  const result = await apiFetch<{
                    data: { item: { id: string } }
                  }>('/api/v1/items', {
                    method: 'POST',
                    body: json({
                      itemType: 'SystemElement',
                      // Blank: the server assigns the next number.
                      itemNumber: '',
                      name: values.name,
                      elementKind: values.elementKind,
                      designId,
                      ...branch,
                    }),
                  })
                  if (parent) {
                    await post(
                      `/api/v1/system-elements/${parent.itemId}/children`,
                      { itemIds: [result.data.item.id], ...branch },
                    )
                  }
                },
              })
            }
          />
        )
      }
    }
  }

  return (
    <div data-testid="architecture-block-diagram">
      <div className="h-[680px] rounded-lg border bg-slate-50 dark:border-slate-700 dark:bg-slate-950">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={readOnly ? undefined : onNodeDragStop}
          onConnect={readOnly ? undefined : onConnect}
          onEdgeClick={
            readOnly
              ? undefined
              : (_event, edge) => {
                  if (edge.id.startsWith('if:')) {
                    openInterface(edge.id.slice(3))
                  } else {
                    const relationshipId = edge.id.slice(4)
                    openInterface(
                      architecture.interfaces.find((item) =>
                        item.ends.some(
                          (end) => end.relationshipId === relationshipId,
                        ),
                      )?.itemId,
                    )
                  }
                }
          }
          onNodeClick={
            readOnly
              ? undefined
              : (_event, node) => {
                  if (node.type === 'hub') openInterface(node.data.item.itemId)
                }
          }
          connectionMode={ConnectionMode.Loose}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          // Deleting an element is a decision for its own page, and an
          // interface is deleted from its dialog — never by a stray key.
          deleteKeyCode={null}
          colorMode={theme}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
          minZoom={0.1}
          maxZoom={2}
          attributionPosition="bottom-right"
        >
          <Background gap={16} />
          <Controls showInteractive={false} />
          {!readOnly && (
            <Panel position="top-left" className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() =>
                  setDialog({
                    type: 'addBlock',
                    parentItemId: selectedElement?.itemId ?? null,
                  })
                }
                title={
                  selectedElement
                    ? `Add a block inside ${selectedElement.itemNumber}`
                    : 'Add a top-level block. Select a block first to add one inside it.'
                }
              >
                <Plus className="mr-1 h-4 w-4" />
                {selectedElement
                  ? `Add block inside ${selectedElement.itemNumber}`
                  : 'Add block'}
              </Button>
              {selectedElement && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setDialog({
                      type: 'addPort',
                      elementItemId: selectedElement.itemId,
                    })
                  }
                >
                  <CircleDot className="mr-1 h-4 w-4" />
                  Add port to {selectedElement.itemNumber}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={autoArrange}
                disabled={resetLayout.isPending}
                title="Forget the saved positions and arrange the blocks automatically"
              >
                <LayoutGrid className="mr-1 h-4 w-4" />
                Auto-arrange
              </Button>
            </Panel>
          )}
        </ReactFlow>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-xs text-slate-600 dark:text-slate-400">
        <p className="max-w-3xl">
          {readOnly
            ? 'Read-only at this version. Use the mouse wheel to zoom and drag the canvas to pan.'
            : 'Drag between two ports to connect them with an interface; drag from or to a dashed point to create a new port on the way. Click a line, a bus node or a port to edit it.'}
        </p>
        <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {INTERFACE_KINDS.map((kind) => (
            <li key={kind} className="inline-flex items-center gap-1">
              <span
                className="inline-block h-0.5 w-4 rounded"
                style={{ backgroundColor: INTERFACE_KIND_COLORS[kind] }}
              />
              {INTERFACE_KIND_LABELS[kind]}
            </li>
          ))}
        </ul>
      </div>

      {renderDialog()}
    </div>
  )
}
