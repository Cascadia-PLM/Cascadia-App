// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { ArrowUpDown, Eye, EyeOff, Loader2, X } from 'lucide-react'
import type { CADCompareSlot } from './CADViewer'
import type { ModelVersionEntry, ModelVersionFile } from '@/lib/query'
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'

/**
 * What one side of the comparison is showing, and how.
 *
 * Version and file are chosen separately and independently per side: a
 * version says *which* context's geometry, the file says *which model* of
 * that context — a part version can carry several viewable models (an STL
 * and a colored GLB, a simplified rep, a model on a linked CAD Document).
 */
export interface CompareSlotSelection {
  /** `ModelVersionEntry.key`, or null when no version is picked yet */
  versionKey: string | null
  /** Vault file id within that version, or null when it has no model */
  fileId: string | null
  color: string
  /** 0..1 */
  opacity: number
  visible: boolean
}

interface CADComparePanelProps {
  /** Versions of this part's master, from itemModelVersionsQuery */
  versions: Array<ModelVersionEntry>
  isLoading: boolean
  a: CompareSlotSelection
  b: CompareSlotSelection
  onChange: (slot: CADCompareSlot, next: CompareSlotSelection) => void
  onSwap: () => void
  onClose: () => void
}

/**
 * Tints offered per side. Chosen to stay apart from each other in both hue
 * and lightness, so a pair still reads as two models on either viewer
 * background and under red-green color vision deficiency.
 */
export const COMPARE_COLOR_CHOICES = [
  '#3b82f6',
  '#f97316',
  '#10b981',
  '#d946ef',
  '#eab308',
  '#06b6d4',
  '#f43f5e',
  '#94a3b8',
] as const

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

/** Human label for one viewable model within a version. */
export function modelFileLabel(file: ModelVersionFile): string {
  const from = file.sourceItemNumber ? ` (${file.sourceItemNumber})` : ''
  return `${file.fileName}${from}`
}

/** Find the entry a slot points at, and the file within it. */
export function resolveSlot(
  versions: Array<ModelVersionEntry>,
  slot: CompareSlotSelection,
): { entry: ModelVersionEntry | null; file: ModelVersionFile | null } {
  const entry = versions.find((v) => v.key === slot.versionKey) ?? null
  if (!entry) return { entry: null, file: null }
  const file = entry.files.find((f) => f.id === slot.fileId) ?? null
  return { entry, file }
}

function ColorPicker({
  color,
  label,
  onChange,
}: {
  color: string
  label: string
  onChange: (color: string) => void
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className="h-5 w-5 shrink-0 rounded-full border border-slate-300 dark:border-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          style={{ backgroundColor: color }}
        />
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="start">
        <div className="grid grid-cols-4 gap-1.5">
          {COMPARE_COLOR_CHOICES.map((choice) => (
            <button
              key={choice}
              type="button"
              aria-label={choice}
              title={choice}
              onClick={() => onChange(choice)}
              className={`h-6 w-6 rounded-full border ${
                choice.toLowerCase() === color.toLowerCase()
                  ? 'border-slate-900 dark:border-white ring-2 ring-offset-1 ring-slate-400 dark:ring-offset-slate-950'
                  : 'border-slate-300 dark:border-slate-600'
              }`}
              style={{ backgroundColor: choice }}
            />
          ))}
        </div>
        <label className="mt-2 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
          Custom
          <input
            type="color"
            value={color}
            onChange={(e) => onChange(e.target.value)}
            className="h-6 w-10 cursor-pointer rounded border border-slate-300 bg-transparent dark:border-slate-600"
          />
        </label>
      </PopoverContent>
    </Popover>
  )
}

/** One side of the comparison: version, file, color, visibility, opacity. */
function CompareSlot({
  slot,
  selection,
  versions,
  onChange,
}: {
  slot: CADCompareSlot
  selection: CompareSlotSelection
  versions: Array<ModelVersionEntry>
  onChange: (next: CompareSlotSelection) => void
}) {
  const { entry, file } = resolveSlot(versions, selection)
  const branchEntries = versions.filter((v) => v.kind === 'branch')
  const revisionEntries = versions.filter((v) => v.kind !== 'branch')

  // Picking a version picks that version's default model with it, so a side
  // is never left half-chosen; the file select then refines it.
  const selectVersion = (key: string) => {
    const next = versions.find((v) => v.key === key)
    onChange({
      ...selection,
      versionKey: key,
      fileId: next?.files.at(0)?.id ?? null,
    })
  }

  const renderVersion = (v: ModelVersionEntry) => (
    <SelectItem
      key={v.key}
      value={v.key}
      disabled={v.files.length === 0}
      className="text-xs"
    >
      {modelVersionLabel(v)}
      {v.files.length === 0 ? ' — no 3D model' : ''}
    </SelectItem>
  )

  const directFiles = entry?.files.filter((f) => f.source === 'direct') ?? []
  const docFiles = entry?.files.filter((f) => f.source === 'cad_doc') ?? []

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <ColorPicker
          color={selection.color}
          label={`Color for side ${slot}`}
          onChange={(color) => onChange({ ...selection, color })}
        />
        <span className="flex-1 text-xs font-semibold text-slate-700 dark:text-slate-300">
          Side {slot}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          disabled={file === null}
          onClick={() =>
            onChange({ ...selection, visible: !selection.visible })
          }
          title={selection.visible ? `Hide side ${slot}` : `Show side ${slot}`}
        >
          {selection.visible ? (
            <Eye className="h-3.5 w-3.5" />
          ) : (
            <EyeOff className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      <Select value={selection.versionKey ?? ''} onValueChange={selectVersion}>
        <SelectTrigger
          className="w-full h-8 text-xs"
          data-testid={`cad-compare-version-${slot}`}
        >
          <SelectValue placeholder="Pick a version…" />
        </SelectTrigger>
        <SelectContent>
          {branchEntries.length > 0 && (
            <SelectGroup>
              <SelectLabel>In work</SelectLabel>
              {branchEntries.map(renderVersion)}
            </SelectGroup>
          )}
          {revisionEntries.length > 0 && (
            <SelectGroup>
              <SelectLabel>Revisions</SelectLabel>
              {revisionEntries.map(renderVersion)}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>

      <Select
        value={selection.fileId ?? ''}
        disabled={!entry || entry.files.length === 0}
        onValueChange={(fileId) => onChange({ ...selection, fileId })}
      >
        <SelectTrigger
          className="w-full h-8 text-xs"
          data-testid={`cad-compare-file-${slot}`}
        >
          <SelectValue
            placeholder={
              entry ? 'This version has no 3D model' : 'Pick a version first'
            }
          />
        </SelectTrigger>
        <SelectContent>
          {directFiles.length > 0 && (
            <SelectGroup>
              <SelectLabel>On this part</SelectLabel>
              {directFiles.map((f) => (
                <SelectItem key={f.id} value={f.id} className="text-xs">
                  {f.fileName}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {docFiles.length > 0 && (
            <SelectGroup>
              <SelectLabel>On linked CAD documents</SelectLabel>
              {docFiles.map((f) => (
                <SelectItem key={f.id} value={f.id} className="text-xs">
                  {modelFileLabel(f)}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>

      <div className="flex items-center gap-2">
        <span className="text-[11px] text-slate-500 dark:text-slate-400 shrink-0">
          Opacity
        </span>
        <input
          type="range"
          min={10}
          max={100}
          step={5}
          value={Math.round(selection.opacity * 100)}
          onChange={(e) =>
            onChange({ ...selection, opacity: Number(e.target.value) / 100 })
          }
          disabled={!selection.visible || file === null}
          className="flex-1 h-1.5 cursor-pointer accent-blue-500 disabled:opacity-40"
          aria-label={`Side ${slot} opacity`}
        />
        <span className="w-8 text-right text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
          {Math.round(selection.opacity * 100)}%
        </span>
      </div>
    </div>
  )
}

/**
 * Floating panel inside the 3D viewer for comparing two models of the same
 * part.
 *
 * Both sides are picked the same way and neither is privileged: choose a
 * version — released revision, superseded revision, or the working copy on
 * any active ECO/workspace/release branch — then the model within it, then
 * the color and translucency it is drawn in. The viewer renders exactly what
 * the two sides name, so what is on screen is always what the panel says.
 */
export function CADComparePanel({
  versions,
  isLoading,
  a,
  b,
  onChange,
  onSwap,
  onClose,
}: CADComparePanelProps) {
  const withModels = versions.filter((v) => v.files.length > 0)
  const sameFile =
    a.fileId !== null && a.fileId === b.fileId
      ? 'Both sides show the same file — pick a different version or model on one side.'
      : null

  return (
    <div className="absolute bottom-4 right-4 z-20 w-80 bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">
          Compare versions
        </p>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onSwap}
            title="Swap sides A and B"
          >
            <ArrowUpDown className="h-3.5 w-3.5" />
          </Button>
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
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-1">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Loading versions…
          </p>
        </div>
      ) : withModels.length === 0 ? (
        <p className="text-xs text-slate-600 dark:text-slate-400">
          No version of this part has a 3D model to compare.
        </p>
      ) : (
        <>
          <CompareSlot
            slot="A"
            selection={a}
            versions={versions}
            onChange={(next) => onChange('A', next)}
          />
          <div className="border-t border-slate-200 dark:border-slate-700" />
          <CompareSlot
            slot="B"
            selection={b}
            versions={versions}
            onChange={(next) => onChange('B', next)}
          />
          {withModels.length === 1 && (
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Only one version of this part has a 3D model, so both sides can
              only show it.
            </p>
          )}
          {sameFile && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {sameFile}
            </p>
          )}
        </>
      )}
    </div>
  )
}
