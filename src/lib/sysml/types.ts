/**
 * SysML 2.0 Type Definitions
 * Based on OMG SysML v2 specification for API interoperability
 */

/**
 * SysML 2.0 Relationship Types
 * Defines valid relationship types and their semantics
 */
export const SYSML_RELATIONSHIP_TYPES = {
  // Generalization relationships
  Specialization: {
    description: 'Target is a general type of source (inheritance)',
    inverse: 'Generalization',
    isDirected: true,
  },

  // Feature relationships
  FeatureTyping: {
    description: 'Source (usage) is typed by target (definition)',
    inverse: null,
    isDirected: true,
  },
  Subsetting: {
    description: 'Source feature values are subset of target feature values',
    inverse: null,
    isDirected: true,
  },
  Redefinition: {
    description: 'Source feature replaces target feature in specialization',
    inverse: null,
    isDirected: true,
  },

  // Requirement relationships
  Satisfy: {
    description: 'Source element satisfies target requirement',
    inverse: 'SatisfiedBy',
    isDirected: true,
  },
  Verify: {
    description: 'Source test case verifies target requirement',
    inverse: 'VerifiedBy',
    isDirected: true,
  },
  Derive: {
    description: 'Source requirement derived from target requirement',
    inverse: 'DeriveReqt',
    isDirected: true,
  },
  Refine: {
    description: 'Source element refines/elaborates target requirement',
    inverse: 'RefinedBy',
    isDirected: true,
  },
  Trace: {
    description: 'General traceability between elements',
    inverse: 'TracedFrom',
    isDirected: true,
  },

  // Allocation relationships
  Allocate: {
    description: 'Source element allocated to target element',
    inverse: 'AllocatedFrom',
    isDirected: true,
  },

  // PLM relationship types (Cascadia-specific, interoperable)
  BOM: {
    description:
      'Source assembly contains target component (Bill of Materials)',
    inverse: 'UsedIn',
    isDirected: true,
  },
  DocumentReference: {
    description: 'Source item references target document',
    inverse: 'ReferencedBy',
    isDirected: true,
  },
  AffectedItem: {
    description: 'Source change order affects target item',
    inverse: 'AffectedBy',
    isDirected: true,
  },
  DerivedFrom: {
    description: 'Source item derived from target item',
    inverse: 'DerivesTo',
    isDirected: true,
  },
} as const

export type SysMLRelationshipType = keyof typeof SYSML_RELATIONSHIP_TYPES

/**
 * SysML 2.0 Element Types (metaclasses)
 * Maps SysML element types to Cascadia item types
 */
export const SYSML_ELEMENT_TYPES = {
  // Definition types (templates)
  PartDefinition: { category: 'Definition', cascadiaType: 'Part' },
  ItemDefinition: { category: 'Definition', cascadiaType: 'Part' },
  RequirementDefinition: {
    category: 'Definition',
    cascadiaType: 'Requirement',
  },
  ActionDefinition: { category: 'Definition', cascadiaType: 'Task' },
  ConstraintDefinition: { category: 'Definition', cascadiaType: 'Requirement' },
  AttributeDefinition: { category: 'Definition', cascadiaType: null },
  InterfaceDefinition: { category: 'Definition', cascadiaType: 'Part' },
  PortDefinition: { category: 'Definition', cascadiaType: 'Part' },

  // Usage types (instances/occurrences)
  PartUsage: { category: 'Usage', cascadiaType: 'Part' },
  ItemUsage: { category: 'Usage', cascadiaType: 'Part' },
  RequirementUsage: { category: 'Usage', cascadiaType: 'Requirement' },
  ActionUsage: { category: 'Usage', cascadiaType: 'Task' },
  ConstraintUsage: { category: 'Usage', cascadiaType: 'Requirement' },
  AttributeUsage: { category: 'Usage', cascadiaType: null },
  InterfaceUsage: { category: 'Usage', cascadiaType: 'Part' },
  PortUsage: { category: 'Usage', cascadiaType: 'Part' },

  // Package and namespace types (map to null - handled as Products in Cascadia)
  Package: { category: 'Namespace', cascadiaType: null },
  Namespace: { category: 'Namespace', cascadiaType: null },
  LibraryPackage: { category: 'Namespace', cascadiaType: null },
} as const

export type SysMLElementType = keyof typeof SYSML_ELEMENT_TYPES

/**
 * Mapping from Cascadia item types to default SysML types
 */
export const CASCADIA_TO_SYSML_MAP: Record<string, SysMLElementType> = {
  Part: 'PartDefinition',
  Document: 'ItemDefinition',
  Requirement: 'RequirementDefinition',
  Task: 'ActionDefinition',
  ChangeOrder: 'Package',
}

/**
 * Mapping from SysML types to Cascadia item types
 */
export const SYSML_TO_CASCADIA_MAP: Record<string, string | null> =
  Object.entries(SYSML_ELEMENT_TYPES).reduce(
    (acc, [sysmlType, config]) => {
      acc[sysmlType] = config.cascadiaType
      return acc
    },
    {} as Record<string, string | null>,
  )

/**
 * SysML metamodel identifiers
 */
export const SYSML_METAMODELS = {
  CASCADIA: 'cascadia',
  SYSML2: 'sysml2',
  KERML: 'kerml',
} as const

export type SysMLMetamodel =
  (typeof SYSML_METAMODELS)[keyof typeof SYSML_METAMODELS]

/**
 * Check if a relationship type is a valid SysML relationship
 */
export function isSysMLRelationshipType(
  type: string,
): type is SysMLRelationshipType {
  return type in SYSML_RELATIONSHIP_TYPES
}

/**
 * Check if an element type is a valid SysML element
 */
export function isSysMLElementType(type: string): type is SysMLElementType {
  return type in SYSML_ELEMENT_TYPES
}

/**
 * Get the inverse relationship type if one exists
 */
export function getInverseRelationshipType(
  type: SysMLRelationshipType,
): string | null {
  return SYSML_RELATIONSHIP_TYPES[type].inverse ?? null
}

/**
 * Determine if an element type is a Definition or Usage
 */
export function isDefinitionType(type: string): boolean {
  if (!(type in SYSML_ELEMENT_TYPES)) return false
  return SYSML_ELEMENT_TYPES[type as SysMLElementType].category === 'Definition'
}

export function isUsageType(type: string): boolean {
  if (!(type in SYSML_ELEMENT_TYPES)) return false
  return SYSML_ELEMENT_TYPES[type as SysMLElementType].category === 'Usage'
}
