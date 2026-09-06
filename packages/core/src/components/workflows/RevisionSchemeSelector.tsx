// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { RevisionScheme } from '@/lib/types/lifecycle'
import { NO_REVISION_MARKER } from '@/lib/types/lifecycle'
import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'

interface RevisionSchemeSelectorProps {
  value?: RevisionScheme
  onChange: (scheme: RevisionScheme) => void
  label?: string
}

type SchemeType = 'alpha' | 'numeric' | 'prefixed-numeric' | 'none'

function getSchemeType(scheme?: RevisionScheme): SchemeType {
  if (!scheme) return 'alpha'
  return scheme.type
}

function getPrefix(scheme?: RevisionScheme): string {
  if (scheme?.type === 'prefixed-numeric') return scheme.prefix
  return 'X'
}

function getStartAt(scheme?: RevisionScheme): number {
  if (scheme?.type === 'numeric' || scheme?.type === 'prefixed-numeric') {
    return scheme.startAt ?? 1
  }
  return 1
}

/** Preview of example revision sequence (pure client-side, no server imports) */
function getPreview(type: SchemeType, prefix: string, startAt: number): string {
  const n = (offset: number) => startAt + offset
  switch (type) {
    case 'alpha':
      return 'A, B, C, D, ...'
    case 'numeric':
      return `${n(0)}, ${n(1)}, ${n(2)}, ${n(3)}, ...`
    case 'prefixed-numeric':
      return `${prefix}${n(0)}, ${prefix}${n(1)}, ${prefix}${n(2)}, ...`
    case 'none':
      // Not "(no revision)": a released item does carry a revision under this
      // scheme — the fixed marker — it just never advances.
      return `${NO_REVISION_MARKER} -> ${NO_REVISION_MARKER} (never advances)`
  }
}

export function RevisionSchemeSelector({
  value,
  onChange,
  label = 'Revision Scheme',
}: RevisionSchemeSelectorProps) {
  const schemeType = getSchemeType(value)
  const prefix = getPrefix(value)
  const startAt = getStartAt(value)
  // Only stored when it differs from the default, so existing definitions
  // round-trip byte-for-byte.
  const startAtField = startAt === 1 ? {} : { startAt }

  const handleTypeChange = (type: SchemeType) => {
    switch (type) {
      case 'alpha':
        onChange({ type: 'alpha' })
        break
      case 'numeric':
        onChange({ type: 'numeric', ...startAtField })
        break
      case 'prefixed-numeric':
        onChange({ type: 'prefixed-numeric', prefix, ...startAtField })
        break
      case 'none':
        onChange({ type: 'none' })
        break
    }
  }

  const handlePrefixChange = (newPrefix: string) => {
    onChange({
      type: 'prefixed-numeric',
      prefix: newPrefix || 'X',
      ...startAtField,
    })
  }

  const handleStartAtChange = (raw: string) => {
    const parsed = parseInt(raw, 10)
    const next = Number.isNaN(parsed) || parsed < 0 ? 1 : parsed
    const field = next === 1 ? {} : { startAt: next }
    if (schemeType === 'prefixed-numeric') {
      onChange({ type: 'prefixed-numeric', prefix, ...field })
    } else {
      onChange({ type: 'numeric', ...field })
    }
  }

  return (
    <div className="space-y-2">
      <Label className="text-xs">{label}</Label>
      <Select
        value={schemeType}
        onValueChange={(v) => handleTypeChange(v as SchemeType)}
      >
        <SelectTrigger className="h-8 text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="alpha">Alpha (A, B, C)</SelectItem>
          <SelectItem value="numeric">Numeric (1, 2, 3)</SelectItem>
          <SelectItem value="prefixed-numeric">Prefixed-Numeric</SelectItem>
          <SelectItem value="none">None</SelectItem>
        </SelectContent>
      </Select>

      {schemeType === 'prefixed-numeric' && (
        <div className="space-y-1.5">
          <Label htmlFor="revPrefix" className="text-xs">
            Prefix
          </Label>
          <Input
            id="revPrefix"
            value={prefix}
            onChange={(e) => handlePrefixChange(e.target.value)}
            className="h-8 text-sm"
            placeholder="e.g., X, P, REV"
          />
        </div>
      )}

      {(schemeType === 'numeric' || schemeType === 'prefixed-numeric') && (
        <div className="space-y-1.5">
          <Label htmlFor="revStartAt" className="text-xs">
            Start at
          </Label>
          <Input
            id="revStartAt"
            type="number"
            min={0}
            value={startAt}
            onChange={(e) => handleStartAtChange(e.target.value)}
            className="h-8 text-sm"
          />
        </div>
      )}

      <div className="text-xs text-slate-500 dark:text-slate-400">
        Preview: {getPreview(schemeType, prefix, startAt)}
      </div>
    </div>
  )
}
