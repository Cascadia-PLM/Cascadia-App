// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * A viewable CAD file reachable from a part, either uploaded to the part
 * itself (`direct`) or inherited from a CAD Document it references
 * (`cad_doc`, which is why the entry carries the source item's identity).
 */
export interface CADFileEntry {
  id: string
  fileName: string
  fileType: string
  isPrimaryModel: boolean
  hasColors: boolean
  source: 'direct' | 'cad_doc'
  sourceItemId: string
  sourceItemNumber: string | null
}
