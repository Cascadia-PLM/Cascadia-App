/**
 * Item Test Fixtures
 *
 * Factory functions for creating item test data for all item types:
 * - Parts
 * - Documents
 * - Change Orders
 * - Requirements
 * - Tasks
 *
 * @example
 * ```typescript
 * import { createTestPart, insertTestPart, partPresets } from '@test/fixtures/items'
 *
 * // Create in-memory part data
 * const part = createTestPart({ itemNumber: 'PN-001' })
 *
 * // Use presets for common item configurations
 * const assembly = partPresets.assembly()
 *
 * // Insert into test database
 * const { item, part } = await insertTestPart(db, designId, userId)
 * ```
 */

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '@/lib/db/schema'
import {
  changeOrders,
  documents,
  itemRelationships,
  items,
  parts,
  requirements,
  tasks,
} from '@/lib/db/schema'

type DbSchema = typeof schema
type TestDbInstance = PostgresJsDatabase<DbSchema>

// ============================================================================
// Base Item Types
// ============================================================================

/**
 * Base item data (shared by all item types)
 */
export interface TestBaseItem {
  id: string
  masterId: string
  itemNumber: string
  revision: string
  itemType: string
  name: string | null
  state: string
  isCurrent: boolean | null
  createdAt: Date
  createdBy: string
  modifiedAt: Date
  modifiedBy: string
  designId: string | null
  lockedBy: string | null
  lockedAt: Date | null
  // SysML fields
  commitId: string | null
  inDesignStructure: boolean | null
  attributes: Record<string, unknown> | null
  metamodel: string | null
  sysmlType: string | null
  // Soft delete fields
  isDeleted: boolean | null
  deletedAt: Date | null
  deletedBy: string | null
}

/**
 * Input for creating base items
 */
export interface CreateBaseItemInput {
  id?: string
  masterId?: string
  itemNumber?: string
  revision?: string
  name?: string
  state?: string
  isCurrent?: boolean
  lockedBy?: string
  lockedAt?: Date
}

// ============================================================================
// Item Type-Specific Interfaces
// ============================================================================

export interface TestPart {
  itemId: string
  description: string | null
  partType: string | null
  material: string | null
  weight: string | null
  weightUnit: string | null
  cost: string | null
  costCurrency: string | null
  leadTimeDays: number | null
  quantityOnHand: number | null
  reorderPoint: number | null
  location: string | null
  lastInventoryCheck: Date | null
}

export interface TestDocument {
  itemId: string
  description: string | null
  fileId: string | null
  fileName: string | null
  fileSize: number | null
  mimeType: string | null
  storagePath: string | null
}

export interface TestChangeOrder {
  itemId: string
  changeType: string
  priority: string | null
  reasonForChange: string | null
  impactDescription: string | null
  implementationDate: Date | null
  submittedAt: Date | null
  approvedAt: Date | null
  approvedBy: string | null
  implementedAt: Date | null
  closedAt: Date | null
  impactAssessmentStatus: string | null
  riskLevel: string | null
}

export interface TestRequirement {
  itemId: string
  description: string | null
  type: string | null
  priority: string | null
  status: string | null
  acceptanceCriteria: string | null
  source: string | null
  category: string | null
}

export interface TestTask {
  itemId: string
  programId: string | null
  parentTaskId: string | null
  description: string | null
  assignee: string | null
  priority: string | null
  dueDate: Date | null
  estimatedHours: string | null
  actualHours: string | null
  tags: unknown | null
}

export interface TestRelationship {
  id: string
  sourceId: string
  targetId: string
  relationshipType: string
  quantity: string | null
  referenceDesignator: string | null
  findNumber: number | null
  metadata: unknown | null
  createdAt: Date
  createdBy: string
}

// ============================================================================
// Counters for unique values
// ============================================================================

let itemCounter = 0

function nextItemNumber(prefix: string): string {
  itemCounter++
  return `${prefix}-${String(itemCounter).padStart(6, '0')}`
}

// ============================================================================
// Base Item Factory
// ============================================================================

/**
 * Create base item data
 */
export function createBaseItem(
  itemType: string,
  designId: string | null,
  userId: string,
  overrides: CreateBaseItemInput = {},
): TestBaseItem {
  const id = overrides.id ?? crypto.randomUUID()
  const masterId = overrides.masterId ?? id

  const prefixMap: Record<string, string> = {
    Part: 'PN',
    Document: 'DOC',
    ChangeOrder: 'ECO',
    Requirement: 'REQ',
    Task: 'TSK',
  }

  return {
    id,
    masterId,
    itemNumber:
      overrides.itemNumber ?? nextItemNumber(prefixMap[itemType] ?? 'ITM'),
    revision: overrides.revision ?? 'A',
    itemType,
    name: overrides.name ?? `Test ${itemType}`,
    state: overrides.state ?? 'Draft',
    isCurrent: overrides.isCurrent ?? true,
    createdAt: new Date(),
    createdBy: userId,
    modifiedAt: new Date(),
    modifiedBy: userId,
    designId,
    lockedBy: overrides.lockedBy ?? null,
    lockedAt: overrides.lockedAt ?? null,
    // SysML fields
    commitId: null,
    inDesignStructure: true,
    attributes: {},
    metamodel: 'cascadia',
    sysmlType: null,
    // Soft delete fields
    isDeleted: false,
    deletedAt: null,
    deletedBy: null,
  }
}

// ============================================================================
// Part Factory
// ============================================================================

export interface CreatePartInput extends CreateBaseItemInput {
  description?: string
  partType?: 'Manufacture' | 'Purchase' | 'Software' | 'Phantom'
  material?: string
  weight?: number
  weightUnit?: string
  cost?: number
  costCurrency?: string
  leadTimeDays?: number
  quantityOnHand?: number
  reorderPoint?: number
  location?: string
}

/**
 * Create test part data (in-memory only)
 */
export function createTestPart(
  designId: string | null,
  userId: string,
  overrides: CreatePartInput = {},
): {
  item: TestBaseItem
  part: Omit<TestPart, 'lastInventoryCheck'> & { lastInventoryCheck?: Date }
} {
  const item = createBaseItem('Part', designId, userId, overrides)

  return {
    item,
    part: {
      itemId: item.id,
      description: overrides.description ?? 'Test part description',
      partType: overrides.partType ?? 'Manufacture',
      material: overrides.material ?? null,
      weight: overrides.weight?.toString() ?? null,
      weightUnit: overrides.weightUnit ?? null,
      cost: overrides.cost?.toString() ?? null,
      costCurrency: overrides.costCurrency ?? 'USD',
      leadTimeDays: overrides.leadTimeDays ?? null,
      quantityOnHand: overrides.quantityOnHand ?? 0,
      reorderPoint: overrides.reorderPoint ?? null,
      location: overrides.location ?? null,
    },
  }
}

/**
 * Insert test part into database
 */
export async function insertTestPart(
  db: TestDbInstance,
  designId: string | null,
  userId: string,
  overrides: CreatePartInput = {},
): Promise<{ item: TestBaseItem; part: TestPart }> {
  const { item: itemData, part: partData } = createTestPart(
    designId,
    userId,
    overrides,
  )

  const [insertedItem] = await db
    .insert(items)
    .values({
      id: itemData.id,
      masterId: itemData.masterId,
      itemNumber: itemData.itemNumber,
      revision: itemData.revision,
      itemType: itemData.itemType,
      name: itemData.name,
      state: itemData.state,
      isCurrent: itemData.isCurrent,
      createdBy: itemData.createdBy,
      modifiedBy: itemData.modifiedBy,
      designId: itemData.designId,
    })
    .returning()

  const [insertedPart] = await db
    .insert(parts)
    .values({
      itemId: insertedItem.id,
      description: partData.description,
      partType: partData.partType,
      material: partData.material,
      weight: partData.weight,
      weightUnit: partData.weightUnit,
      cost: partData.cost,
      costCurrency: partData.costCurrency,
      leadTimeDays: partData.leadTimeDays,
      quantityOnHand: partData.quantityOnHand,
      reorderPoint: partData.reorderPoint,
      location: partData.location,
    })
    .returning()

  return {
    item: {
      ...insertedItem,
      createdAt: insertedItem.createdAt,
      modifiedAt: insertedItem.modifiedAt,
      lockedAt: insertedItem.lockedAt,
    },
    part: {
      ...insertedPart,
      lastInventoryCheck: insertedPart.lastInventoryCheck,
    },
  }
}

/**
 * Part presets for common scenarios
 */
export const partPresets = {
  /** Simple component part */
  component: (designId: string | null, userId: string) =>
    createTestPart(designId, userId, {
      name: 'Test Component',
      partType: 'Manufacture',
      description: 'A simple component part',
    }),

  /** Purchased/buy part */
  purchased: (designId: string | null, userId: string) =>
    createTestPart(designId, userId, {
      name: 'Purchased Part',
      partType: 'Purchase',
      leadTimeDays: 14,
      cost: 25.99,
      costCurrency: 'USD',
    }),

  /** Assembly (parent in BOM) */
  assembly: (designId: string | null, userId: string) =>
    createTestPart(designId, userId, {
      name: 'Test Assembly',
      partType: 'Manufacture',
      description: 'An assembly containing multiple components',
    }),

  /** Released part */
  released: (designId: string | null, userId: string) =>
    createTestPart(designId, userId, {
      name: 'Released Part',
      state: 'Released',
      revision: 'A',
    }),

  /** Obsolete part */
  obsolete: (designId: string | null, userId: string) =>
    createTestPart(designId, userId, {
      name: 'Obsolete Part',
      state: 'Obsolete',
      isCurrent: false,
    }),
}

// ============================================================================
// Document Factory
// ============================================================================

export interface CreateDocumentInput extends CreateBaseItemInput {
  description?: string
  fileId?: string
  fileName?: string
  fileSize?: number
  mimeType?: string
  storagePath?: string
}

/**
 * Create test document data
 */
export function createTestDocument(
  designId: string | null,
  userId: string,
  overrides: CreateDocumentInput = {},
): { item: TestBaseItem; document: TestDocument } {
  const item = createBaseItem('Document', designId, userId, overrides)

  return {
    item,
    document: {
      itemId: item.id,
      description: overrides.description ?? 'Test document description',
      fileId: overrides.fileId ?? null,
      fileName: overrides.fileName ?? null,
      fileSize: overrides.fileSize ?? null,
      mimeType: overrides.mimeType ?? null,
      storagePath: overrides.storagePath ?? null,
    },
  }
}

/**
 * Insert test document into database
 */
export async function insertTestDocument(
  db: TestDbInstance,
  designId: string | null,
  userId: string,
  overrides: CreateDocumentInput = {},
): Promise<{ item: TestBaseItem; document: TestDocument }> {
  const { item: itemData, document: docData } = createTestDocument(
    designId,
    userId,
    overrides,
  )

  const [insertedItem] = await db
    .insert(items)
    .values({
      id: itemData.id,
      masterId: itemData.masterId,
      itemNumber: itemData.itemNumber,
      revision: itemData.revision,
      itemType: itemData.itemType,
      name: itemData.name,
      state: itemData.state,
      isCurrent: itemData.isCurrent,
      createdBy: itemData.createdBy,
      modifiedBy: itemData.modifiedBy,
      designId: itemData.designId,
    })
    .returning()

  const [insertedDoc] = await db
    .insert(documents)
    .values({
      itemId: insertedItem.id,
      description: docData.description,
      fileId: docData.fileId,
      fileName: docData.fileName,
      fileSize: docData.fileSize,
      mimeType: docData.mimeType,
      storagePath: docData.storagePath,
    })
    .returning()

  return {
    item: {
      ...insertedItem,
      createdAt: insertedItem.createdAt,
      modifiedAt: insertedItem.modifiedAt,
      lockedAt: insertedItem.lockedAt,
    },
    document: insertedDoc,
  }
}

/**
 * Document presets
 */
export const documentPresets = {
  /** PDF document */
  pdf: (designId: string | null, userId: string) =>
    createTestDocument(designId, userId, {
      name: 'Test PDF Document',
      fileName: 'test-document.pdf',
      mimeType: 'application/pdf',
      fileSize: 1024 * 100, // 100KB
    }),

  /** CAD file */
  cad: (designId: string | null, userId: string) =>
    createTestDocument(designId, userId, {
      name: 'Test CAD File',
      fileName: 'assembly.step',
      mimeType: 'application/step',
    }),

  /** Specification document */
  specification: (designId: string | null, userId: string) =>
    createTestDocument(designId, userId, {
      name: 'Product Specification',
      description: 'Detailed product specifications',
    }),
}

// ============================================================================
// Change Order Factory
// ============================================================================

export interface CreateChangeOrderInput extends CreateBaseItemInput {
  changeType?: 'ECO' | 'ECN' | 'ECR'
  priority?: 'low' | 'medium' | 'high' | 'critical'
  reasonForChange?: string
  impactDescription?: string
  implementationDate?: Date
}

/**
 * Create test change order data
 */
export function createTestChangeOrder(
  designId: string | null,
  userId: string,
  overrides: CreateChangeOrderInput = {},
): { item: TestBaseItem; changeOrder: TestChangeOrder } {
  const item = createBaseItem('ChangeOrder', designId, userId, overrides)

  return {
    item,
    changeOrder: {
      itemId: item.id,
      changeType: overrides.changeType ?? 'ECO',
      priority: overrides.priority ?? 'medium',
      reasonForChange: overrides.reasonForChange ?? 'Test change reason',
      impactDescription: overrides.impactDescription ?? null,
      implementationDate: overrides.implementationDate ?? null,
      submittedAt: null,
      approvedAt: null,
      approvedBy: null,
      implementedAt: null,
      closedAt: null,
      impactAssessmentStatus: 'pending',
      riskLevel: null,
    },
  }
}

/**
 * Insert test change order into database
 */
export async function insertTestChangeOrder(
  db: TestDbInstance,
  designId: string | null,
  userId: string,
  overrides: CreateChangeOrderInput = {},
): Promise<{ item: TestBaseItem; changeOrder: TestChangeOrder }> {
  const { item: itemData, changeOrder: coData } = createTestChangeOrder(
    designId,
    userId,
    overrides,
  )

  const [insertedItem] = await db
    .insert(items)
    .values({
      id: itemData.id,
      masterId: itemData.masterId,
      itemNumber: itemData.itemNumber,
      revision: itemData.revision,
      itemType: itemData.itemType,
      name: itemData.name,
      state: itemData.state,
      isCurrent: itemData.isCurrent,
      createdBy: itemData.createdBy,
      modifiedBy: itemData.modifiedBy,
      designId: itemData.designId,
    })
    .returning()

  const [insertedCO] = await db
    .insert(changeOrders)
    .values({
      itemId: insertedItem.id,
      changeType: coData.changeType,
      priority: coData.priority,
      reasonForChange: coData.reasonForChange,
      impactDescription: coData.impactDescription,
      implementationDate: coData.implementationDate,
      impactAssessmentStatus: coData.impactAssessmentStatus,
    })
    .returning()

  return {
    item: {
      ...insertedItem,
      createdAt: insertedItem.createdAt,
      modifiedAt: insertedItem.modifiedAt,
      lockedAt: insertedItem.lockedAt,
    },
    changeOrder: {
      ...insertedCO,
      implementationDate: insertedCO.implementationDate,
      submittedAt: insertedCO.submittedAt,
      approvedAt: insertedCO.approvedAt,
      implementedAt: insertedCO.implementedAt,
      closedAt: insertedCO.closedAt,
    },
  }
}

/**
 * Change order presets
 */
export const changeOrderPresets = {
  /** Engineering Change Order */
  eco: (designId: string | null, userId: string) =>
    createTestChangeOrder(designId, userId, {
      name: 'Engineering Change Order',
      changeType: 'ECO',
    }),

  /** Engineering Change Notice */
  ecn: (designId: string | null, userId: string) =>
    createTestChangeOrder(designId, userId, {
      name: 'Engineering Change Notice',
      changeType: 'ECN',
      priority: 'high',
    }),

  /** Engineering Change Request */
  ecr: (designId: string | null, userId: string) =>
    createTestChangeOrder(designId, userId, {
      name: 'Engineering Change Request',
      changeType: 'ECR',
      priority: 'low',
    }),

  /** Critical change order */
  critical: (designId: string | null, userId: string) =>
    createTestChangeOrder(designId, userId, {
      name: 'Critical Change Order',
      changeType: 'ECO',
      priority: 'critical',
      reasonForChange: 'Safety-critical issue requiring immediate attention',
    }),
}

// ============================================================================
// Requirement Factory
// ============================================================================

export interface CreateRequirementInput extends CreateBaseItemInput {
  description?: string
  type?: string
  priority?: 'low' | 'medium' | 'high' | 'critical'
  status?: string
  acceptanceCriteria?: string
  source?: string
  category?: string
}

/**
 * Create test requirement data
 */
export function createTestRequirement(
  designId: string | null,
  userId: string,
  overrides: CreateRequirementInput = {},
): { item: TestBaseItem; requirement: TestRequirement } {
  const item = createBaseItem('Requirement', designId, userId, overrides)

  return {
    item,
    requirement: {
      itemId: item.id,
      description: overrides.description ?? 'Test requirement description',
      type: overrides.type ?? 'Functional',
      priority: overrides.priority ?? 'medium',
      status: overrides.status ?? 'Open',
      acceptanceCriteria: overrides.acceptanceCriteria ?? null,
      source: overrides.source ?? null,
      category: overrides.category ?? null,
    },
  }
}

/**
 * Insert test requirement into database
 */
export async function insertTestRequirement(
  db: TestDbInstance,
  designId: string | null,
  userId: string,
  overrides: CreateRequirementInput = {},
): Promise<{ item: TestBaseItem; requirement: TestRequirement }> {
  const { item: itemData, requirement: reqData } = createTestRequirement(
    designId,
    userId,
    overrides,
  )

  const [insertedItem] = await db
    .insert(items)
    .values({
      id: itemData.id,
      masterId: itemData.masterId,
      itemNumber: itemData.itemNumber,
      revision: itemData.revision,
      itemType: itemData.itemType,
      name: itemData.name,
      state: itemData.state,
      isCurrent: itemData.isCurrent,
      createdBy: itemData.createdBy,
      modifiedBy: itemData.modifiedBy,
      designId: itemData.designId,
    })
    .returning()

  const [insertedReq] = await db
    .insert(requirements)
    .values({
      itemId: insertedItem.id,
      description: reqData.description,
      type: reqData.type,
      priority: reqData.priority,
      status: reqData.status,
      acceptanceCriteria: reqData.acceptanceCriteria,
      source: reqData.source,
      category: reqData.category,
    })
    .returning()

  return {
    item: {
      ...insertedItem,
      createdAt: insertedItem.createdAt,
      modifiedAt: insertedItem.modifiedAt,
      lockedAt: insertedItem.lockedAt,
    },
    requirement: insertedReq,
  }
}

// ============================================================================
// Task Factory
// ============================================================================

export interface CreateTaskInput extends CreateBaseItemInput {
  description?: string
  programId?: string
  parentTaskId?: string
  assignee?: string
  priority?: 'low' | 'medium' | 'high'
  dueDate?: Date
  estimatedHours?: number
}

/**
 * Create test task data
 */
export function createTestTask(
  userId: string,
  overrides: CreateTaskInput = {},
): { item: TestBaseItem; task: TestTask } {
  // Tasks don't require designId - they are program-specific
  const item = createBaseItem('Task', null, userId, overrides)

  return {
    item,
    task: {
      itemId: item.id,
      programId: overrides.programId ?? null,
      parentTaskId: overrides.parentTaskId ?? null,
      description: overrides.description ?? 'Test task description',
      assignee: overrides.assignee ?? null,
      priority: overrides.priority ?? 'medium',
      dueDate: overrides.dueDate ?? null,
      estimatedHours: overrides.estimatedHours?.toString() ?? null,
      actualHours: null,
      tags: null,
    },
  }
}

/**
 * Insert test task into database
 */
export async function insertTestTask(
  db: TestDbInstance,
  userId: string,
  overrides: CreateTaskInput = {},
): Promise<{ item: TestBaseItem; task: TestTask }> {
  const { item: itemData, task: taskData } = createTestTask(userId, overrides)

  const [insertedItem] = await db
    .insert(items)
    .values({
      id: itemData.id,
      masterId: itemData.masterId,
      itemNumber: itemData.itemNumber,
      revision: itemData.revision,
      itemType: itemData.itemType,
      name: itemData.name,
      state: itemData.state,
      isCurrent: itemData.isCurrent,
      createdBy: itemData.createdBy,
      modifiedBy: itemData.modifiedBy,
      designId: itemData.designId,
    })
    .returning()

  const [insertedTask] = await db
    .insert(tasks)
    .values({
      itemId: insertedItem.id,
      programId: taskData.programId,
      parentTaskId: taskData.parentTaskId,
      description: taskData.description,
      assignee: taskData.assignee,
      priority: taskData.priority,
      dueDate: taskData.dueDate,
      estimatedHours: taskData.estimatedHours,
    })
    .returning()

  return {
    item: {
      ...insertedItem,
      createdAt: insertedItem.createdAt,
      modifiedAt: insertedItem.modifiedAt,
      lockedAt: insertedItem.lockedAt,
    },
    task: {
      ...insertedTask,
      dueDate: insertedTask.dueDate,
    },
  }
}

// ============================================================================
// Relationship Factory
// ============================================================================

/**
 * Create a BOM relationship between two parts
 */
export async function createBOMRelationship(
  db: TestDbInstance,
  parentId: string,
  childId: string,
  userId: string,
  options: { quantity?: number; findNumber?: number } = {},
): Promise<TestRelationship> {
  const [relationship] = await db
    .insert(itemRelationships)
    .values({
      sourceId: parentId,
      targetId: childId,
      relationshipType: 'BOM',
      quantity: options.quantity?.toString() ?? '1',
      findNumber: options.findNumber ?? null,
      createdBy: userId,
    })
    .returning()

  return {
    ...relationship,
    createdAt: relationship.createdAt,
  }
}

/**
 * Create a reference relationship (document to part, etc.)
 */
export async function createReferenceRelationship(
  db: TestDbInstance,
  sourceId: string,
  targetId: string,
  userId: string,
): Promise<TestRelationship> {
  const [relationship] = await db
    .insert(itemRelationships)
    .values({
      sourceId,
      targetId,
      relationshipType: 'Reference',
      createdBy: userId,
    })
    .returning()

  return {
    ...relationship,
    createdAt: relationship.createdAt,
  }
}

/**
 * Create a derivation relationship (requirement derives from requirement)
 */
export async function createDerivationRelationship(
  db: TestDbInstance,
  sourceId: string,
  targetId: string,
  userId: string,
): Promise<TestRelationship> {
  const [relationship] = await db
    .insert(itemRelationships)
    .values({
      sourceId,
      targetId,
      relationshipType: 'Derives',
      createdBy: userId,
    })
    .returning()

  return {
    ...relationship,
    createdAt: relationship.createdAt,
  }
}

// ============================================================================
// Utility: Create Complete BOM Structure
// ============================================================================

export interface BOMStructure {
  assembly: { item: TestBaseItem; part: TestPart }
  components: Array<{ item: TestBaseItem; part: TestPart }>
  relationships: Array<TestRelationship>
}

/**
 * Create a complete BOM structure with an assembly and components
 *
 * @example
 * ```typescript
 * const bom = await createBOMStructure(db, designId, userId, {
 *   componentCount: 5,
 *   assemblyName: 'Main Assembly',
 * })
 * ```
 */
export async function createBOMStructure(
  db: TestDbInstance,
  designId: string | null,
  userId: string,
  options: {
    componentCount?: number
    assemblyName?: string
  } = {},
): Promise<BOMStructure> {
  const componentCount = options.componentCount ?? 3

  // Create assembly
  const assembly = await insertTestPart(db, designId, userId, {
    name: options.assemblyName ?? 'Test Assembly',
    partType: 'Manufacture',
  })

  // Create components
  const components: Array<{ item: TestBaseItem; part: TestPart }> = []
  for (let i = 0; i < componentCount; i++) {
    const component = await insertTestPart(db, designId, userId, {
      name: `Component ${i + 1}`,
      partType: i % 2 === 0 ? 'Manufacture' : 'Purchase',
    })
    components.push(component)
  }

  // Create BOM relationships
  const relationships: Array<TestRelationship> = []
  for (let i = 0; i < components.length; i++) {
    const rel = await createBOMRelationship(
      db,
      assembly.item.id,
      components[i].item.id,
      userId,
      { quantity: i + 1, findNumber: (i + 1) * 10 },
    )
    relationships.push(rel)
  }

  return { assembly, components, relationships }
}
