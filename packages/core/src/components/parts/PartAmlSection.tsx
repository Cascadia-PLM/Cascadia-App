// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus, Star, Trash2 } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@/components/ui'
import { useInvalidateResources } from '@/lib/query'
import { partAmlQuery } from '@/lib/query/options/manufacturer-parts'
import { apiFetch } from '@/lib/api/client'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'

type QualificationStatus = 'proposed' | 'approved' | 'obsolete'

interface AmlSource {
  id: string
  partMasterId: string
  manufacturerPartId: string
  qualificationStatus: QualificationStatus
  isPreferred: boolean
  notes?: string | null
  manufacturerPart: {
    id: string
    manufacturer: string
    mpn: string
    description?: string | null
    datasheetUrl?: string | null
  }
}

interface PartAmlSectionProps {
  /** items.masterId of the part — the AML binds to the lineage, not a version */
  partMasterId: string
  /** Hide mutating controls (e.g., viewer roles) */
  readOnly?: boolean
}

const STATUS_BADGE_VARIANT: Record<QualificationStatus, string> = {
  approved:
    'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  proposed:
    'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  obsolete: 'bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
}

/**
 * Approved Manufacturer List section on the part detail page.
 * Sourcing master data: which manufacturers' products satisfy this part.
 */
export function PartAmlSection({
  partMasterId,
  readOnly = false,
}: PartAmlSectionProps) {
  const invalidate = useInvalidateResources()
  const { handleError, showSuccess } = useErrorHandler()
  const [addOpen, setAddOpen] = useState(false)
  const [manufacturer, setManufacturer] = useState('')
  const [mpn, setMpn] = useState('')
  const [description, setDescription] = useState('')
  const [datasheetUrl, setDatasheetUrl] = useState('')
  const [saving, setSaving] = useState(false)

  const { data, isLoading } = useQuery(partAmlQuery<AmlSource>(partMasterId))

  const sources = data ?? []

  const resetForm = () => {
    setManufacturer('')
    setMpn('')
    setDescription('')
    setDatasheetUrl('')
  }

  const handleAdd = async () => {
    if (!manufacturer.trim() || !mpn.trim()) {
      handleError(new Error('Manufacturer and MPN are required'))
      return
    }
    setSaving(true)
    try {
      await apiFetch(`/api/v1/manufacturer-parts/part/${partMasterId}`, {
        method: 'POST',
        body: JSON.stringify({
          manufacturerPart: {
            manufacturer: manufacturer.trim(),
            mpn: mpn.trim(),
            description: description.trim() || undefined,
            datasheetUrl: datasheetUrl.trim() || undefined,
          },
          // First source on a part defaults to preferred.
          isPreferred: sources.length === 0,
        }),
      })
      showSuccess('Source added', `${manufacturer} ${mpn} added to the AML`)
      setAddOpen(false)
      resetForm()
      await invalidate('manufacturer-parts')
    } catch (error) {
      handleError(error)
    } finally {
      setSaving(false)
    }
  }

  const handleStatusChange = async (
    mappingId: string,
    qualificationStatus: QualificationStatus,
  ) => {
    try {
      await apiFetch(`/api/v1/manufacturer-parts/mappings/${mappingId}`, {
        method: 'PATCH',
        body: JSON.stringify({ qualificationStatus }),
      })
      await invalidate('manufacturer-parts')
    } catch (error) {
      handleError(error)
    }
  }

  const handlePreferred = async (mappingId: string) => {
    try {
      await apiFetch(`/api/v1/manufacturer-parts/mappings/${mappingId}`, {
        method: 'PATCH',
        body: JSON.stringify({ isPreferred: true }),
      })
      await invalidate('manufacturer-parts')
    } catch (error) {
      handleError(error)
    }
  }

  const handleRemove = async (source: AmlSource) => {
    try {
      await apiFetch(`/api/v1/manufacturer-parts/mappings/${source.id}`, {
        method: 'DELETE',
      })
      showSuccess(
        'Source removed',
        `${source.manufacturerPart.manufacturer} ${source.manufacturerPart.mpn} removed from the AML`,
      )
      await invalidate('manufacturer-parts')
    } catch (error) {
      handleError(error)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Approved Sources</CardTitle>
          <CardDescription>
            Manufacturer parts approved to satisfy this part (AML)
          </CardDescription>
        </div>
        {!readOnly && (
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1 h-4 w-4" />
            Add Source
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading sources…</p>
        ) : sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No approved sources yet. Purchased parts should list at least one
            manufacturer part.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"></TableHead>
                <TableHead>Manufacturer</TableHead>
                <TableHead>MPN</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Status</TableHead>
                {!readOnly && <TableHead className="w-10"></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.map((source) => (
                <TableRow key={source.id}>
                  <TableCell>
                    <button
                      type="button"
                      title={
                        source.isPreferred
                          ? 'Preferred source'
                          : 'Make preferred'
                      }
                      disabled={readOnly}
                      onClick={() => handlePreferred(source.id)}
                      className="disabled:cursor-default"
                    >
                      <Star
                        className={
                          source.isPreferred
                            ? 'h-4 w-4 fill-amber-400 text-amber-400'
                            : 'h-4 w-4 text-muted-foreground'
                        }
                      />
                    </button>
                  </TableCell>
                  <TableCell className="font-medium">
                    {source.manufacturerPart.manufacturer}
                  </TableCell>
                  <TableCell>
                    {source.manufacturerPart.datasheetUrl ? (
                      <a
                        href={source.manufacturerPart.datasheetUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2"
                      >
                        {source.manufacturerPart.mpn}
                      </a>
                    ) : (
                      source.manufacturerPart.mpn
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {source.manufacturerPart.description}
                  </TableCell>
                  <TableCell>
                    {readOnly ? (
                      <Badge
                        className={
                          STATUS_BADGE_VARIANT[source.qualificationStatus]
                        }
                      >
                        {source.qualificationStatus}
                      </Badge>
                    ) : (
                      <Select
                        value={source.qualificationStatus}
                        onValueChange={(value) =>
                          handleStatusChange(
                            source.id,
                            value as QualificationStatus,
                          )
                        }
                      >
                        <SelectTrigger className="h-8 w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="proposed">Proposed</SelectItem>
                          <SelectItem value="approved">Approved</SelectItem>
                          <SelectItem value="obsolete">Obsolete</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  </TableCell>
                  {!readOnly && (
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Remove from AML"
                        onClick={() => handleRemove(source)}
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

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Approved Source</DialogTitle>
            <DialogDescription>
              Identify the manufacturer part that satisfies this part. If a
              record with the same manufacturer and MPN already exists it is
              reused.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium">Manufacturer *</label>
                <Input
                  value={manufacturer}
                  onChange={(e) => setManufacturer(e.target.value)}
                  placeholder="Yamaha"
                />
              </div>
              <div>
                <label className="text-sm font-medium">MPN *</label>
                <Input
                  value={mpn}
                  onChange={(e) => setMpn(e.target.value)}
                  placeholder="350XYZ"
                />
              </div>
            </div>
            <div>
              <label className="text-sm font-medium">Description</label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>
            <div>
              <label className="text-sm font-medium">Datasheet URL</label>
              <Input
                value={datasheetUrl}
                onChange={(e) => setDatasheetUrl(e.target.value)}
                placeholder="https://…"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAdd} disabled={saving}>
              {saving ? 'Adding…' : 'Add Source'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
