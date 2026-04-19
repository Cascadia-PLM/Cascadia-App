/**
 * Shared BOM tree types used by EcoTreeTable and StructureTab
 */

export interface BOMTreeNode {
  itemId: string
  masterId?: string // Stable ID across revisions for deduplication
  itemNumber: string
  name: string
  revision: string
  state: string
  itemType: string
  designId: string | null
  quantity?: number
  findNumber?: number
  relationshipId?: string
  children?: Array<BOMTreeNode>

  // Cross-design fields
  designCode?: string
  designName?: string
  isExternal?: boolean

  // ECO-specific fields (used by EcoTreeTable)
  isInEco?: boolean
  changeAction?: string | null // 'release' | 'revise' | 'obsolete' | null

  // Structure-specific fields (used by StructureTab)
  isInWork?: boolean

  // Cross-design reference fields (lightweight link, not usage-copy)
  isCrossDesignRef?: boolean // Is this a cross-design reference root?
  crossReferenceId?: string // ID of the design_cross_references row
}
