// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Represents a changed item in an upstream change notification.
 */
export interface UpstreamChangeItem {
  /** Master ID of the changed item */
  masterId: string
  /** Item number for display */
  itemNumber: string
  /** Item name for display */
  name: string | null
  /** Item type (Part, Document, etc.) */
  itemType: string
  /** Previous revision in source design */
  previousRevision: string
  /** New revision in source design */
  newRevision: string
  /** Type of change: 'modified' | 'added' | 'deleted' */
  changeType: 'modified' | 'added' | 'deleted'
  /** Fields that changed (for 'modified' items) */
  changedFields?: Array<string>
}
