/**
 * SysML 2.0 JSON Serializer
 * Converts between Cascadia items and SysML 2.0 API JSON format
 */

import { CASCADIA_TO_SYSML_MAP, SYSML_TO_CASCADIA_MAP } from './types'
import type { SysMLElementType } from './types'

/**
 * SysML Element JSON structure
 */
export interface SysMLElement {
  '@id': string
  '@type': string
  name?: string
  declaredName?: string
  qualifiedName?: string
  ownedElement?: Array<{ '@id': string }>
  ownedRelationship?: Array<SysMLRelationship>
  owner?: { '@id': string }
  // Custom attributes from JSONB
  [key: string]: unknown
}

/**
 * SysML Relationship JSON structure
 */
export interface SysMLRelationship {
  '@id': string
  '@type': string
  source?: Array<{ '@id': string }>
  target?: Array<{ '@id': string }>
  multiplicity?: {
    lower?: number
    upper?: number | '*'
  }
  isComposite?: boolean
  relatedElement?: Array<{ '@id': string }>
}

/**
 * SysML Project JSON structure
 */
export interface SysMLProject {
  '@id': string
  '@type': 'Project'
  name: string
  description?: string
  created: string
  defaultBranch?: {
    '@id': string
    name: string
  }
}

/**
 * SysML Commit JSON structure
 */
export interface SysMLCommit {
  '@id': string
  '@type': 'Commit'
  created: string
  owningProject: { '@id': string }
  previousCommit?: { '@id': string }
  change?: Array<{
    '@id': string
    '@type': string
  }>
}

/**
 * SysML Branch JSON structure
 */
export interface SysMLBranch {
  '@id': string
  '@type': 'Branch'
  name: string
  head?: { '@id': string }
  owningProject: { '@id': string }
  created: string
}

/**
 * Cascadia item with extended fields
 */
interface CascadiaItem {
  id: string
  masterId?: string
  itemNumber: string
  revision: string
  itemType: string
  name?: string | null
  state?: string
  sysmlType?: string | null
  metamodel?: string | null
  attributes?: Record<string, unknown> | null
  createdAt?: Date
  modifiedAt?: Date
  designId?: string | null
}

/**
 * Cascadia relationship structure
 */
interface CascadiaRelationship {
  id: string
  sourceId: string
  targetId: string
  relationshipType: string
  quantity?: string | null
  isComposite?: boolean | null
  isDirected?: boolean | null
  multiplicityLower?: number | null
  multiplicityUpper?: number | null
  metadata?: Record<string, unknown> | null
}

/**
 * Cascadia design structure
 */
interface CascadiaDesign {
  id: string
  name: string
  code: string
  description?: string | null
  createdAt: Date
}

/**
 * Cascadia branch structure
 */
interface CascadiaBranch {
  id: string
  name: string
  designId: string
  headCommitId?: string | null
  createdAt: Date
}

/**
 * Cascadia commit structure
 */
interface CascadiaCommit {
  id: string
  designId: string
  branchId: string
  parentId?: string | null
  message: string
  createdAt: Date
}

/**
 * Item version change record
 */
interface ItemVersionChange {
  itemId: string
  changeType: string
}

// Standard SysML JSON fields to exclude from attributes
const STANDARD_SYSML_FIELDS = [
  '@id',
  '@type',
  'name',
  'declaredName',
  'qualifiedName',
  'ownedElement',
  'ownedRelationship',
  'owner',
]

/**
 * SysMLSerializer - Convert between Cascadia and SysML 2.0 JSON formats
 */
export class SysMLSerializer {
  /**
   * Convert Cascadia item to SysML Element
   */
  static itemToElement(
    item: CascadiaItem,
    relationships?: Array<CascadiaRelationship>,
    productCode?: string,
  ): SysMLElement {
    const sysmlType = item.sysmlType || CASCADIA_TO_SYSML_MAP[item.itemType]

    const element: SysMLElement = {
      '@id': item.id,
      '@type': sysmlType,
      name: item.name || undefined,
      declaredName: item.itemNumber,
      qualifiedName: productCode
        ? `${productCode}::${item.itemNumber}`
        : item.itemNumber,
      ownedElement: [],
      ownedRelationship:
        relationships?.map((r) => this.relationshipToSysML(r)) || [],
    }

    // Include custom attributes from JSONB (if any)
    if (item.attributes && typeof item.attributes === 'object') {
      Object.entries(item.attributes).forEach(([key, value]) => {
        if (!STANDARD_SYSML_FIELDS.includes(key)) {
          element[key] = value
        }
      })
    }

    return element
  }

  /**
   * Convert Cascadia relationship to SysML Relationship
   */
  static relationshipToSysML(rel: CascadiaRelationship): SysMLRelationship {
    const sysmlRel: SysMLRelationship = {
      '@id': rel.id,
      '@type': rel.relationshipType,
      target: [{ '@id': rel.targetId }],
    }

    if (rel.sourceId) {
      sysmlRel.source = [{ '@id': rel.sourceId }]
    }

    if (rel.isComposite !== null && rel.isComposite !== undefined) {
      sysmlRel.isComposite = rel.isComposite
    }

    if (rel.multiplicityLower !== null && rel.multiplicityLower !== undefined) {
      sysmlRel.multiplicity = {
        lower: rel.multiplicityLower,
        upper: rel.multiplicityUpper === null ? '*' : rel.multiplicityUpper,
      }
    }

    return sysmlRel
  }

  /**
   * Convert Cascadia design to SysML Project
   */
  static designToProject(
    design: CascadiaDesign,
    defaultBranch?: CascadiaBranch | null,
  ): SysMLProject {
    const project: SysMLProject = {
      '@id': design.id,
      '@type': 'Project',
      name: design.name,
      description: design.description || undefined,
      created: design.createdAt.toISOString(),
    }

    if (defaultBranch) {
      project.defaultBranch = {
        '@id': defaultBranch.id,
        name: defaultBranch.name,
      }
    }

    return project
  }

  /**
   * Convert Cascadia branch to SysML Branch
   */
  static branchToSysML(branch: CascadiaBranch): SysMLBranch {
    return {
      '@id': branch.id,
      '@type': 'Branch',
      name: branch.name,
      head: branch.headCommitId ? { '@id': branch.headCommitId } : undefined,
      owningProject: { '@id': branch.designId },
      created: branch.createdAt.toISOString(),
    }
  }

  /**
   * Convert Cascadia commit to SysML Commit
   */
  static commitToSysML(
    commit: CascadiaCommit,
    changes?: Array<ItemVersionChange>,
  ): SysMLCommit {
    const sysmlCommit: SysMLCommit = {
      '@id': commit.id,
      '@type': 'Commit',
      created: commit.createdAt.toISOString(),
      owningProject: { '@id': commit.designId },
    }

    if (commit.parentId) {
      sysmlCommit.previousCommit = { '@id': commit.parentId }
    }

    if (changes && changes.length > 0) {
      sysmlCommit.change = changes.map((c) => ({
        '@id': c.itemId,
        '@type': 'DataVersion',
      }))
    }

    return sysmlCommit
  }

  /**
   * Convert SysML Element to Cascadia item data for creation
   */
  static elementToItem(
    element: SysMLElement,
    designId: string,
  ): {
    itemNumber: string
    name: string
    itemType: string
    sysmlType: string
    metamodel: string
    attributes: Record<string, unknown>
    designId: string
  } {
    const sysmlType = element['@type'] as SysMLElementType
    const cascadiaType = SYSML_TO_CASCADIA_MAP[sysmlType] || 'Part'

    return {
      itemNumber: element.declaredName || element.name || `SYSML-${Date.now()}`,
      name: element.name || element.declaredName || '',
      itemType: cascadiaType || 'Part',
      sysmlType: sysmlType,
      metamodel: 'sysml2',
      attributes: this.extractAttributes(element),
      designId,
    }
  }

  /**
   * Convert SysML Relationship to Cascadia relationship data
   */
  static sysmlToRelationship(
    rel: SysMLRelationship,
    sourceId: string,
  ): {
    sourceId: string
    targetId: string
    relationshipType: string
    isComposite: boolean
    isDirected: boolean
    multiplicityLower: number
    multiplicityUpper: number | null
  } {
    const targetId = rel.target?.[0]?.['@id'] || ''

    return {
      sourceId,
      targetId,
      relationshipType: rel['@type'],
      isComposite: rel.isComposite ?? false,
      isDirected: true,
      multiplicityLower: rel.multiplicity?.lower ?? 1,
      multiplicityUpper:
        rel.multiplicity?.upper === '*'
          ? null
          : (rel.multiplicity?.upper ?? null),
    }
  }

  /**
   * Extract custom attributes from SysML element (excluding standard fields)
   */
  private static extractAttributes(
    element: SysMLElement,
  ): Record<string, unknown> {
    const attributes: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(element)) {
      if (!STANDARD_SYSML_FIELDS.includes(key)) {
        attributes[key] = value
      }
    }

    return attributes
  }

  /**
   * Build qualified name from product code and item hierarchy
   */
  static buildQualifiedName(
    productCode: string,
    itemNumber: string,
    parentPath?: string,
  ): string {
    if (parentPath) {
      return `${productCode}::${parentPath}::${itemNumber}`
    }
    return `${productCode}::${itemNumber}`
  }

  /**
   * Parse qualified name to extract components
   */
  static parseQualifiedName(qualifiedName: string): {
    productCode: string
    path: Array<string>
    itemNumber: string
  } {
    const parts = qualifiedName.split('::')
    return {
      productCode: parts[0] || '',
      path: parts.slice(1, -1),
      itemNumber: parts[parts.length - 1] || '',
    }
  }
}
