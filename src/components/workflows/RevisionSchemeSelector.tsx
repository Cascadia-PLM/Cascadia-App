import type { RevisionScheme } from '@/lib/types/lifecycle'
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

/** Preview of example revision sequence (pure client-side, no server imports) */
function getPreview(type: SchemeType, prefix: string): string {
  switch (type) {
    case 'alpha':
      return 'A, B, C, D, ...'
    case 'numeric':
      return '1, 2, 3, 4, ...'
    case 'prefixed-numeric':
      return `${prefix}1, ${prefix}2, ${prefix}3, ...`
    case 'none':
      return '(no revisions)'
  }
}

export function RevisionSchemeSelector({
  value,
  onChange,
  label = 'Revision Scheme',
}: RevisionSchemeSelectorProps) {
  const schemeType = getSchemeType(value)
  const prefix = getPrefix(value)

  const handleTypeChange = (type: SchemeType) => {
    switch (type) {
      case 'alpha':
        onChange({ type: 'alpha' })
        break
      case 'numeric':
        onChange({ type: 'numeric' })
        break
      case 'prefixed-numeric':
        onChange({ type: 'prefixed-numeric', prefix })
        break
      case 'none':
        onChange({ type: 'none' })
        break
    }
  }

  const handlePrefixChange = (newPrefix: string) => {
    onChange({ type: 'prefixed-numeric', prefix: newPrefix || 'X' })
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

      <div className="text-xs text-slate-500 dark:text-slate-400">
        Preview: {getPreview(schemeType, prefix)}
      </div>
    </div>
  )
}
