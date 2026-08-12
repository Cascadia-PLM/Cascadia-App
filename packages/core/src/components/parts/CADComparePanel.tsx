// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Eye, EyeOff, Loader2, X } from 'lucide-react'
import type { CADComparisonDisplay } from './CADViewer'
import type { ModelVersionEntry } from '@/lib/query'
import {
  Button,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'

interface CADComparePanelProps {
  /** Versions of this part's master, from itemModelVersionsQuery */
  versions: Array<ModelVersionEntry>
  isLoading: boolean
  /** Key of the selected comparison entry, or null when none */
  selectedKey: string | null
  onSelect: (key: string | null) => void
  display: CADComparisonDisplay
  onDisplayChange: (display: CADComparisonDisplay) => void
  /** File id of the model currently shown, to mark it un-comparable */
  currentFileId: string | null
  onClose: () => void
}

/** Human label for a version entry in the comparison picker. */
export function modelVersionLabel(entry: ModelVersionEntry): string {
  if (entry.kind === 'branch') {
    const branchName = (entry.branch?.name ?? 'branch').replace(
      /^(eco|workspace|release)\//,
      '',
    )
    const name = entry.branch?.changeOrderNumber ?? branchName
    const qualifier =
      entry.branch?.branchType === 'workspace' ? 'workspace' : 'in work'
    return `${name} (${qualifier})`
  }
  const revision = `Rev ${entry.revision}`
  return entry.kind === 'current'
    ? `${revision} — current`
    : `${revision} — ${entry.state}`
}

function suffixFor(
  entry: ModelVersionEntry,
  currentFileId: string | null,
): string {
  if (!entry.file) return ' — no 3D model'
  if (currentFileId !== null && entry.file.id === currentFileId) {
    return ' — shown'
  }
  return ''
}

function OverlayControls({
  label,
  color,
  opacity,
  visible,
  onOpacityChange,
  onVisibleChange,
}: {
  label: string
  color: string
  opacity: number
  visible: boolean
  onOpacityChange: (opacity: number) => void
  onVisibleChange: (visible: boolean) => void
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
          style={{ backgroundColor: color }}
        />
        <span className="flex-1 text-xs font-medium text-slate-700 dark:text-slate-300">
          {label}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => onVisibleChange(!visible)}
          title={
            visible
              ? `Hide ${label.toLowerCase()}`
              : `Show ${label.toLowerCase()}`
          }
        >
          {visible ? (
            <Eye className="h-3.5 w-3.5" />
          ) : (
            <EyeOff className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
      <input
        type="range"
        min={10}
        max={100}
        step={5}
        value={Math.round(opacity * 100)}
        onChange={(e) => onOpacityChange(Number(e.target.value) / 100)}
        disabled={!visible}
        className="mt-1 w-full h-1.5 cursor-pointer accent-blue-500 disabled:opacity-40"
        aria-label={`${label} opacity`}
      />
    </div>
  )
}

/**
 * Floating panel inside the 3D viewer for picking a version to overlay and
 * tuning the overlay's opacity/visibility. Versions come from the part's
 * master: in-work branch models (parallel ECOs, workspaces) and released
 * revisions, each already resolved to the model that context displays.
 */
export function CADComparePanel({
  versions,
  isLoading,
  selectedKey,
  onSelect,
  display,
  onDisplayChange,
  currentFileId,
  onClose,
}: CADComparePanelProps) {
  const branchEntries = versions.filter((v) => v.kind === 'branch')
  const revisionEntries = versions.filter((v) => v.kind !== 'branch')
  const selected = selectedKey
    ? versions.find((v) => v.key === selectedKey)
    : undefined

  const selectable = (entry: ModelVersionEntry) =>
    entry.file !== null &&
    (currentFileId === null || entry.file.id !== currentFileId)

  const renderEntry = (entry: ModelVersionEntry) => (
    <SelectItem
      key={entry.key}
      value={entry.key}
      disabled={!selectable(entry)}
      className="text-xs"
    >
      {modelVersionLabel(entry)}
      {suffixFor(entry, currentFileId)}
    </SelectItem>
  )

  return (
    <div className="absolute bottom-4 right-4 z-20 w-72 bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">
          Compare versions
        </p>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onClose}
          title="Close comparison"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-1">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Loading versions…
          </p>
        </div>
      ) : versions.every((v) => !selectable(v)) ? (
        <p className="text-xs text-slate-600 dark:text-slate-400">
          No other version of this part has a 3D model to compare against.
        </p>
      ) : (
        <Select
          value={selectedKey ?? ''}
          onValueChange={(key) => onSelect(key === '' ? null : key)}
        >
          <SelectTrigger
            className="w-full h-8 text-xs"
            data-testid="cad-compare-version-trigger"
          >
            <SelectValue placeholder="Select a version to overlay…" />
          </SelectTrigger>
          <SelectContent>
            {branchEntries.length > 0 && (
              <SelectGroup>
                <SelectLabel>In work</SelectLabel>
                {branchEntries.map(renderEntry)}
              </SelectGroup>
            )}
            {revisionEntries.length > 0 && (
              <SelectGroup>
                <SelectLabel>Revisions</SelectLabel>
                {revisionEntries.map(renderEntry)}
              </SelectGroup>
            )}
          </SelectContent>
        </Select>
      )}

      {selected?.file && (
        <div className="space-y-2 pt-1 border-t border-slate-200 dark:border-slate-700">
          <OverlayControls
            label="Current model"
            color={display.baseColor}
            opacity={display.baseOpacity}
            visible={display.baseVisible}
            onOpacityChange={(baseOpacity) =>
              onDisplayChange({ ...display, baseOpacity })
            }
            onVisibleChange={(baseVisible) =>
              onDisplayChange({ ...display, baseVisible })
            }
          />
          <OverlayControls
            label={modelVersionLabel(selected)}
            color={display.compareColor}
            opacity={display.compareOpacity}
            visible={display.compareVisible}
            onOpacityChange={(compareOpacity) =>
              onDisplayChange({ ...display, compareOpacity })
            }
            onVisibleChange={(compareVisible) =>
              onDisplayChange({ ...display, compareVisible })
            }
          />
        </div>
      )}
    </div>
  )
}
