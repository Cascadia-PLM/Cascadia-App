// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea,
} from '@/components/ui'
import { apiFetch } from '@/lib/api/client'
import { itemTextSearchQuery } from '@/lib/query'
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'

interface PartSuggestion {
  id: string
  itemNumber: string
  name?: string | null
}

interface SelectedPart {
  id: string
  masterId: string
  itemNumber: string
  name?: string | null
  trackingMode: 'none' | 'lot' | 'serial'
}

interface RegisterPhysicalPartDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onRegistered?: () => void
}

/**
 * Register a physical instance: pick a part, enter its serial or lot number
 * (which one is dictated by the part's trackingMode), attach certs afterward
 * on the detail page.
 */
export function RegisterPhysicalPartDialog({
  open,
  onOpenChange,
  onRegistered,
}: RegisterPhysicalPartDialogProps) {
  const { handleError, showSuccess } = useErrorHandler()
  const [query, setQuery] = useState('')
  const [selectedPart, setSelectedPart] = useState<SelectedPart | null>(null)
  const [identity, setIdentity] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [settingTracking, setSettingTracking] = useState(false)

  const handleSetTracking = async (trackingMode: 'serial' | 'lot') => {
    if (!selectedPart) return
    setSettingTracking(true)
    try {
      await apiFetch(`/api/v1/parts/${selectedPart.id}`, {
        method: 'PUT',
        body: JSON.stringify({ trackingMode }),
      })
      showSuccess(
        'Tracking set',
        `${selectedPart.itemNumber} is now ${trackingMode}-tracked`,
      )
      setSelectedPart({ ...selectedPart, trackingMode })
    } catch (error) {
      // Released parts on a protected design need an ECO to change — the
      // API error explains it; surface it as-is.
      handleError(error)
    } finally {
      setSettingTracking(false)
    }
  }

  // Part autocomplete: one request per typing pause, keyed on the settled
  // term, and silent while a part is already chosen.
  const debouncedQuery = useDebouncedValue(query.trim(), 250)
  const { data: suggestions = [] } = useQuery(
    itemTextSearchQuery<PartSuggestion>(
      { q: debouncedQuery, types: ['Part'], limit: 8 },
      open && !selectedPart && debouncedQuery.length >= 2,
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
        id: part.id,
        masterId: part.masterId ?? part.id,
        itemNumber: part.itemNumber,
        name: part.name,
        trackingMode: part.trackingMode ?? 'none',
      })
    } catch (error) {
      handleError(error)
    }
  }

  const reset = () => {
    setQuery('')
    setSelectedPart(null)
    setIdentity('')
    setNotes('')
  }

  const identityKind =
    selectedPart?.trackingMode === 'serial'
      ? 'Serial number'
      : selectedPart?.trackingMode === 'lot'
        ? 'Lot number'
        : null

  const handleRegister = async () => {
    if (!selectedPart || !identity.trim() || !identityKind) return
    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        partMasterId: selectedPart.masterId,
        notes: notes.trim() || undefined,
      }
      if (selectedPart.trackingMode === 'serial') {
        body.serialNumber = identity.trim()
      } else {
        body.lotNumber = identity.trim()
      }
      const result = await apiFetch<{
        data: { created: boolean; physicalPart: { itemNumber: string } }
      }>(`/api/v1/physical-parts/register`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      showSuccess(
        result.data.created ? 'Registered' : 'Already registered',
        `${selectedPart.itemNumber} · ${identity.trim()} (${result.data.physicalPart.itemNumber})`,
      )
      reset()
      onOpenChange(false)
      onRegistered?.()
    } catch (error) {
      handleError(error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register Physical Part</DialogTitle>
          <DialogDescription>
            Record a serialized unit or a lot/batch you physically have.
            Registering the same identity twice returns the existing record.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label>Part *</Label>
            {selectedPart ? (
              <div className="mt-1 flex items-center justify-between rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700">
                <div>
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {selectedPart.itemNumber}
                  </span>
                  {selectedPart.name && (
                    <span className="ml-2 text-sm text-slate-500 dark:text-slate-400">
                      {selectedPart.name}
                    </span>
                  )}
                  <Badge className="ml-2">
                    {selectedPart.trackingMode === 'serial'
                      ? 'Serial tracked'
                      : selectedPart.trackingMode === 'lot'
                        ? 'Lot tracked'
                        : 'Not tracked'}
                  </Badge>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSelectedPart(null)
                    setIdentity('')
                  }}
                >
                  Change
                </Button>
              </div>
            ) : (
              <div className="relative">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by part number or name…"
                />
                {suggestions.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full rounded-md border border-slate-300 bg-white shadow-md dark:border-slate-700 dark:bg-slate-950">
                    {suggestions.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                        onClick={() => selectPart(s)}
                      >
                        <span className="font-medium text-slate-900 dark:text-slate-100">
                          {s.itemNumber}
                        </span>
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
            )}
          </div>

          {selectedPart && identityKind && (
            <div>
              <Label>{identityKind} *</Label>
              <Input
                value={identity}
                onChange={(e) => setIdentity(e.target.value)}
                placeholder={
                  selectedPart.trackingMode === 'serial'
                    ? 'e.g. 2026-0042'
                    : 'e.g. LOT-4137'
                }
                autoFocus
              />
            </div>
          )}

          {selectedPart && !identityKind && (
            <div className="space-y-2 rounded-md border border-amber-300 p-3 dark:border-amber-700">
              <p className="text-sm text-amber-600 dark:text-amber-400">
                {selectedPart.itemNumber} is not tracked yet — choose how its
                physical instances are identified:
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={settingTracking}
                  onClick={() => handleSetTracking('serial')}
                >
                  Serial tracked
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={settingTracking}
                  onClick={() => handleSetTracking('lot')}
                >
                  Lot tracked
                </Button>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Serial: every unit gets its own number (assemblies, expensive
                components). Lot: batches share one number (feedstock, raw
                material). This saves onto the part.
              </p>
            </div>
          )}

          {selectedPart && identityKind && (
            <div>
              <Label>Notes</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleRegister}
            disabled={
              saving || !selectedPart || !identityKind || !identity.trim()
            }
          >
            {saving ? 'Registering…' : 'Register'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
