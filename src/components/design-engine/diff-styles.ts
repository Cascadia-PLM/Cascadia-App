/**
 * Diff status styling for artifact review — visual pattern adapted from
 * the digital-thread diff nodes (ThreadNodeDiff), reworked for list rows.
 */

import { Minus, Move, Plus, RefreshCw } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { DiffStatus } from '@/lib/design-engine/artifact-diff'

export interface DiffStatusStyle {
  row: string
  badge: string
  label: string
  Icon: LucideIcon | null
}

export const DIFF_STATUS_STYLES: Record<DiffStatus, DiffStatusStyle> = {
  added: {
    row: 'border-l-2 border-l-green-500 bg-green-50/50 dark:bg-green-950/30',
    badge: 'bg-green-500 text-white',
    label: 'ADDED',
    Icon: Plus,
  },
  removed: {
    row: 'border-l-2 border-l-red-500 bg-red-50/50 dark:bg-red-950/30',
    badge: 'bg-red-500 text-white',
    label: 'REMOVED',
    Icon: Minus,
  },
  modified: {
    row: 'border-l-2 border-l-amber-500 bg-amber-50/50 dark:bg-amber-950/30',
    badge: 'bg-amber-500 text-white',
    label: 'MODIFIED',
    Icon: RefreshCw,
  },
  unchanged: {
    row: '',
    badge: '',
    label: '',
    Icon: null,
  },
}

export const REPARENTED_ICON = Move
