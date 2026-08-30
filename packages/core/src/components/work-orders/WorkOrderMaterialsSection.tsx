// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { PackageCheck, ScanLine, Trash2 } from 'lucide-react'
import type { WorkOrderMaterial } from '@/lib/query'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui'
import { apiFetch } from '@/lib/api/client'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue'
import {
  itemTextSearchQuery,
  useInvalidateResources,
  workOrderMaterialsQuery,
  workOrderProducedQuery,
} from '@/lib/query'

interface PartSuggestion {
  id: string
  itemNumber: string
  name?: string | null
}

interface SelectedPart {
  masterId: string
  itemNumber: string
  name?: string | null
  trackingMode: 'none' | 'lot' | 'serial'
}

interface WorkOrderMaterialsSectionProps {
  workOrderId: string
  /** Complete/Cancelled orders can no longer change materials */
  readOnly?: boolean
}

/**
 * Consumed materials on a work order — the traceability capture point.
 * Scan-first: pick the part once, then scan serials/lots repeatedly.
 */
export function WorkOrderMaterialsSection({
  workOrderId,
  readOnly = false,
}: WorkOrderMaterialsSectionProps) {
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const [query, setQuery] = useState('')
  const [selectedPart, setSelectedPart] = useState<SelectedPart | null>(null)
  const [identity, setIdentity] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [saving, setSaving] = useState(false)

  const { data: materials } = useQuery(workOrderMaterialsQuery(workOrderId))

  const debouncedQuery = useDebouncedValue(query.trim(), 250)
  const { data: suggestions = [] } = useQuery(
    itemTextSearchQuery<PartSuggestion>(
      { q: debouncedQuery, types: ['Part'], limit: 8 },
      !selectedPart && debouncedQuery.length >= 2,
    ),
  )

  const selectPart = async (suggestion: PartSuggestion) => {
    try {
      const result = await apiFetch<{
        data: {
          part: {
            id: string
            masterId?: string
            itemNumber: string
            name?: string | null
            trackingMode?: 'none' | 'lot' | 'serial'
          }
        }
      }>(`/api/v1/parts/${suggestion.id}`)
      const part = result.data.part
      setSelectedPart({
        masterId: part.masterId ?? part.id,
        itemNumber: part.itemNumber,
        name: part.name,
        trackingMode: part.trackingMode ?? 'none',
      })
    } catch (error) {
      handleError(error)
    }
  }

  const handleConsume = async () => {
    if (!selectedPart) return
    const body: Record<string, unknown> = {
      partMasterId: selectedPart.masterId,
    }
    if (selectedPart.trackingMode === 'serial') {
      if (!identity.trim()) return
      body.serialNumber = identity.trim()
    } else if (selectedPart.trackingMode === 'lot') {
      if (!identity.trim()) return
      body.lotNumber = identity.trim()
      body.quantity = parseFloat(quantity) || 1
    } else {
      body.quantity = parseFloat(quantity) || 1
    }

    setSaving(true)
    try {
      await apiFetch(`/api/v1/work-orders/${workOrderId}/materials`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      showSuccess(
        'Material recorded',
        selectedPart.trackingMode === 'serial'
          ? `${selectedPart.itemNumber} · SN ${identity.trim()}`
          : selectedPart.trackingMode === 'lot'
            ? `${selectedPart.itemNumber} · Lot ${identity.trim()} × ${quantity}`
            : `${selectedPart.itemNumber} × ${quantity}`,
      )
      // Keep the part selected for repeated scanning; clear the identity.
      setIdentity('')
      await invalidate('work-orders')
    } catch (error) {
      handleError(error)
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async (line: WorkOrderMaterial) => {
    try {
      await apiFetch(
        `/api/v1/work-orders/${workOrderId}/materials/${line.edgeId}`,
        { method: 'DELETE' },
      )
      showSuccess(
        'Material removed',
        line.serialNumber
          ? `SN ${line.serialNumber} returned to stock`
          : (line.partItemNumber ?? 'Line removed'),
      )
      await invalidate('work-orders')
    } catch (error) {
      handleError(error)
    }
  }

  const lines = materials ?? []

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Materials</CardTitle>
          <CardDescription>
            What this work order actually consumed — serials and lots recorded
            here are the traceability record
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!readOnly && (
            <div className="space-y-2 rounded-md border p-3">
              {selectedPart ? (
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {selectedPart.itemNumber}
                    </span>
                    <Badge>
                      {selectedPart.trackingMode === 'serial'
                        ? 'Serial'
                        : selectedPart.trackingMode === 'lot'
                          ? 'Lot'
                          : 'Bulk'}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setSelectedPart(null)
                        setIdentity('')
                        setQuery('')
                      }}
                    >
                      Change
                    </Button>
                  </div>
                  {selectedPart.trackingMode !== 'none' && (
                    <div className="min-w-48 flex-1">
                      <Input
                        value={identity}
                        onChange={(e) => setIdentity(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleConsume()
                        }}
                        placeholder={
                          selectedPart.trackingMode === 'serial'
                            ? 'Scan or type serial number…'
                            : 'Lot number…'
                        }
                        autoFocus
                      />
                    </div>
                  )}
                  {selectedPart.trackingMode !== 'serial' && (
                    <div className="w-24">
                      <Input
                        type="number"
                        min="0"
                        step="any"
                        value={quantity}
                        onChange={(e) => setQuantity(e.target.value)}
                      />
                    </div>
                  )}
                  <Button onClick={handleConsume} disabled={saving}>
                    <ScanLine className="mr-1 h-4 w-4" />
                    {saving ? 'Recording…' : 'Record'}
                  </Button>
                </div>
              ) : (
                <div className="relative">
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search part to consume…"
                  />
                  {suggestions.length > 0 && (
                    <div className="absolute z-10 mt-1 w-full rounded-md border bg-popover shadow-md">
                      {suggestions.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          className="block w-full px-3 py-2 text-left text-sm hover:bg-accent"
                          onClick={() => selectPart(s)}
                        >
                          <span className="font-medium">{s.itemNumber}</span>
                          {s.name && (
                            <span className="ml-2 text-muted-foreground">
                              {s.name}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {lines.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No materials recorded yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Part</TableHead>
                  <TableHead>Identity</TableHead>
                  <TableHead>Qty</TableHead>
                  {!readOnly && <TableHead className="w-10"></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((line) => (
                  <TableRow key={line.edgeId}>
                    <TableCell>
                      <span className="font-medium">{line.partItemNumber}</span>
                      {line.partName && (
                        <span className="ml-2 text-muted-foreground">
                          {line.partName}
                        </span>
                      )}
                      {line.kind === 'bulk' && line.partRevision && (
                        <Badge variant="outline" className="ml-2">
                          Rev {line.partRevision}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="font-mono">
                      {line.kind === 'unit' && line.serialNumber ? (
                        <Link
                          to="/physical-parts/$id"
                          params={{ id: line.targetItemId }}
                          className="underline-offset-2 hover:underline"
                        >
                          SN {line.serialNumber}
                        </Link>
                      ) : line.kind === 'lot' && line.lotNumber ? (
                        <Link
                          to="/physical-parts/$id"
                          params={{ id: line.targetItemId }}
                          className="underline-offset-2 hover:underline"
                        >
                          Lot {line.lotNumber}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>{line.quantity}</TableCell>
                    {!readOnly && (
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Remove line"
                          onClick={() => handleRemove(line)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ProducedUnitsCard workOrderId={workOrderId} readOnly={readOnly} />
    </div>
  )
}

function ProducedUnitsCard({
  workOrderId,
  readOnly,
}: {
  workOrderId: string
  readOnly: boolean
}) {
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const [serialsText, setSerialsText] = useState('')
  const [saving, setSaving] = useState(false)

  const { data: produced } = useQuery(workOrderProducedQuery(workOrderId))

  const handleProduce = async () => {
    const serialNumbers = serialsText
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (serialNumbers.length === 0) return
    setSaving(true)
    try {
      await apiFetch(`/api/v1/work-orders/${workOrderId}/produce`, {
        method: 'POST',
        body: JSON.stringify({ serialNumbers }),
      })
      showSuccess(
        'Units recorded',
        `${serialNumbers.length} serial${serialNumbers.length === 1 ? '' : 's'} recorded as built by this work order`,
      )
      setSerialsText('')
      await invalidate('work-orders')
    } catch (error) {
      handleError(error)
    } finally {
      setSaving(false)
    }
  }

  const units = produced ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle>Produced Units</CardTitle>
        <CardDescription>
          Serials built by this work order — each gets an as-built pin to the
          exact part revision and joins the genealogy chain
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!readOnly && (
          <div className="flex gap-2">
            <Input
              value={serialsText}
              onChange={(e) => setSerialsText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleProduce()
              }}
              placeholder="Scan or enter serials (comma-separated for several)…"
            />
            <Button onClick={handleProduce} disabled={saving}>
              <PackageCheck className="mr-1 h-4 w-4" />
              {saving ? 'Recording…' : 'Record'}
            </Button>
          </div>
        )}
        {units.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No produced units recorded yet.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {units.map((unit) => (
              <Link
                key={unit.unitItemId}
                to="/physical-parts/$id"
                params={{ id: unit.unitItemId }}
              >
                <Badge variant="outline" className="font-mono">
                  SN {unit.serialNumber} · {unit.physicalPartNumber}
                </Badge>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
