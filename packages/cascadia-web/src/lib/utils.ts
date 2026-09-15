// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { clsx } from 'clsx'
import type { ClassValue } from 'clsx'

/**
 * Utility function to merge class names
 * Useful for conditional styling and merging Tailwind classes
 */
export function cn(...inputs: Array<ClassValue>) {
  return clsx(inputs)
}
