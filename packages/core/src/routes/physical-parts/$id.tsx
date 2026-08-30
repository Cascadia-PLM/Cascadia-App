// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { BadgeCheck, GitCompareArrows, GitFork, Package } from 'lucide-react'
import type {
  AsBuiltLine,
  GenealogyNode,
  PhysicalPartEvidenceLink,
} from '@/lib/query'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'
import { PageContainer } from '@/components/layout'
import { DigitalThreadNavigator } from '@/components/thread'
import { FileList, FileUploadZone } from '@/components/vault'
import { apiFetch } from '@/lib/api/client'
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import {
  itemTextSearchQuery,
  physicalPartAsBuiltQuery,
  physicalPartDetailQuery,
  physicalPartEvidenceQuery,
  physicalPartGenealogyQuery,
  useInvalidateResources,
} from '@/lib/query'

export const Route = createFileRoute('/physical-parts/$id')({
  component: PhysicalPartDetailPage,
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(physicalPartDetailQuery(params.id)),
})

const STATES = ['Available', 'Consumed', 'In Service', 'Scrapped']

function PhysicalPartDetailPage() {
  const { id } = Route.useParams()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const { data: physicalPart } = useQuery(physicalPartDetailQuery(id))

  if (!physicalPart) return null

  const handleStateChange = async (state: string) => {
    try {
      await apiFetch(`/api/v1/physical-parts/${physicalPart.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ state }),
      })
      showSuccess('State updated', `${physicalPart.itemNumber} → ${state}`)
      await invalidate('physical-parts')
    } catch (error) {
      handleError(error)
    }
  }

  const identityLabel =
    physicalPart.instanceKind === 'unit' ? 'Serial Number' : 'Lot Number'
  const identityValue = physicalPart.serialNumber ?? physicalPart.lotNumber

  return (
    <PageContainer>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-slate-900 dark:text-white">
          <Package className="h-6 w-6" />
          <div>
            <h1 className="text-2xl font-semibold">
              {physicalPart.itemNumber}
              <Badge variant="outline" className="ml-3 align-middle">
                {physicalPart.instanceKind === 'unit' ? 'Unit' : 'Lot'}
              </Badge>
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {physicalPart.name}
            </p>
          </div>
        </div>
        <Select value={physicalPart.state} onValueChange={handleStateChange}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Identity</CardTitle>
            <CardDescription>
              Traceability identity — immutable after registration
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500 dark:text-slate-400">
                {identityLabel}
              </span>
              <span className="font-mono font-medium">{identityValue}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500 dark:text-slate-400">Part</span>
              <span>
                <span className="font-medium">
                  {physicalPart.partItemNumber}
                </span>
                {physicalPart.partName && (
                  <span className="ml-2 text-slate-500 dark:text-slate-400">
                    {physicalPart.partName}
                  </span>
                )}
              </span>
            </div>
            {physicalPart.erpRef && (
              <div className="flex justify-between">
                <span className="text-slate-500 dark:text-slate-400">
                  ERP Ref
                </span>
                <span className="font-mono">{physicalPart.erpRef}</span>
              </div>
            )}
            {physicalPart.producingWorkOrderId && (
              <div className="flex justify-between">
                <span className="text-slate-500 dark:text-slate-400">
                  Produced by
                </span>
                <Link
                  to="/work-orders/$id"
                  params={{ id: physicalPart.producingWorkOrderId }}
                  className="underline underline-offset-2"
                >
                  Work Order
                </Link>
              </div>
            )}
            {physicalPart.notes && (
              <div className="pt-2">
                <span className="text-slate-500 dark:text-slate-400">
                  Notes
                </span>
                <p className="mt-1 whitespace-pre-wrap">{physicalPart.notes}</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Documents</CardTitle>
            <CardDescription>
              Material certs, test reports, CoCs — the qualification evidence
              for this {physicalPart.instanceKind}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FileUploadZone
              itemId={physicalPart.id}
              onUploadComplete={() => invalidate('files')}
            />
            <FileList itemId={physicalPart.id} />
          </CardContent>
        </Card>
      </div>

      <EvidenceCard physicalPartId={physicalPart.id} />

      <GenealogyCard physicalPartId={physicalPart.id} />

      {physicalPart.producingWorkOrderId && (
        <AsBuiltComparisonCard physicalPartId={physicalPart.id} />
      )}

      <DigitalThreadNavigator
        itemId={physicalPart.id}
        itemNumber={physicalPart.itemNumber}
        itemName={physicalPart.name}
      />
    </PageContainer>
  )
}

interface RequirementSuggestion {
  id: string
  itemNumber: string
  name?: string | null
}

function EvidenceCard({ physicalPartId }: { physicalPartId: string }) {
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const [query, setQuery] = useState('')
  const [note, setNote] = useState('')

  const { data } = useQuery(physicalPartEvidenceQuery(physicalPartId))

  // Requirement typeahead. The debounced term is part of the key, so typing
  // costs one request per pause and re-typing a term resolves from cache.
  const debouncedQuery = useDebouncedValue(query.trim(), 250)
  const { data: suggestions = [] } = useQuery(
    itemTextSearchQuery<RequirementSuggestion>(
      { q: debouncedQuery, types: ['Requirement'], limit: 8 },
      debouncedQuery.length >= 2,
    ),
  )

  const handleAdd = async (requirement: RequirementSuggestion) => {
    try {
      await apiFetch(`/api/v1/physical-parts/${physicalPartId}/evidence`, {
        method: 'POST',
        body: JSON.stringify({
          requirementId: requirement.id,
          note: note.trim() || undefined,
        }),
      })
      showSuccess('Evidence linked', `${requirement.itemNumber} evidenced`)
      setQuery('')
      setNote('')
      await invalidate('physical-parts')
    } catch (error) {
      handleError(error)
    }
  }

  const handleRemove = async (link: PhysicalPartEvidenceLink) => {
    try {
      await apiFetch(
        `/api/v1/physical-parts/${physicalPartId}/evidence/${link.edgeId}`,
        { method: 'DELETE' },
      )
      await invalidate('physical-parts')
    } catch (error) {
      handleError(error)
    }
  }

  const links = data ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BadgeCheck className="h-4 w-4" />
          Requirement Evidence
        </CardTitle>
        <CardDescription>
          Assert which requirements this instance&rsquo;s certifications satisfy
          — these assertions drive the work order qualification rollup
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search requirement to evidence…"
            />
            {suggestions.length > 0 && (
              <div className="absolute z-10 mt-1 w-full rounded-md border border-slate-300 bg-white shadow-md dark:border-slate-700 dark:bg-slate-950">
                {suggestions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                    onClick={() => handleAdd(s)}
                  >
                    <span className="font-medium">{s.itemNumber}</span>
                    {s.name && (
                      <span className="ml-2 text-slate-500 dark:text-slate-400">
                        {s.name}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (e.g. 'mill cert §1.2.3')"
            className="max-w-xs"
          />
        </div>

        {links.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No requirement evidence asserted yet.
          </p>
        ) : (
          <ul className="space-y-1">
            {links.map((link) => (
              <li
                key={link.edgeId}
                className="flex items-center justify-between rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
              >
                <div>
                  <span className="font-medium">{link.requirementNumber}</span>
                  {link.requirementName && (
                    <span className="ml-2 text-slate-500 dark:text-slate-400">
                      {link.requirementName}
                    </span>
                  )}
                  {link.note && (
                    <span className="ml-2 italic text-slate-500 dark:text-slate-400">
                      — {link.note}
                    </span>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRemove(link)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function GenealogyNodeList({ nodes }: { nodes: Array<GenealogyNode> }) {
  if (nodes.length === 0) return null
  return (
    <ul className="ml-4 space-y-1 border-l border-slate-300 pl-3 dark:border-slate-700">
      {nodes.map((node) => (
        <li key={`${node.itemId}-${node.workOrder?.id ?? ''}`}>
          <div className="text-sm">
            {node.kind === 'bulk' ? (
              <span>
                <span className="font-medium">{node.partItemNumber}</span>
                {node.partName && (
                  <span className="ml-1 text-slate-500 dark:text-slate-400">
                    {node.partName}
                  </span>
                )}
              </span>
            ) : (
              <Link
                to="/physical-parts/$id"
                params={{ id: node.itemId }}
                className="font-mono underline-offset-2 hover:underline"
              >
                {node.serialNumber
                  ? `SN ${node.serialNumber}`
                  : `Lot ${node.lotNumber}`}
              </Link>
            )}
            {node.kind !== 'bulk' && node.partItemNumber && (
              <span className="ml-2 text-slate-500 dark:text-slate-400">
                {node.partItemNumber}
              </span>
            )}
            {node.quantity !== null && node.quantity !== 1 && (
              <span className="ml-2 text-slate-500 dark:text-slate-400">
                × {node.quantity}
              </span>
            )}
            {node.workOrder && (
              <Link
                to="/work-orders/$id"
                params={{ id: node.workOrder.id }}
                className="ml-2 text-xs text-slate-500 dark:text-slate-400 underline-offset-2 hover:underline"
              >
                {node.workOrder.itemNumber}
              </Link>
            )}
          </div>
          <GenealogyNodeList nodes={node.children} />
        </li>
      ))}
    </ul>
  )
}

const AS_BUILT_STATUS: Record<
  AsBuiltLine['status'],
  { label: string; className: string }
> = {
  match: {
    label: 'Match',
    className:
      'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  },
  missing: {
    label: 'Missing',
    className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  },
  extra: {
    label: 'Extra',
    className:
      'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  },
  quantity_mismatch: {
    label: 'Qty mismatch',
    className:
      'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  },
}

function AsBuiltComparisonCard({ physicalPartId }: { physicalPartId: string }) {
  const { data } = useQuery(physicalPartAsBuiltQuery(physicalPartId))

  if (!data) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitCompareArrows className="h-4 w-4" />
          As-Designed vs As-Built
        </CardTitle>
        <CardDescription>
          BOM of the built revision
          {data.asBuiltItem &&
            ` (${data.asBuiltItem.itemNumber} Rev ${data.asBuiltItem.revision})`}{' '}
          against what the producing work order consumed
          {data.producedUnitCount > 1 &&
            ` — quantities span the batch of ${data.producedUnitCount} units`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data.lines.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            The built revision has no BOM and no materials were consumed.
          </p>
        ) : (
          <ul className="space-y-1">
            {data.lines.map((line) => (
              <li
                key={line.partMasterId}
                className="flex items-center justify-between rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
              >
                <div>
                  <span className="font-medium">{line.partItemNumber}</span>
                  {line.partName && (
                    <span className="ml-2 text-slate-500 dark:text-slate-400">
                      {line.partName}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-slate-500 dark:text-slate-400">
                    designed {line.designedQuantity ?? '—'} · consumed{' '}
                    {line.consumedQuantity ?? '—'}
                  </span>
                  <Badge
                    variant="secondary"
                    className={AS_BUILT_STATUS[line.status].className}
                  >
                    {AS_BUILT_STATUS[line.status].label}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function GenealogyCard({ physicalPartId }: { physicalPartId: string }) {
  const { data } = useQuery(physicalPartGenealogyQuery(physicalPartId))

  const composition = data?.composition ?? []
  const whereUsed = data?.whereUsed ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitFork className="h-4 w-4" />
          Genealogy
        </CardTitle>
        <CardDescription>
          Derived from work order consumption and production records
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-medium">
              Composition — what went into this
            </h3>
            {composition.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                No production record yet.
              </p>
            ) : (
              <GenealogyNodeList nodes={composition} />
            )}
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium">
              Where used — what this went into
            </h3>
            {whereUsed.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Not consumed by any work order.
              </p>
            ) : (
              <GenealogyNodeList nodes={whereUsed} />
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
