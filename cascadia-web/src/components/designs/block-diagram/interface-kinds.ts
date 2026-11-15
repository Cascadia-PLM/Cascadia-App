// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
import { INTERFACE_KINDS } from '@cascadia/commons/items/types/interface'
import type { InterfaceKind } from '@cascadia/commons/items/types/interface'

/**
 * Line colour per interface kind, legible on both the light and the dark
 * canvas. An interface with no kind takes the architecture teal the other
 * graphs draw architecture edges in.
 */
export const INTERFACE_KIND_COLORS: Record<InterfaceKind, string> = {
  power: '#ef4444', // red-500
  data: '#3b82f6', // blue-500
  mechanical: '#64748b', // slate-500
  fluid: '#06b6d4', // cyan-500
  thermal: '#f97316', // orange-500
  other: '#a855f7', // purple-500
}
export const UNKINDED_INTERFACE_COLOR = '#0d9488' // teal-600

export function isInterfaceKind(
  value: string | null | undefined,
): value is InterfaceKind {
  return (
    value != null && (INTERFACE_KINDS as ReadonlyArray<string>).includes(value)
  )
}

export function interfaceColor(kind: string | null | undefined): string {
  return isInterfaceKind(kind)
    ? INTERFACE_KIND_COLORS[kind]
    : UNKINDED_INTERFACE_COLOR
}

/** What a line is labelled with: the interface's name, else its number. */
export function interfaceLabel(item: {
  itemNumber: string
  name: string | null
}): string {
  return item.name || item.itemNumber
}
