// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The relationship catalog: one entry per edge type the application reasons
 * about, declaring what it joins and how it behaves.
 *
 * `item_relationships.relationship_type` is an unvalidated string, and until
 * this module four vocabularies named the same edges without consulting each
 * other: the service constants that are actually stored, a SysML catalog
 * nothing read, the suggestions in the new-relationship dialog, and the
 * per-type UI configs. The catalog is the one place an edge type's identity
 * lives — the stored string, its endpoints and direction, which end answers
 * for it under the edit lock, whether its claim can go stale, and its SysML
 * name — and everything that needs one of those facts derives it from here.
 *
 * Only the types the application gives meaning to are listed. An uncataloged
 * string stays legal: users define their own reference edges, and nothing
 * here restricts them. For a cataloged type, though, the relationship service
 * refuses an edge whose ends are the wrong item types, because a `SATISFIES`
 * stored backwards is not a different claim, it is a claim no reader finds.
 *
 * Stored strings are never renamed. `VERIFIED_BY` reads backwards from its
 * storage direction (the test case is the source) and stays that way; the
 * label and description carry the reading, not the value.
 *
 * Shared by the api (validation, the edit guard, suspect links, the SysML
 * serializer) and the web (the relationship pickers), so it imports nothing.
 */

/**
 * Which end of an edge answers for it under the edit-lock policy.
 *
 * `source`: the edge is the source item's own structure, as a BOM line is the
 * parent's. `target-when-source-exempt`: a traceability claim whose source may
 * carry a Free lifecycle (a test case) sends the rule to its other end when
 * the source is branch-protection exempt, so every trace link write answers to
 * some versioned end — see `items/traceability-relationships.ts` in the api.
 */
export type RelationshipGuardEnd = 'source' | 'target-when-source-exempt'

export interface RelationshipCatalogEntry {
  /** The stored `relationship_type` string. */
  value: string
  /** How the edge reads from its source: "Satisfies", "Verified by". */
  label: string
  /** One sentence, in the source item's voice. */
  description: string
  /** Item types the edge may run from. */
  sourceTypes: ReadonlyArray<string>
  /** Item types the edge may run to. */
  targetTypes: ReadonlyArray<string>
  guardEnd: RelationshipGuardEnd
  /** The claim can go stale when either end revises — see trace-affirmation. */
  suspectable: boolean
  /** A structural (tree) edge, like `BOM`; joins conflict signatures. */
  composite: boolean
  /** The SysML v2 relationship this serializes as, when it has one. */
  sysmlName?: string
}

const SATISFYING_TYPES = ['Part', 'Software', 'Document'] as const

/**
 * What a requirement may be allocated to: the items that can satisfy it, and
 * a system element — the logical home a requirement has before any part
 * exists. The element's own `REALIZED_BY` edge is the second hop to the part,
 * and the requirements matrix shows both.
 */
const ALLOCATION_TARGET_TYPES = [...SATISFYING_TYPES, 'SystemElement'] as const

/** What a system element is realized by: the physical and software items. */
const REALIZING_TYPES = ['Part', 'Software'] as const

export const RELATIONSHIP_CATALOG: ReadonlyArray<RelationshipCatalogEntry> = [
  {
    value: 'SATISFIES',
    label: 'Satisfies',
    description: 'This item satisfies the requirement',
    sourceTypes: SATISFYING_TYPES,
    targetTypes: ['Requirement'],
    guardEnd: 'target-when-source-exempt',
    suspectable: true,
    composite: false,
    sysmlName: 'Satisfy',
  },
  {
    value: 'ALLOCATED_TO',
    label: 'Allocated to',
    description: 'This requirement is allocated to the item that will meet it',
    sourceTypes: ['Requirement'],
    targetTypes: ALLOCATION_TARGET_TYPES,
    guardEnd: 'target-when-source-exempt',
    suspectable: true,
    composite: false,
    sysmlName: 'Allocate',
  },
  {
    value: 'VERIFIED_BY',
    label: 'Verifies',
    description: 'This test case verifies the requirement',
    sourceTypes: ['TestCase'],
    targetTypes: ['Requirement'],
    guardEnd: 'target-when-source-exempt',
    suspectable: true,
    composite: false,
    sysmlName: 'Verify',
  },
  {
    value: 'VALIDATES',
    label: 'Validates',
    description: 'This test case validates the part',
    sourceTypes: ['TestCase'],
    targetTypes: ['Part'],
    guardEnd: 'target-when-source-exempt',
    suspectable: true,
    composite: false,
  },
  {
    value: 'DERIVES_FROM',
    label: 'Derives from',
    description: 'This requirement is derived from the parent requirement',
    sourceTypes: ['Requirement'],
    targetTypes: ['Requirement'],
    guardEnd: 'target-when-source-exempt',
    suspectable: false,
    composite: false,
    sysmlName: 'Derive',
  },
  {
    value: 'DECOMPOSES',
    label: 'Decomposes into',
    description:
      'This system element decomposes into the child element — the architecture tree, which is not the BOM',
    sourceTypes: ['SystemElement'],
    targetTypes: ['SystemElement'],
    guardEnd: 'source',
    suspectable: false,
    // The architecture tree: a structural edge like `BOM`, so it joins the
    // conflict signatures, and the relationship service refuses a cycle.
    composite: true,
    // Serialized as a composite PartUsage owned by the parent's definition.
    sysmlName: 'PartUsage',
  },
  {
    value: 'REALIZED_BY',
    label: 'Realized by',
    description:
      'This system element is realized by the item that implements it',
    sourceTypes: ['SystemElement'],
    targetTypes: REALIZING_TYPES,
    guardEnd: 'source',
    suspectable: true,
    composite: false,
    sysmlName: 'Allocate',
  },
  {
    value: 'CONNECTS',
    label: 'Connects to',
    description:
      'This system element is connected to the other element — an interface between two blocks of the architecture, drawn as a line in the block diagram',
    sourceTypes: ['SystemElement'],
    targetTypes: ['SystemElement'],
    // The connection is the source element's own content, like its children:
    // drawing one inside an ECO needs the source checked out, not the target.
    guardEnd: 'source',
    // An interface is a statement about the architecture, not a trace claim
    // against a revision; it does not go stale when an end revises.
    suspectable: false,
    // Not the tree: connections may cross it freely and may form loops.
    composite: false,
    sysmlName: 'ConnectionUsage',
  },
  {
    value: 'Evidences',
    label: 'Evidences',
    description:
      'This physical instance carries evidence that the requirement was met',
    sourceTypes: ['PhysicalPart'],
    targetTypes: ['Requirement'],
    guardEnd: 'source',
    suspectable: false,
    composite: false,
  },
]

const BY_VALUE: ReadonlyMap<string, RelationshipCatalogEntry> = new Map(
  RELATIONSHIP_CATALOG.map((entry) => [entry.value, entry]),
)

/** The catalog entry for a stored string, or undefined for a user-defined type. */
export function catalogEntry(
  relationshipType: string,
): RelationshipCatalogEntry | undefined {
  return BY_VALUE.get(relationshipType)
}

export function isCatalogedRelationshipType(relationshipType: string): boolean {
  return BY_VALUE.has(relationshipType)
}

/** The cataloged edges an item of `itemType` may be the source of. */
export function catalogEntriesFrom(
  itemType: string,
): Array<RelationshipCatalogEntry> {
  return RELATIONSHIP_CATALOG.filter((entry) =>
    entry.sourceTypes.includes(itemType),
  )
}

/** The cataloged edges an item of `itemType` may be the target of. */
export function catalogEntriesInto(
  itemType: string,
): Array<RelationshipCatalogEntry> {
  return RELATIONSHIP_CATALOG.filter((entry) =>
    entry.targetTypes.includes(itemType),
  )
}

/** The stored strings of every entry `predicate` admits. */
export function catalogValues(
  predicate: (entry: RelationshipCatalogEntry) => boolean,
): ReadonlySet<string> {
  return new Set(
    RELATIONSHIP_CATALOG.filter(predicate).map((entry) => entry.value),
  )
}

/**
 * Why an edge's ends do not fit its cataloged type, or null when they do (or
 * when the type is not cataloged, which the catalog does not police).
 */
export function catalogEndMismatch(
  relationshipType: string,
  sourceItemType: string,
  targetItemType: string,
): string | null {
  const entry = BY_VALUE.get(relationshipType)
  if (!entry) return null
  const sourceOk = entry.sourceTypes.includes(sourceItemType)
  const targetOk = entry.targetTypes.includes(targetItemType)
  if (sourceOk && targetOk) return null
  return (
    `${entry.value} runs ${entry.sourceTypes.join('/')} → ${entry.targetTypes.join('/')}, ` +
    `not ${sourceItemType} → ${targetItemType}`
  )
}
