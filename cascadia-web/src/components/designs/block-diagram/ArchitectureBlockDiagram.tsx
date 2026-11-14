// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
/**
 * The design's architecture as an editable block diagram.
 *
 * Blocks are the system elements, nested the way the DECOMPOSES tree nests
 * them; lines are the CONNECTS edges between them. Built from the same
 * answer the tab's tree and graph render, so the three views never disagree.
 *
 * What an edit here is, in the data:
 *
 * - drawing a line, renaming one or deleting one writes a CONNECTS edge —
 *   engineering data, under the same change control as the tree. On a
 *   branch the write lands on that branch; the server decides whether it is
 *   allowed (the source element checked out, or main before any release)
 *   and a refusal is shown as it comes back;
 * - adding a block creates a system element, and its DECOMPOSES edge when
 *   it is added inside another;
 * - dragging a block saves where it sits. That is presentation: one layout
 *   per design, outside change control, no checkout needed.
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
import { LayoutGrid, Plus } from 'lucide-react'
import {
  SYSTEM_CONNECTION_KINDS,
  SYSTEM_CONNECTION_KIND_LABELS,
  SYSTEM_ELEMENT_KINDS,
} from '@cascadia/commons/items/types/system-element'
import { BlockNode } from './BlockNode'
import { AddBlockDialog, ConnectionDialog } from './BlockDiagramDialogs'
import {
  CONNECTION_KIND_COLORS,
  connectionColor,
  connectionLabel,
} from './connection-kinds'
import { absolutePositions, facingSides, layoutBlocks } from './layout'
import type { Connection, Edge, OnNodeDrag } from '@xyflow/react'
import type {
  ArchitectureConnection,
  ArchitectureLayout,
  ArchitectureNode,
  DesignArchitecture,
} from '@cascadia/commons/services/types/architecture'
import type { SystemElementKind } from '@cascadia/commons/items/types/system-element'
import type {
  BlockFormValues,
  ConnectionFormValues,
} from './BlockDiagramDialogs'
import type { BlockNodeType } from './BlockNode'
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

type DialogState =
  | { type: 'connect'; sourceItemId: string; targetItemId: string }
  | { type: 'edit'; connection: ArchitectureConnection }
  | { type: 'add'; parent: ArchitectureNode | null }

const nodeTypes = { block: BlockNode }

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
  const blocks = useMemo(
    () => layoutBlocks(architecture.roots, positions),
    [architecture.roots, positions],
  )
  const elementById = useMemo(
    () => indexElements(architecture.roots),
    [architecture.roots],
  )

  const refreshArchitecture = () =>
    queryClient.invalidateQueries({
      queryKey: qk.sub('designs', designId, 'architecture'),
    })

  const saveLayout = useMutation({
    mutationFn: (next: ArchitectureLayout) =>
      apiFetch(`/api/v1/designs/${designId}/architecture/layout`, {
        method: 'PUT',
        body: JSON.stringify({ positions: next }),
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

  const builtNodes = useMemo<Array<BlockNodeType>>(
    () =>
      blocks.map((block) => ({
        id: block.element.itemId,
        type: 'block',
        position: { x: block.x, y: block.y },
        width: block.width,
        height: block.height,
        ...(block.parentItemId && { parentId: block.parentItemId }),
        data: {
          element: block.element,
          isContainer: block.isContainer,
          connectable: !readOnly,
        },
      })),
    [blocks, readOnly],
  )
  const [nodes, setNodes, onNodesChange] = useNodesState<BlockNodeType>([])
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
    const boxes = absolutePositions(blocks)
    return architecture.connections.flatMap((connection) => {
      const source = boxes.get(connection.sourceItemId)
      const target = boxes.get(connection.targetItemId)
      if (!source || !target) return []
      const sides = facingSides(source, target)
      const color = connectionColor(connection.kind)
      return [
        {
          id: connection.relationshipId,
          source: connection.sourceItemId,
          target: connection.targetItemId,
          sourceHandle: sides.source,
          targetHandle: sides.target,
          type: 'smoothstep',
          label: connectionLabel(connection),
          style: { stroke: color, strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color },
          interactionWidth: 24,
          // Above the containers a line may have to cross.
          zIndex: 1000,
          data: { connection },
        },
      ]
    })
  }, [architecture.connections, blocks])

  const selectedElement = useMemo(() => {
    const selected = nodes.filter((node) => node.selected)
    return selected.length === 1 ? (selected[0]?.data.element ?? null) : null
  }, [nodes])

  // ---- Edits ------------------------------------------------------------

  const onNodeDragStop = useCallback<OnNodeDrag<BlockNodeType>>(
    (_event, _node, dragged) => {
      // Pin every block where it is now drawn, then move the dragged ones:
      // otherwise the blocks still placed automatically would repack around
      // the first one that gets a saved position.
      const next: ArchitectureLayout = {}
      for (const block of blocks) {
        next[block.element.masterId] = { x: block.x, y: block.y }
      }
      for (const node of dragged) {
        next[node.data.element.masterId] = {
          x: Math.round(node.position.x),
          y: Math.round(node.position.y),
        }
      }
      setMoved(next)
      saveLayout.mutate(next)
    },
    [blocks, saveLayout],
  )

  const autoArrange = () => {
    setMoved({})
    setIgnoreSaved(true)
    resetLayout.mutate()
  }

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source === connection.target) return
      const existing = architecture.connections.find(
        (candidate) =>
          candidate.sourceItemId === connection.source &&
          candidate.targetItemId === connection.target,
      )
      setDialog(
        existing
          ? { type: 'edit', connection: existing }
          : {
              type: 'connect',
              sourceItemId: connection.source,
              targetItemId: connection.target,
            },
      )
    },
    [architecture.connections],
  )

  const closeDialog = () => setDialog(null)
  const connect = useResourceMutation({
    mutationFn: (input: {
      sourceItemId: string
      targetItemId: string
      values: ConnectionFormValues
    }) =>
      apiFetch(`/api/v1/system-elements/${input.sourceItemId}/connections`, {
        method: 'POST',
        body: JSON.stringify({
          itemId: input.targetItemId,
          ...input.values,
          ...(branchId && { branchId }),
        }),
      }),
    invalidates: ['system-elements'],
    onSuccess: closeDialog,
    onError: (error) => handleError(error, { title: 'Could not connect' }),
  })
  const updateConnection = useResourceMutation({
    mutationFn: (input: {
      relationshipId: string
      values: ConnectionFormValues
    }) =>
      apiFetch(`/api/v1/system-elements/connections/${input.relationshipId}`, {
        method: 'PUT',
        body: JSON.stringify(input.values),
      }),
    invalidates: ['system-elements'],
    onSuccess: closeDialog,
    onError: (error) =>
      handleError(error, { title: 'Could not update the connection' }),
  })
  const removeConnection = useResourceMutation({
    mutationFn: (relationshipId: string) =>
      apiFetch(`/api/v1/system-elements/connections/${relationshipId}`, {
        method: 'DELETE',
      }),
    invalidates: ['system-elements'],
    onSuccess: closeDialog,
    onError: (error) =>
      handleError(error, { title: 'Could not delete the connection' }),
  })
  const addBlock = useResourceMutation({
    mutationFn: async (input: {
      parent: ArchitectureNode | null
      values: BlockFormValues
    }) => {
      const result = await apiFetch<{ data: { item: { id: string } } }>(
        '/api/v1/items',
        {
          method: 'POST',
          body: JSON.stringify({
            itemType: 'SystemElement',
            // Blank: the server assigns the next number.
            itemNumber: '',
            name: input.values.name,
            elementKind: input.values.elementKind,
            designId,
            ...(branchId && { branchId }),
          }),
        },
      )
      if (input.parent) {
        await apiFetch(
          `/api/v1/system-elements/${input.parent.itemId}/children`,
          {
            method: 'POST',
            body: JSON.stringify({
              itemIds: [result.data.item.id],
              ...(branchId && { branchId }),
            }),
          },
        )
      }
    },
    invalidates: ['system-elements'],
    onSuccess: closeDialog,
    onError: (error) =>
      handleError(error, { title: 'Could not add the block' }),
  })

  const busy =
    connect.isPending ||
    updateConnection.isPending ||
    removeConnection.isPending ||
    addBlock.isPending

  return (
    <div data-testid="architecture-block-diagram">
      <div className="h-[640px] rounded-lg border bg-slate-50 dark:border-slate-700 dark:bg-slate-950">
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
                  const connection = architecture.connections.find(
                    (candidate) => candidate.relationshipId === edge.id,
                  )
                  if (connection) setDialog({ type: 'edit', connection })
                }
          }
          connectionMode={ConnectionMode.Loose}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          // Deleting an element is a decision for its own page, and a
          // connection is deleted from its dialog — never by a stray key.
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
                  setDialog({ type: 'add', parent: selectedElement })
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
        <p>
          {readOnly
            ? 'Read-only at this version. Use the mouse wheel to zoom and drag the canvas to pan.'
            : 'Drag a block to move it. Drag from a dot on one block to another block to connect them; click a line to rename or delete it.'}
        </p>
        <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {SYSTEM_CONNECTION_KINDS.map((kind) => (
            <li key={kind} className="inline-flex items-center gap-1">
              <span
                className="inline-block h-0.5 w-4 rounded"
                style={{ backgroundColor: CONNECTION_KIND_COLORS[kind] }}
              />
              {SYSTEM_CONNECTION_KIND_LABELS[kind]}
            </li>
          ))}
        </ul>
      </div>

      {dialog?.type === 'connect' && (
        <ConnectionDialog
          sourceLabel={elementLabel(elementById.get(dialog.sourceItemId))}
          targetLabel={elementLabel(elementById.get(dialog.targetItemId))}
          busy={busy}
          onSubmit={(values) =>
            connect.mutate({
              sourceItemId: dialog.sourceItemId,
              targetItemId: dialog.targetItemId,
              values,
            })
          }
          onClose={closeDialog}
        />
      )}
      {dialog?.type === 'edit' && (
        <ConnectionDialog
          sourceLabel={elementLabel(
            elementById.get(dialog.connection.sourceItemId),
          )}
          targetLabel={elementLabel(
            elementById.get(dialog.connection.targetItemId),
          )}
          existing={dialog.connection}
          busy={busy}
          onSubmit={(values) =>
            updateConnection.mutate({
              relationshipId: dialog.connection.relationshipId,
              values,
            })
          }
          onDelete={() =>
            removeConnection.mutate(dialog.connection.relationshipId)
          }
          onClose={closeDialog}
        />
      )}
      {dialog?.type === 'add' && (
        <AddBlockDialog
          parentLabel={dialog.parent ? elementLabel(dialog.parent) : undefined}
          defaultKind={
            dialog.parent ? kindBelow(dialog.parent.elementKind) : 'system'
          }
          busy={busy}
          onSubmit={(values) =>
            addBlock.mutate({ parent: dialog.parent, values })
          }
          onClose={closeDialog}
        />
      )}
    </div>
  )
}
