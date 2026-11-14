// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
import {
  SYSTEM_CONNECTION_KINDS,
  SYSTEM_CONNECTION_KIND_LABELS,
} from '@cascadia/commons/items/types/system-element'
import type { SystemConnectionKind } from '@cascadia/commons/items/types/system-element'

/**
 * Line colour per connection kind, legible on both the light and the dark
 * canvas. A connection with no kind takes the architecture teal the other
 * graphs draw architecture edges in.
 */
export const CONNECTION_KIND_COLORS: Record<SystemConnectionKind, string> = {
  power: '#ef4444', // red-500
  data: '#3b82f6', // blue-500
  mechanical: '#64748b', // slate-500
  fluid: '#06b6d4', // cyan-500
  thermal: '#f97316', // orange-500
  other: '#a855f7', // purple-500
}
export const UNKINDED_CONNECTION_COLOR = '#0d9488' // teal-600

export function isConnectionKind(
  value: string | null | undefined,
): value is SystemConnectionKind {
  return (
    value != null &&
    (SYSTEM_CONNECTION_KINDS as ReadonlyArray<string>).includes(value)
  )
}

export function connectionColor(kind: string | null | undefined): string {
  return isConnectionKind(kind)
    ? CONNECTION_KIND_COLORS[kind]
    : UNKINDED_CONNECTION_COLOR
}

/** What a line is labelled with: its name, else its kind, else nothing. */
export function connectionLabel(connection: {
  name: string | null
  kind: string | null
}): string | undefined {
  if (connection.name) return connection.name
  return isConnectionKind(connection.kind)
    ? SYSTEM_CONNECTION_KIND_LABELS[connection.kind]
    : undefined
}
