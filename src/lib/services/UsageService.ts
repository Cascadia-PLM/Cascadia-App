import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { notDeleted } from '../db/filters'
import {
  documents,
  items,
  parts,
  requirements,
  tasks,
  testCases,
  testPlans,
} from '../db/schema/items'
import { NotFoundError } from '../errors'
import type { BaseItem } from '../items/types/base'

/**
 * Transaction client type for database operations
 */
type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Field inheritance mode for Definition/Usage pattern
 */
export type InheritanceMode =
  | 'inherit' // Value comes from definition at query time
  | 'copy' // Value copied from definition at creation, can diverge
  | 'usage-only' // Field only exists on usage, no inheritance

/**
 * Configuration for how fields are inherited for a specific item type
 */
export interface FieldInheritanceConfig {
  fieldName: string
  mode: InheritanceMode
}

/**
 * Full inheritance configuration for an item type
 */
export interface ItemTypeInheritanceConfig {
  itemType: string
  fields: Array<FieldInheritanceConfig>
}

/**
 * Input for creating a usage item
 */
export interface CreateUsageInput {
  /** ID of the definition item (or usage that will be resolved to its definition) */
  definitionId: string
  /** Target design where the usage will be created */
  targetDesignId: string
  /** Optional field overrides for the new usage */
  overrides?: {
    itemNumber?: string
    name?: string
    /** Type-specific overrides (parts, documents, requirements, etc.) */
    typeSpecific?: Record<string, unknown>
  }
}

/**
 * Result of creating a usage item
 */
export interface CreateUsageResult {
  /** The newly created usage item */
  usage: typeof items.$inferSelect
  /** The resolved definition item */
  definition: typeof items.$inferSelect
  /** Type-specific data that was copied/inherited */
  typeData: Record<string, unknown> | null
}

/**
 * Resolved usage item with inherited values merged from definition
 */
export interface ResolvedUsageItem extends BaseItem {
  /** The definition this usage references */
  definitionId: string
  /** Whether each field was inherited or is a local override */
  fieldSources?: Record<string, 'inherited' | 'local'>
}

/**
 * SysML type mapping for definition/usage pattern
 */
interface SysmlTypeMapping {
  definition: string
  usage: string
}

/**
 * UsageService - Centralized service for SysML v2 Definition/Usage pattern
 *
 * Implements the SysML v2 Definition/Usage pattern where:
 * - Definitions are canonical items (typically in Library designs)
 * - Usages reference definitions and can have local overrides
 *
 * Key features:
 * - Automatic sysmlType assignment based on usageOf field
 * - Hybrid value inheritance (some fields inherited at query time, others copied)
 * - Definition resolution (follows usageOf chain to find canonical definition)
 */
export class UsageService {
  /**
   * SysML type mappings for each Cascadia item type
   */
  private static readonly SYSML_TYPE_MAP: Record<string, SysmlTypeMapping> = {
    Part: { definition: 'PartDefinition', usage: 'PartUsage' },
    Document: { definition: 'ItemDefinition', usage: 'ItemUsage' },
    Requirement: {
      definition: 'RequirementDefinition',
      usage: 'RequirementUsage',
    },
    Task: { definition: 'ActionDefinition', usage: 'ActionUsage' },
    TestPlan: { definition: 'ActionDefinition', usage: 'ActionUsage' },
    TestCase: { definition: 'ActionDefinition', usage: 'ActionUsage' },
  }

  /**
   * Inheritance configuration for Part fields
   */
  private static readonly PART_INHERITANCE: ItemTypeInheritanceConfig = {
    itemType: 'Part',
    fields: [
      { fieldName: 'description', mode: 'inherit' },
      { fieldName: 'material', mode: 'inherit' },
      { fieldName: 'weight', mode: 'inherit' },
      { fieldName: 'weightUnit', mode: 'inherit' },
      { fieldName: 'partType', mode: 'copy' },
      { fieldName: 'cost', mode: 'copy' },
      { fieldName: 'costCurrency', mode: 'copy' },
      { fieldName: 'leadTimeDays', mode: 'copy' },
      { fieldName: 'quantityOnHand', mode: 'usage-only' },
      { fieldName: 'reorderPoint', mode: 'usage-only' },
      { fieldName: 'location', mode: 'usage-only' },
      { fieldName: 'lastInventoryCheck', mode: 'usage-only' },
    ],
  }

  /**
   * Inheritance configuration for Document fields
   * All fields are inherited (same file reference)
   */
  private static readonly DOCUMENT_INHERITANCE: ItemTypeInheritanceConfig = {
    itemType: 'Document',
    fields: [
      { fieldName: 'description', mode: 'inherit' },
      { fieldName: 'fileId', mode: 'inherit' },
      { fieldName: 'fileName', mode: 'inherit' },
      { fieldName: 'fileSize', mode: 'inherit' },
      { fieldName: 'mimeType', mode: 'inherit' },
      { fieldName: 'storagePath', mode: 'inherit' },
    ],
  }

  /**
   * Inheritance configuration for Requirement fields
   */
  private static readonly REQUIREMENT_INHERITANCE: ItemTypeInheritanceConfig = {
    itemType: 'Requirement',
    fields: [
      { fieldName: 'description', mode: 'inherit' },
      { fieldName: 'type', mode: 'inherit' },
      { fieldName: 'acceptanceCriteria', mode: 'inherit' },
      { fieldName: 'source', mode: 'inherit' },
      { fieldName: 'category', mode: 'inherit' },
      { fieldName: 'verificationMethod', mode: 'inherit' },
      { fieldName: 'priority', mode: 'copy' },
      { fieldName: 'status', mode: 'usage-only' },
      { fieldName: 'verificationStatus', mode: 'usage-only' },
      { fieldName: 'allocatedDesignId', mode: 'usage-only' },
      { fieldName: 'parentRequirementId', mode: 'usage-only' },
    ],
  }

  /**
   * Inheritance configuration for Task fields
   */
  private static readonly TASK_INHERITANCE: ItemTypeInheritanceConfig = {
    itemType: 'Task',
    fields: [
      { fieldName: 'description', mode: 'inherit' },
      { fieldName: 'programId', mode: 'usage-only' },
      { fieldName: 'parentTaskId', mode: 'usage-only' },
      { fieldName: 'assignee', mode: 'usage-only' },
      { fieldName: 'priority', mode: 'copy' },
      { fieldName: 'dueDate', mode: 'usage-only' },
      { fieldName: 'estimatedHours', mode: 'copy' },
      { fieldName: 'actualHours', mode: 'usage-only' },
      { fieldName: 'tags', mode: 'copy' },
    ],
  }

  // ============================================================================
  // Core Creation Methods
  // ============================================================================

  /**
   * Create a usage item that references a definition.
   *
   * @param input - The creation input
   * @param userId - The user creating the usage
   * @param tx - Optional transaction client
   * @returns The created usage with its resolved definition
   */
  static async createUsage(
    input: CreateUsageInput,
    userId: string,
    tx?: TransactionClient,
  ): Promise<CreateUsageResult> {
    const client = tx ?? db

    // 1. Resolve the canonical definition (follows usageOf chain)
    const definition = await this.resolveDefinition(input.definitionId, client)
    if (!definition) {
      throw new NotFoundError('Definition', input.definitionId, {
        operation: 'createUsage',
      })
    }

    // 2. Get inheritance config for item type
    const inheritConfig = this.getInheritanceConfig(definition.itemType)

    // 3. Determine the sysmlType for the new usage
    const sysmlType = this.getSysmlType(definition.itemType, true)

    // 4. Build usage item data
    const usageData = {
      masterId: randomUUID(),
      designId: input.targetDesignId,
      usageOf: definition.id, // Always point to resolved definition
      itemNumber: input.overrides?.itemNumber ?? definition.itemNumber,
      revision: '-', // Fresh start for usage
      itemType: definition.itemType,
      name: input.overrides?.name ?? definition.name,
      state: 'Draft',
      sysmlType: sysmlType,
      metamodel: definition.metamodel ?? 'cascadia',
      isCurrent: true,
      inDesignStructure: definition.inDesignStructure,
      attributes: definition.attributes,
      createdBy: userId,
      modifiedBy: userId,
    }

    // 5. Insert usage item
    const [usage] = await client.insert(items).values(usageData).returning()

    // 6. Copy type-specific data (respecting inherit vs copy config)
    const typeData = await this.copyTypeSpecificData(
      client,
      definition,
      usage.id,
      inheritConfig,
      input.overrides?.typeSpecific,
    )

    return { usage, definition, typeData }
  }

  /**
   * Create multiple usage items in a batch (more efficient for bulk operations)
   *
   * @param inputs - Array of creation inputs
   * @param userId - The user creating the usages
   * @param tx - Optional transaction client
   * @returns Array of created usages with their resolved definitions
   */
  static async createUsagesBatch(
    inputs: Array<CreateUsageInput>,
    userId: string,
    tx?: TransactionClient,
  ): Promise<Array<CreateUsageResult>> {
    const results: Array<CreateUsageResult> = []

    // Use transaction if not provided
    if (tx) {
      for (const input of inputs) {
        const result = await this.createUsage(input, userId, tx)
        results.push(result)
      }
    } else {
      await db.transaction(async (txClient) => {
        for (const input of inputs) {
          const result = await this.createUsage(input, userId, txClient)
          results.push(result)
        }
      })
    }

    return results
  }

  // ============================================================================
  // Definition Resolution
  // ============================================================================

  /**
   * Resolve the canonical definition for an item.
   * If the item is a usage, follows the usageOf chain to find the definition.
   * If the item is already a definition, returns it directly.
   *
   * @param itemId - The item ID to resolve
   * @param client - Optional transaction client
   * @returns The resolved definition item or null if not found
   */
  static async resolveDefinition(
    itemId: string,
    client?: TransactionClient,
  ): Promise<typeof items.$inferSelect | null> {
    const dbClient = client ?? db

    // Get the item
    const [item] = await dbClient
      .select()
      .from(items)
      .where(and(eq(items.id, itemId), notDeleted()))
      .limit(1)

    if (!item) {
      return null
    }

    // If item has usageOf, follow the chain
    if (item.usageOf) {
      return this.resolveDefinition(item.usageOf, client)
    }

    // Item is a definition
    return item
  }

  // ============================================================================
  // Query Methods with Inheritance
  // ============================================================================

  /**
   * Get a usage item with inherited values merged from its definition.
   *
   * Fields with 'inherit' mode will show the definition's value.
   * Fields with 'copy' or 'usage-only' mode will show the usage's value.
   *
   * @param usageId - The usage item ID
   * @returns The resolved usage item with merged values or null if not found
   */
  static async getUsageWithInheritance(
    usageId: string,
  ): Promise<ResolvedUsageItem | null> {
    // Get the usage item
    const [usage] = await db
      .select()
      .from(items)
      .where(and(eq(items.id, usageId), notDeleted()))
      .limit(1)

    if (!usage) {
      return null
    }

    // If not a usage, return as-is
    if (!usage.usageOf) {
      const typeData = await this.getTypeSpecificData(usage.itemType, usage.id)
      return {
        ...usage,
        ...typeData,
        definitionId: usage.id, // Self-referential for definitions
      } as ResolvedUsageItem
    }

    // Get the definition
    const definition = await this.resolveDefinition(usage.usageOf)
    if (!definition) {
      // Definition not found, return usage with its own values
      const typeData = await this.getTypeSpecificData(usage.itemType, usage.id)
      return {
        ...usage,
        ...typeData,
        definitionId: usage.usageOf,
      } as ResolvedUsageItem
    }

    // Get inheritance config
    const inheritConfig = this.getInheritanceConfig(usage.itemType)

    // Get type-specific data for both usage and definition
    const usageTypeData = await this.getTypeSpecificData(
      usage.itemType,
      usage.id,
    )
    const defTypeData = await this.getTypeSpecificData(
      definition.itemType,
      definition.id,
    )

    // Merge values based on inheritance config
    const mergedTypeData: Record<string, unknown> = {}
    const fieldSources: Record<string, 'inherited' | 'local'> = {}

    for (const fieldConfig of inheritConfig.fields) {
      const usageValue = usageTypeData?.[fieldConfig.fieldName]
      const defValue = defTypeData?.[fieldConfig.fieldName]

      if (fieldConfig.mode === 'inherit') {
        // Use definition value (inherited)
        mergedTypeData[fieldConfig.fieldName] = defValue
        fieldSources[fieldConfig.fieldName] = 'inherited'
      } else {
        // Use usage value (copy or usage-only)
        mergedTypeData[fieldConfig.fieldName] = usageValue
        fieldSources[fieldConfig.fieldName] = 'local'
      }
    }

    return {
      ...usage,
      ...mergedTypeData,
      definitionId: definition.id,
      fieldSources,
    } as ResolvedUsageItem
  }

  /**
   * Get all usages of a definition.
   *
   * @param definitionId - The definition item ID
   * @param options - Optional filters
   * @returns Array of usage items
   */
  static async getUsagesOfDefinition(
    definitionId: string,
    options?: { designId?: string },
  ): Promise<Array<typeof items.$inferSelect>> {
    // Resolve to the canonical definition first
    const definition = await this.resolveDefinition(definitionId)
    if (!definition) {
      return []
    }

    // Build query conditions
    const conditions = [eq(items.usageOf, definition.id)]

    // Filter by design if specified
    if (options?.designId) {
      // Note: need to add designId condition
      const usages = await db
        .select()
        .from(items)
        .where(and(...conditions, notDeleted()))
      return usages.filter((u) => u.designId === options.designId)
    }

    return db
      .select()
      .from(items)
      .where(and(...conditions, notDeleted()))
  }

  /**
   * Get the count of usages for a definition.
   *
   * @param definitionId - The definition item ID
   * @returns The usage count
   */
  static async getUsageCount(definitionId: string): Promise<number> {
    // Resolve to the canonical definition first
    const definition = await this.resolveDefinition(definitionId)
    if (!definition) {
      return 0
    }

    const [result] = await db
      .select({ count: sql<number>`count(*)` })
      .from(items)
      .where(and(eq(items.usageOf, definition.id), notDeleted()))

    return Number(result.count)
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Check if an item is a usage (has usageOf set)
   */
  static isUsage(item: { usageOf?: string | null }): boolean {
    return item.usageOf != null
  }

  /**
   * Check if an item is a definition (usageOf is null)
   */
  static isDefinition(item: { usageOf?: string | null }): boolean {
    return item.usageOf == null
  }

  /**
   * Get the appropriate SysML type for an item type.
   *
   * @param itemType - The Cascadia item type (Part, Document, etc.)
   * @param isUsage - Whether this is a usage (true) or definition (false)
   * @returns The SysML type string
   */
  static getSysmlType(itemType: string, isUsage: boolean): string | null {
    const mapping = this.SYSML_TYPE_MAP[itemType]
    if (!mapping) {
      return null
    }
    return isUsage ? mapping.usage : mapping.definition
  }

  /**
   * Get the inheritance configuration for an item type.
   *
   * @param itemType - The Cascadia item type
   * @returns The inheritance configuration
   */
  static getInheritanceConfig(itemType: string): ItemTypeInheritanceConfig {
    switch (itemType) {
      case 'Part':
        return this.PART_INHERITANCE
      case 'Document':
        return this.DOCUMENT_INHERITANCE
      case 'Requirement':
        return this.REQUIREMENT_INHERITANCE
      case 'Task':
        return this.TASK_INHERITANCE
      default:
        // Default: all fields are copied
        return { itemType, fields: [] }
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Copy type-specific data from definition to usage, respecting inheritance config.
   */
  private static async copyTypeSpecificData(
    client: TransactionClient | typeof db,
    definition: typeof items.$inferSelect,
    usageItemId: string,
    inheritConfig: ItemTypeInheritanceConfig,
    overrides?: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    // Get definition's type-specific data
    const defTypeData = await this.getTypeSpecificData(
      definition.itemType,
      definition.id,
      client,
    )

    if (!defTypeData) {
      return null
    }

    // Build the data to insert, respecting inheritance config
    const insertData: Record<string, unknown> = { itemId: usageItemId }

    // For 'copy' and 'inherit' fields, copy from definition
    // For 'usage-only' fields, use null (or override if provided)
    for (const fieldConfig of inheritConfig.fields) {
      if (fieldConfig.mode === 'usage-only') {
        // Usage-only fields start as null unless overridden
        insertData[fieldConfig.fieldName] =
          overrides?.[fieldConfig.fieldName] ?? null
      } else {
        // Copy from definition (both 'inherit' and 'copy' modes)
        // For 'inherit', this is the initial value; queries will use definition value
        // For 'copy', this becomes the usage's own value that can diverge
        insertData[fieldConfig.fieldName] =
          overrides?.[fieldConfig.fieldName] ??
          defTypeData[fieldConfig.fieldName] ??
          null
      }
    }

    // Insert into appropriate type-specific table
    await this.insertTypeSpecificDataInternal(
      client,
      definition.itemType,
      insertData,
    )

    return insertData
  }

  /**
   * Get type-specific data for an item
   */
  private static async getTypeSpecificData(
    itemType: string,
    itemId: string,
    client?: TransactionClient | typeof db,
  ): Promise<Record<string, unknown> | null> {
    const dbClient = client ?? db

    switch (itemType) {
      case 'Part': {
        const [part] = await dbClient
          .select()
          .from(parts)
          .where(eq(parts.itemId, itemId))
          .limit(1)
        return part as Record<string, unknown> | null
      }
      case 'Document': {
        const [doc] = await dbClient
          .select()
          .from(documents)
          .where(eq(documents.itemId, itemId))
          .limit(1)
        return doc as Record<string, unknown> | null
      }
      case 'Requirement': {
        const [req] = await dbClient
          .select()
          .from(requirements)
          .where(eq(requirements.itemId, itemId))
          .limit(1)
        return req as Record<string, unknown> | null
      }
      case 'Task': {
        const [task] = await dbClient
          .select()
          .from(tasks)
          .where(eq(tasks.itemId, itemId))
          .limit(1)
        return task as Record<string, unknown> | null
      }
      case 'TestPlan': {
        const [tp] = await dbClient
          .select()
          .from(testPlans)
          .where(eq(testPlans.itemId, itemId))
          .limit(1)
        return tp as Record<string, unknown> | null
      }
      case 'TestCase': {
        const [tc] = await dbClient
          .select()
          .from(testCases)
          .where(eq(testCases.itemId, itemId))
          .limit(1)
        return tc as Record<string, unknown> | null
      }
      default:
        return null
    }
  }

  /**
   * Insert type-specific data into the appropriate table
   */
  private static async insertTypeSpecificDataInternal(
    client: TransactionClient | typeof db,
    itemType: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    switch (itemType) {
      case 'Part':
        await client.insert(parts).values({
          itemId: data.itemId as string,
          description: (data.description as string | undefined) ?? null,
          partType: (data.partType as string | undefined) ?? null,
          material: (data.material as string | undefined) ?? null,
          weight: (data.weight as string | undefined) ?? null,
          weightUnit: (data.weightUnit as string | undefined) ?? null,
          cost: (data.cost as string | undefined) ?? null,
          costCurrency: (data.costCurrency as string | undefined) ?? null,
          leadTimeDays: (data.leadTimeDays as number | undefined) ?? null,
          quantityOnHand: (data.quantityOnHand as number | undefined) ?? null,
          reorderPoint: (data.reorderPoint as number | undefined) ?? null,
          location: (data.location as string | undefined) ?? null,
          lastInventoryCheck:
            (data.lastInventoryCheck as Date | undefined) ?? null,
        })
        break
      case 'Document':
        await client.insert(documents).values({
          itemId: data.itemId as string,
          description: (data.description as string | undefined) ?? null,
          fileId: (data.fileId as string | undefined) ?? null,
          fileName: (data.fileName as string | undefined) ?? null,
          fileSize: (data.fileSize as number | undefined) ?? null,
          mimeType: (data.mimeType as string | undefined) ?? null,
          storagePath: (data.storagePath as string | undefined) ?? null,
        })
        break
      case 'Requirement':
        await client.insert(requirements).values({
          itemId: data.itemId as string,
          description: (data.description as string | undefined) ?? null,
          type: (data.type as string | undefined) ?? null,
          priority: (data.priority as string | undefined) ?? null,
          status: (data.status as string | undefined) ?? null,
          acceptanceCriteria:
            (data.acceptanceCriteria as string | undefined) ?? null,
          source: (data.source as string | undefined) ?? null,
          category: (data.category as string | undefined) ?? null,
          verificationMethod:
            (data.verificationMethod as string | undefined) ?? null,
          verificationStatus:
            (data.verificationStatus as string | undefined) ?? null,
          allocatedDesignId:
            (data.allocatedDesignId as string | undefined) ?? null,
          parentRequirementId:
            (data.parentRequirementId as string | undefined) ?? null,
        })
        break
      case 'Task':
        await client.insert(tasks).values({
          itemId: data.itemId as string,
          programId: (data.programId as string | undefined) ?? null,
          parentTaskId: (data.parentTaskId as string | undefined) ?? null,
          description: (data.description as string | undefined) ?? null,
          assignee: (data.assignee as string | undefined) ?? null,
          priority: (data.priority as string | undefined) ?? null,
          dueDate: (data.dueDate as Date | undefined) ?? null,
          estimatedHours: (data.estimatedHours as string | undefined) ?? null,
          actualHours: (data.actualHours as string | undefined) ?? null,
          tags: (data.tags as Record<string, unknown> | undefined) ?? null,
        })
        break
      case 'TestPlan':
        await client.insert(testPlans).values({
          itemId: data.itemId as string,
          scope: (data.scope as string | undefined) ?? null,
          environment: (data.environment as string | undefined) ?? null,
          entryCriteria: (data.entryCriteria as string | undefined) ?? null,
          exitCriteria: (data.exitCriteria as string | undefined) ?? null,
          status: (data.status as string | undefined) ?? null,
        })
        break
      case 'TestCase':
        await client.insert(testCases).values({
          itemId: data.itemId as string,
          testPlanId: (data.testPlanId as string | undefined) ?? null,
          testType: (data.testType as string | undefined) ?? null,
          preconditions: (data.preconditions as string | undefined) ?? null,
          steps: (data.steps as Array<unknown> | undefined) ?? null,
          executionStatus: (data.executionStatus as string | undefined) ?? null,
          lastExecutedAt: (data.lastExecutedAt as Date | undefined) ?? null,
          lastExecutedBy: (data.lastExecutedBy as string | undefined) ?? null,
          environment: (data.environment as string | undefined) ?? null,
        })
        break
    }
  }
}
