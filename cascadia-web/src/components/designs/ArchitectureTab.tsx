// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
/**
 * The design's Architecture tab: its system elements as the DECOMPOSES tree
 * — each with the items that realize it and the requirements allocated to it
 * — at whatever version context the page is viewing, and the same forest as
 * a graph, and as a block diagram that can be edited in place — blocks nested
 * the way the tree nests them, with the connections between them. Read through `designArchitectureQuery`, so a write anywhere on the
 * architecture restages it; the tree is the BOM tree view with its own
 * columns, so the two structures of a design read alike.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronsDownUp,
  ChevronsUpDown,
  GitFork,
  ListTree,
  Plus,
  Workflow,
} from 'lucide-react'
import { ArchitectureGraphView } from './ArchitectureGraphView'
import { ArchitectureBlockDiagram } from './block-diagram/ArchitectureBlockDiagram'
import type {
  ArchitectureLink,
  ArchitectureNode,
} from '@cascadia/commons/services/types/architecture'
import type { BOMTreeNode } from '@cascadia/commons/types/bom'
import type { ColumnDefinition } from '@/components/bom/BomTreeView'
import type { VersionContext } from '@/hooks/useVersionContext'
import type { SuspectReasonLabels } from '@/components/items/suspect-links'
import { elementKindLabel } from '@/components/system-elements/SystemElementTable'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { BomTreeView } from '@/components/bom/BomTreeView'
import { ItemLink } from '@/components/items/ItemLink'
import { StateBadge } from '@/components/items/StateBadge'
import { SuspectBadge } from '@/components/items/suspect-links'
import { designArchitectureQuery } from '@/query'
import { getVersionContextLabel } from '@/hooks/useVersionContext'

interface ArchitectureTabProps {
  designId: string
  designCode: string
  versionContext: VersionContext
  isHistoricalView: boolean
}

type ArchitectureView = 'tree' | 'diagram' | 'graph'

/**
 * The tree view renders `BOMTreeNode`s, so the forest is mapped to that
 * shape and the element behind each row is looked up by id for the columns
 * that need more than the node carries.
 */
function toTreeNode(node: ArchitectureNode): BOMTreeNode {
  return {
    itemId: node.itemId,
    masterId: node.masterId,
    itemNumber: node.itemNumber,
    name: node.name,
    revision: node.revision,
    state: node.state,
    itemType: 'SystemElement',
    relationshipId: node.relationshipId,
    children: node.children.map(toTreeNode),
  }
}

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

/** A realization runs from the element to the item that realizes it. */
const REALIZATION_SUSPECT_LABELS: SuspectReasonLabels = {
  source_revised: 'Element revised',
  target_revised: 'Realizing item revised',
}

/** An allocation runs from the requirement to the element. */
const ALLOCATION_SUSPECT_LABELS: SuspectReasonLabels = {
  source_revised: 'Requirement revised',
  target_revised: 'Element revised',
}

function collectIds(
  nodes: Array<BOMTreeNode>,
  into = new Set<string>(),
): Set<string> {
  for (const node of nodes) {
    into.add(node.itemId)
    if (node.children) collectIds(node.children, into)
  }
  return into
}

function LinkChips({
  links,
  labels,
  empty,
}: {
  links: Array<ArchitectureLink>
  labels: SuspectReasonLabels
  empty: string
}) {
  if (links.length === 0) {
    return <span className="text-xs text-slate-400">{empty}</span>
  }
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      {links.map((link) => (
        <span
          key={link.relationshipId}
          className="inline-flex items-center gap-1 text-xs"
        >
          <ItemLink
            itemType={link.itemType}
            itemId={link.itemId}
            className="font-mono text-blue-600 hover:underline dark:text-blue-400"
          >
            {link.itemNumber}
          </ItemLink>
          <span className="text-slate-400">{link.revision}</span>
          {link.suspect && (
            <SuspectBadge reasons={link.suspectReasons} labels={labels} />
          )}
        </span>
      ))}
    </span>
  )
}

export function ArchitectureTab({
  designId,
  designCode,
  versionContext,
  isHistoricalView,
}: ArchitectureTabProps) {
  const {
    data: architecture,
    isPending,
    isError,
  } = useQuery(
    designArchitectureQuery(designId, {
      branchId: versionContext.branchId,
      tagId: versionContext.tagId,
      commitId: versionContext.commitId,
    }),
  )
  const [view, setView] = useState<ArchitectureView>('tree')
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())

  const roots = useMemo(
    () => (architecture?.roots ?? []).map(toTreeNode),
    [architecture],
  )
  const elementById = useMemo(
    () => indexElements(architecture?.roots ?? []),
    [architecture],
  )
  // Open fully on first load and whenever the context changes the forest.
  useEffect(() => {
    setExpandedNodes(collectIds(roots))
  }, [roots])

  const toggleNode = (itemId: string) =>
    setExpandedNodes((previous) => {
      const next = new Set(previous)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })

  const contextLabel =
    versionContext.type === 'main'
      ? 'main'
      : getVersionContextLabel(versionContext)

  // Where a new element is created: this design, under the row clicked, on
  // the branch being viewed when there is one.
  const newElementSearch = (parentId?: string) => ({
    designId,
    ...(parentId && { parentId }),
    ...(versionContext.type === 'branch' &&
      versionContext.branchId && { branch: versionContext.branchId }),
  })

  const columns: Array<ColumnDefinition> = useMemo(
    () => [
      {
        id: 'element',
        label: 'Element',
        width: 'flex-[2] min-w-[220px]',
        renderCell: (node) => (
          <>
            <ItemLink
              itemType="SystemElement"
              itemId={node.itemId}
              className="font-medium font-mono text-blue-600 hover:underline dark:text-blue-400 truncate"
            >
              {node.itemNumber}
            </ItemLink>
            <span className="truncate text-slate-600 dark:text-slate-400">
              {node.name}
            </span>
          </>
        ),
      },
      {
        id: 'kind',
        label: 'Kind',
        width: 'w-28 flex-shrink-0',
        renderCell: (node) => (
          <Badge variant="outline" className="text-xs">
            {elementKindLabel(elementById.get(node.itemId)?.elementKind)}
          </Badge>
        ),
      },
      {
        id: 'realizedBy',
        label: 'Realized by',
        width: 'flex-[2] min-w-[180px]',
        renderCell: (node) => (
          <LinkChips
            links={elementById.get(node.itemId)?.realizedBy ?? []}
            labels={REALIZATION_SUSPECT_LABELS}
            empty="not yet realized"
          />
        ),
      },
      {
        id: 'requirements',
        label: 'Requirements',
        width: 'flex-[2] min-w-[180px]',
        renderCell: (node) => (
          <LinkChips
            links={elementById.get(node.itemId)?.allocatedRequirements ?? []}
            labels={ALLOCATION_SUSPECT_LABELS}
            empty="—"
          />
        ),
      },
      {
        id: 'rev',
        label: 'Rev',
        width: 'w-14 flex-shrink-0',
        align: 'center',
        renderCell: (node) => (
          <span className="text-xs text-slate-500">{node.revision}</span>
        ),
      },
      {
        id: 'state',
        label: 'State',
        width: 'w-28 flex-shrink-0',
        renderCell: (node) => (
          <StateBadge itemType="SystemElement" state={node.state} />
        ),
      },
      {
        id: 'actions',
        label: '',
        width: 'w-10 flex-shrink-0',
        align: 'center',
        renderCell: (node) =>
          isHistoricalView ? null : (
            <Link
              to="/system-elements/new"
              search={newElementSearch(node.itemId)}
              title={`Add a child element under ${node.itemNumber}`}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-slate-200 hover:text-slate-900 dark:hover:bg-slate-700 dark:hover:text-white"
            >
              <Plus className="h-3.5 w-3.5" />
            </Link>
          ),
      },
    ],
    [designId, elementById, isHistoricalView, versionContext],
  )

  if (isPending) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-slate-500">
          Loading the architecture…
        </CardContent>
      </Card>
    )
  }
  if (isError) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-red-600 dark:text-red-400">
          The architecture could not be loaded.
        </CardContent>
      </Card>
    )
  }

  const { totals } = architecture

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle>Architecture</CardTitle>
            <CardDescription>
              {totals.elements} element{totals.elements === 1 ? '' : 's'} in{' '}
              {designCode} · {totals.realized} realized · {totals.allocated}{' '}
              with requirements
              {totals.suspect > 0 && (
                <span className="ml-1 text-amber-600 dark:text-amber-400">
                  · {totals.suspect} suspect link
                  {totals.suspect === 1 ? '' : 's'}
                </span>
              )}
              {versionContext.type !== 'main' && (
                <span className="ml-2 text-amber-600 dark:text-amber-400">
                  (viewing {contextLabel})
                </span>
              )}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-md border dark:border-slate-700">
              <Button
                variant={view === 'tree' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setView('tree')}
              >
                <ListTree className="h-4 w-4 mr-1" />
                Tree
              </Button>
              <Button
                variant={view === 'diagram' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setView('diagram')}
                data-testid="architecture-view-diagram"
              >
                <Workflow className="h-4 w-4 mr-1" />
                Block diagram
              </Button>
              <Button
                variant={view === 'graph' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setView('graph')}
              >
                <GitFork className="h-4 w-4 mr-1" />
                Graph
              </Button>
            </div>
            {view === 'tree' && roots.length > 0 && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setExpandedNodes(collectIds(roots))}
                  title="Expand all"
                >
                  <ChevronsUpDown className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setExpandedNodes(new Set())}
                  title="Collapse all"
                >
                  <ChevronsDownUp className="h-4 w-4" />
                </Button>
              </>
            )}
            {!isHistoricalView && (
              <Link to="/system-elements/new" search={newElementSearch()}>
                <Button size="sm">
                  <Plus className="h-4 w-4 mr-2" />
                  New element
                </Button>
              </Link>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {view === 'diagram' && (roots.length > 0 || !isHistoricalView) ? (
          // Offered on an empty design too: the diagram is where the first
          // block can be added.
          <ArchitectureBlockDiagram
            designId={designId}
            architecture={architecture}
            branchId={
              versionContext.type === 'branch'
                ? versionContext.branchId
                : undefined
            }
            readOnly={isHistoricalView}
          />
        ) : roots.length === 0 ? (
          <div className="text-center py-8 text-slate-500 dark:text-slate-400">
            {versionContext.type === 'main'
              ? 'This design has no system elements yet. Create the system, then decompose it into segments, subsystems and modules; allocate requirements to them before any part exists.'
              : 'This design has no system elements at this context.'}
          </div>
        ) : view === 'graph' ? (
          <ArchitectureGraphView architecture={architecture} />
        ) : (
          <BomTreeView
            nodes={roots}
            expandedNodes={expandedNodes}
            onToggle={toggleNode}
            layout="grid"
            columns={columns}
            showQuantity={false}
            showExternalBadge={false}
            readOnly
          />
        )}
      </CardContent>
    </Card>
  )
}
