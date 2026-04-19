import {
  boolean,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'
import { users } from './users'
import { partCotsMapping } from './cotsComponents'
import { designs } from './designs'
import { programs } from './programs'
import { branches, commits } from './versioning'

export const items = pgTable(
  'items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    masterId: uuid('master_id').notNull(),
    itemNumber: varchar('item_number', { length: 100 }).notNull(),
    revision: varchar('revision', { length: 10 }).notNull(),
    itemType: varchar('item_type', { length: 50 }).notNull(),
    name: varchar('name', { length: 500 }),
    state: varchar('state', { length: 50 }).notNull().default('Draft'),
    isCurrent: boolean('is_current').default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    modifiedAt: timestamp('modified_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    modifiedBy: uuid('modified_by')
      .notNull()
      .references(() => users.id),
    lockedBy: uuid('locked_by').references(() => users.id),
    lockedAt: timestamp('locked_at', { withTimezone: true }),

    // SysML Migration: Design and version context
    // Nullable at DB level because Tasks and Issues don't require a designId.
    // Part, Document, and Requirement enforce designId as required via Zod schemas.
    designId: uuid('design_id').references(() => designs.id),
    commitId: uuid('commit_id').references(() => commits.id),

    // Design structure membership - when true, part shows as root in BOM tree; when false, shows as orphan
    inDesignStructure: boolean('in_design_structure').default(true),

    // Flexible attributes for SysML and extensibility
    attributes: jsonb('attributes')
      .$type<Record<string, unknown>>()
      .default({}),

    // SysML metadata
    metamodel: varchar('metamodel', { length: 50 }).default('cascadia'), // 'cascadia', 'sysml2', 'kerml'
    sysmlType: varchar('sysml_type', { length: 100 }), // 'PartDefinition', 'RequirementDefinition', etc.

    // Soft delete support
    isDeleted: boolean('is_deleted').default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => users.id),

    // Usage/Definition pattern (SysML v2 style)
    // If null, this item is a "definition" (canonical item, typically in Library)
    // If set, this item is a "usage" that references a definition item
    usageOf: uuid('usage_of'),
  },
  (table) => [
    // Unique item number + revision per design (allows same item number in different designs for usages)
    unique().on(
      table.itemNumber,
      table.revision,
      table.designId,
      table.itemType,
    ),
    index('idx_master_id').on(table.masterId),
    index('idx_item_type_state').on(table.itemType, table.state),
    index('idx_current').on(table.isCurrent),
    // SysML Migration indexes
    index('idx_item_design').on(table.designId),
    index('idx_item_commit').on(table.commitId),
    index('idx_item_attributes').using('gin', table.attributes),
    // Usage/Definition pattern index
    index('idx_item_usage_of').on(table.usageOf),
    // Full-text search index (simple config: no stemming, good for item numbers)
    index('idx_items_fts').using(
      'gin',
      sql`to_tsvector('simple', coalesce(${table.itemNumber}, '') || ' ' || coalesce(${table.name}, ''))`,
    ),
  ],
)

export const parts = pgTable('parts', {
  itemId: uuid('item_id')
    .primaryKey()
    .references(() => items.id, { onDelete: 'cascade' }),
  description: text('description'),
  partType: varchar('part_type', { length: 20 }),
  material: varchar('material', { length: 100 }),
  weight: decimal('weight', { precision: 10, scale: 3 }),
  weightUnit: varchar('weight_unit', { length: 10 }),
  cost: decimal('cost', { precision: 10, scale: 2 }),
  costCurrency: varchar('cost_currency', { length: 3 }),
  leadTimeDays: integer('lead_time_days'),
  quantityOnHand: integer('quantity_on_hand').default(0),
  reorderPoint: integer('reorder_point'),
  location: text('location'),
  lastInventoryCheck: timestamp('last_inventory_check', { withTimezone: true }),
})

export const documents = pgTable('documents', {
  itemId: uuid('item_id')
    .primaryKey()
    .references(() => items.id, { onDelete: 'cascade' }),
  description: text('description'),
  fileId: uuid('file_id'),
  fileName: varchar('file_name', { length: 500 }),
  fileSize: integer('file_size'),
  mimeType: varchar('mime_type', { length: 100 }),
  storagePath: text('storage_path'),
})

export const changeOrders = pgTable('change_orders', {
  itemId: uuid('item_id')
    .primaryKey()
    .references(() => items.id, { onDelete: 'cascade' }),
  changeType: varchar('change_type', { length: 20 }).notNull(),
  priority: varchar('priority', { length: 20 }).default('medium'),
  reasonForChange: text('reason_for_change'),
  impactDescription: text('impact_description'),
  implementationDate: timestamp('implementation_date', { withTimezone: true }),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  approvedBy: uuid('approved_by').references(() => users.id),
  implementedAt: timestamp('implemented_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  impactAssessmentStatus: varchar('impact_assessment_status', {
    length: 20,
  }).default('pending'),
  riskLevel: varchar('risk_level', { length: 20 }),
  // Baseline creation on release
  isBaseline: boolean('is_baseline').default(false),
  baselineName: varchar('baseline_name', { length: 100 }),
})

export const changeOrderAffectedItems = pgTable(
  'change_order_affected_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    changeOrderId: uuid('change_order_id')
      .notNull()
      .references(() => changeOrders.itemId, { onDelete: 'cascade' }),
    affectedItemId: uuid('affected_item_id').references(() => items.id, {
      onDelete: 'cascade',
    }),
    affectedItemMasterId: uuid('affected_item_master_id'),
    changeAction: varchar('change_action', { length: 20 }).notNull(),
    currentState: varchar('current_state', { length: 50 }),
    currentRevision: varchar('current_revision', { length: 10 }),
    targetState: varchar('target_state', { length: 50 }),
    targetRevision: varchar('target_revision', { length: 10 }),
    replacementItemId: uuid('replacement_item_id').references(() => items.id),
    newItemData: jsonb('new_item_data'),
    newItemType: varchar('new_item_type', { length: 50 }),
    changeDescription: text('change_description'),
    isDirectlyAffected: boolean('is_directly_affected').default(true),
    // Working copy created for 'revise' action - allows editing during ECO lifecycle
    workingCopyId: uuid('working_copy_id').references(() => items.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    index('idx_change_order').on(table.changeOrderId),
    index('idx_affected_item').on(table.affectedItemId),
    index('idx_working_copy').on(table.workingCopyId),
  ],
)

export const changeOrderImpactedItems = pgTable(
  'change_order_impacted_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    changeOrderId: uuid('change_order_id')
      .notNull()
      .references(() => changeOrders.itemId, { onDelete: 'cascade' }),
    impactedItemId: uuid('impacted_item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    impactType: varchar('impact_type', { length: 50 }).notNull(),
    impactSeverity: varchar('impact_severity', { length: 20 }),
    depth: integer('depth'),
    path: jsonb('path'),
    metadata: jsonb('metadata'),
    discoveredAt: timestamp('discovered_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_co_impacted').on(table.changeOrderId),
    index('idx_impacted_item').on(table.impactedItemId),
  ],
)

export const changeOrderRisks = pgTable(
  'change_order_risks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    changeOrderId: uuid('change_order_id')
      .notNull()
      .references(() => changeOrders.itemId, { onDelete: 'cascade' }),
    category: varchar('category', { length: 50 }).notNull(),
    severity: varchar('severity', { length: 20 }).notNull(),
    description: text('description').notNull(),
    affectedItems: jsonb('affected_items'),
    mitigation: text('mitigation'),
    requiresAcknowledgement: boolean('requires_acknowledgement').default(false),
    acknowledgedBy: uuid('acknowledged_by').references(() => users.id),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index('idx_co_risks').on(table.changeOrderId)],
)

export const changeOrderImpactReports = pgTable('change_order_impact_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  changeOrderId: uuid('change_order_id')
    .notNull()
    .unique()
    .references(() => changeOrders.itemId, { onDelete: 'cascade' }),
  generatedAt: timestamp('generated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  totalImpactedItems: integer('total_impacted_items'),
  maxBOMDepth: integer('max_bom_depth'),
  reportData: jsonb('report_data'),
  generationDurationMs: integer('generation_duration_ms'),
})

// Phase 3: ECO-as-Branch - tracks which designs an ECO affects and their branch status
export const changeOrderDesigns = pgTable(
  'change_order_designs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // References the ECO item (items.id where itemType='ChangeOrder')
    changeOrderId: uuid('change_order_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    designId: uuid('design_id')
      .notNull()
      .references(() => designs.id, { onDelete: 'cascade' }),
    // Branch is created lazily on first checkout, so nullable
    branchId: uuid('branch_id').references(() => branches.id),
    // Merge status: 'pending', 'merged', 'conflict', 'skipped'
    mergeStatus: varchar('merge_status', { length: 20 }).default('pending'),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    mergeCommitId: uuid('merge_commit_id').references(() => commits.id),
    itemsAffected: integer('items_affected').default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('change_order_designs_unique').on(
      table.changeOrderId,
      table.designId,
    ),
    index('idx_cod_change_order').on(table.changeOrderId),
    index('idx_cod_design').on(table.designId),
    index('idx_cod_branch').on(table.branchId),
  ],
)

export const requirements = pgTable(
  'requirements',
  {
    itemId: uuid('item_id')
      .primaryKey()
      .references(() => items.id, { onDelete: 'cascade' }),
    description: text('description'),
    type: varchar('type', { length: 50 }),
    priority: varchar('priority', { length: 20 }),
    status: varchar('status', { length: 50 }),
    acceptanceCriteria: text('acceptance_criteria'),
    source: varchar('source', { length: 200 }),
    category: varchar('category', { length: 100 }),
    // Phase 2: Verification fields for requirements traceability
    verificationMethod: varchar('verification_method', { length: 50 }), // Analysis | Inspection | Demonstration | Test
    verificationStatus: varchar('verification_status', { length: 50 }), // NotStarted | InProgress | Passed | Failed | Waived
    // Requirement can be allocated to a specific design element
    allocatedDesignId: uuid('allocated_design_id').references(() => designs.id),
    // Parent requirement for derived requirements hierarchy (DERIVES_FROM relationship)
    parentRequirementId: uuid('parent_requirement_id').references(
      () => items.id,
    ),
  },
  (table) => [
    index('idx_req_parent').on(table.parentRequirementId),
    index('idx_req_allocated').on(table.allocatedDesignId),
    index('idx_req_verification_status').on(table.verificationStatus),
  ],
)

export const tasks = pgTable(
  'tasks',
  {
    itemId: uuid('item_id')
      .primaryKey()
      .references(() => items.id, { onDelete: 'cascade' }),
    programId: uuid('program_id').references(() => programs.id),
    parentTaskId: uuid('parent_task_id').references(() => items.id),
    description: text('description'),
    assignee: uuid('assignee').references(() => users.id),
    priority: varchar('priority', { length: 20 }),
    dueDate: timestamp('due_date', { withTimezone: true }),
    estimatedHours: decimal('estimated_hours', { precision: 6, scale: 2 }),
    actualHours: decimal('actual_hours', { precision: 6, scale: 2 }),
    tags: jsonb('tags'),
  },
  (table) => [
    index('idx_task_program').on(table.programId),
    index('idx_task_assignee').on(table.assignee),
    index('idx_parent_task').on(table.parentTaskId),
  ],
)

/**
 * Test step structure for test_cases.steps JSONB field
 */
export interface TestStep {
  stepNumber: number
  action: string
  expectedResult: string
}

/**
 * Phase 3: Test Plans - container for organizing test cases
 */
export const testPlans = pgTable(
  'test_plans',
  {
    itemId: uuid('item_id')
      .primaryKey()
      .references(() => items.id, { onDelete: 'cascade' }),
    scope: text('scope'),
    environment: varchar('environment', { length: 100 }),
    entryCriteria: text('entry_criteria'),
    exitCriteria: text('exit_criteria'),
    status: varchar('status', { length: 50 }), // 'Draft' | 'Active' | 'Completed' | 'Archived'
  },
  () => [],
)

/**
 * Phase 3: Test Cases - individual test cases linked to test plans
 */
export const testCases = pgTable(
  'test_cases',
  {
    itemId: uuid('item_id')
      .primaryKey()
      .references(() => items.id, { onDelete: 'cascade' }),
    testPlanId: uuid('test_plan_id').references(() => items.id),
    testType: varchar('test_type', { length: 50 }), // 'Unit' | 'Integration' | 'System' | 'Acceptance'
    preconditions: text('preconditions'),
    steps: jsonb('steps').$type<Array<TestStep>>(),
    executionStatus: varchar('execution_status', { length: 50 }), // 'NotRun' | 'Passed' | 'Failed' | 'Blocked'
    lastExecutedAt: timestamp('last_executed_at', { withTimezone: true }),
    lastExecutedBy: uuid('last_executed_by').references(() => users.id),
    environment: varchar('environment', { length: 100 }),
  },
  (table) => [
    index('idx_test_case_plan').on(table.testPlanId),
    index('idx_test_execution_status').on(table.executionStatus),
  ],
)

/**
 * Phase 3: Test Executions - history of test case runs
 */
export const testExecutions = pgTable(
  'test_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    testCaseId: uuid('test_case_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    executorId: uuid('executor_id')
      .notNull()
      .references(() => users.id),
    executedAt: timestamp('executed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    status: varchar('status', { length: 50 }).notNull(), // 'Passed' | 'Failed' | 'Blocked'
    duration: integer('duration'), // seconds
    environment: varchar('environment', { length: 100 }),
    actualResults: text('actual_results'),
    notes: text('notes'),
  },
  (table) => [
    index('idx_test_exec_test_case').on(table.testCaseId),
    index('idx_test_exec_date').on(table.executedAt),
  ],
)

/**
 * Issues - Quality, engineering, and customer issue tracking
 * Similar to Aras Innovator's "Problem Reports"
 * Uses Free lifecycle - self-controlled, no ECO required
 */
export const issues = pgTable(
  'issues',
  {
    itemId: uuid('item_id')
      .primaryKey()
      .references(() => items.id, { onDelete: 'cascade' }),
    description: text('description'),
    severity: varchar('severity', { length: 20 }), // 'Critical' | 'High' | 'Medium' | 'Low'
    priority: varchar('priority', { length: 20 }), // 'Critical' | 'High' | 'Medium' | 'Low'
    category: varchar('category', { length: 50 }), // 'Design' | 'Manufacturing' | 'Quality' | 'Customer' | 'Safety' | 'Other'
    reportedBy: uuid('reported_by').references(() => users.id),
    reportedDate: timestamp('reported_date', { withTimezone: true }),
    assignedTo: uuid('assigned_to').references(() => users.id),
    resolution: text('resolution'),
    resolvedDate: timestamp('resolved_date', { withTimezone: true }),
    rootCause: text('root_cause'),
    programId: uuid('program_id').references(() => programs.id),
  },
  (table) => [
    index('idx_issue_severity').on(table.severity),
    index('idx_issue_priority').on(table.priority),
    index('idx_issue_category').on(table.category),
    index('idx_issue_assigned').on(table.assignedTo),
    index('idx_issue_program').on(table.programId),
  ],
)

/**
 * Junction table: Issue <-> Design (many-to-many)
 * Replaces the former JSONB designIds array for referential integrity.
 */
export const issueDesigns = pgTable(
  'issue_designs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issueItemId: uuid('issue_item_id')
      .notNull()
      .references(() => issues.itemId, { onDelete: 'cascade' }),
    designId: uuid('design_id')
      .notNull()
      .references(() => designs.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('uq_issue_design').on(table.issueItemId, table.designId),
    index('idx_issue_designs_issue').on(table.issueItemId),
    index('idx_issue_designs_design').on(table.designId),
  ],
)

/**
 * Junction table: Issue <-> Affected Item (many-to-many)
 * Replaces the former JSONB affectedItemIds array for referential integrity.
 */
export const issueAffectedItems = pgTable(
  'issue_affected_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issueItemId: uuid('issue_item_id')
      .notNull()
      .references(() => issues.itemId, { onDelete: 'cascade' }),
    affectedItemId: uuid('affected_item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('uq_issue_affected_item').on(
      table.issueItemId,
      table.affectedItemId,
    ),
    index('idx_issue_affected_items_issue').on(table.issueItemId),
    index('idx_issue_affected_items_item').on(table.affectedItemId),
  ],
)

/**
 * Domain values for cross-design relationships:
 * - 'engineering': Engineering domain (EBOM)
 * - 'manufacturing': Manufacturing domain (MBOM)
 */
export type ItemDomain = 'engineering' | 'manufacturing'

/**
 * Derivation method for cross-design relationships:
 * - 'direct': Item copied as-is from source
 * - 'substitute': Item replaced with manufacturing-specific alternative
 * - 'addition': New item added in manufacturing (no source equivalent)
 */
export type DerivationMethod = 'direct' | 'substitute' | 'addition'

export const itemRelationships = pgTable(
  'item_relationships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    relationshipType: varchar('relationship_type', { length: 50 }).notNull(),
    quantity: decimal('quantity', { precision: 10, scale: 3 }),
    referenceDesignator: text('reference_designator'),
    findNumber: integer('find_number'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),

    // SysML 2.0 relationship fields
    isComposite: boolean('is_composite').default(false), // Composition vs reference
    isDirected: boolean('is_directed').default(true), // Directed relationship
    multiplicityLower: integer('multiplicity_lower').default(1), // Lower bound
    multiplicityUpper: integer('multiplicity_upper'), // Upper bound (null = unbounded *)
    usageAttributes: jsonb('usage_attributes').$type<Record<string, unknown>>(), // Usage-specific overrides
    modifiedAt: timestamp('modified_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    modifiedBy: uuid('modified_by').references(() => users.id),

    // Cross-design relationship tracking (for EBOM→MBOM traceability)
    // Design containing the source item
    sourceDesignId: uuid('source_design_id').references(() => designs.id),
    // Design containing the target item
    targetDesignId: uuid('target_design_id').references(() => designs.id),
    // Domain of source item: 'engineering' | 'manufacturing'
    sourceDomain: varchar('source_domain', { length: 50 }),
    // Domain of target item: 'engineering' | 'manufacturing'
    targetDomain: varchar('target_domain', { length: 50 }),
    // How the target was derived from source: 'direct' | 'substitute' | 'addition'
    derivationMethod: varchar('derivation_method', { length: 50 }),
    // Notes explaining the derivation choice
    derivationNotes: text('derivation_notes'),
  },
  (table) => [
    unique().on(table.sourceId, table.targetId, table.relationshipType),
    index('idx_source').on(table.sourceId),
    index('idx_target').on(table.targetId),
    index('idx_relationship_type').on(table.relationshipType),
    index('idx_cross_design').on(table.sourceDesignId, table.targetDesignId),
  ],
)

// Relations
export const itemsRelations = relations(items, ({ one, many }) => ({
  // SysML Migration: Design and commit relations
  design: one(designs, {
    fields: [items.designId],
    references: [designs.id],
  }),
  commit: one(commits, {
    fields: [items.commitId],
    references: [commits.id],
  }),
  // Usage/Definition pattern: if this item is a usage, link to its definition
  definition: one(items, {
    fields: [items.usageOf],
    references: [items.id],
    relationName: 'itemUsages',
  }),
  // Usage/Definition pattern: if this item is a definition, link to all its usages
  usages: many(items, {
    relationName: 'itemUsages',
  }),
  creator: one(users, {
    fields: [items.createdBy],
    references: [users.id],
    relationName: 'itemCreator',
  }),
  modifier: one(users, {
    fields: [items.modifiedBy],
    references: [users.id],
    relationName: 'itemModifier',
  }),
  locker: one(users, {
    fields: [items.lockedBy],
    references: [users.id],
    relationName: 'itemLocker',
  }),
  deleter: one(users, {
    fields: [items.deletedBy],
    references: [users.id],
    relationName: 'itemDeleter',
  }),
  part: one(parts, {
    fields: [items.id],
    references: [parts.itemId],
  }),
  document: one(documents, {
    fields: [items.id],
    references: [documents.itemId],
  }),
  changeOrder: one(changeOrders, {
    fields: [items.id],
    references: [changeOrders.itemId],
  }),
  requirement: one(requirements, {
    fields: [items.id],
    references: [requirements.itemId],
  }),
  task: one(tasks, {
    fields: [items.id],
    references: [tasks.itemId],
  }),
  // Phase 3: Test Plan and Test Case
  testPlan: one(testPlans, {
    fields: [items.id],
    references: [testPlans.itemId],
  }),
  testCase: one(testCases, {
    fields: [items.id],
    references: [testCases.itemId],
  }),
  // Work Instructions
  workInstruction: one(workInstructions, {
    fields: [items.id],
    references: [workInstructions.itemId],
  }),
  issue: one(issues, {
    fields: [items.id],
    references: [issues.itemId],
  }),
  tool: one(tools, {
    fields: [items.id],
    references: [tools.itemId],
  }),
  sourceRelationships: many(itemRelationships, {
    relationName: 'sourceItem',
  }),
  targetRelationships: many(itemRelationships, {
    relationName: 'targetItem',
  }),
}))

export const partsRelations = relations(parts, ({ one, many }) => ({
  item: one(items, {
    fields: [parts.itemId],
    references: [items.id],
  }),
  cotsMappings: many(partCotsMapping),
}))

export const documentsRelations = relations(documents, ({ one }) => ({
  item: one(items, {
    fields: [documents.itemId],
    references: [items.id],
  }),
}))

export const changeOrdersRelations = relations(
  changeOrders,
  ({ one, many }) => ({
    item: one(items, {
      fields: [changeOrders.itemId],
      references: [items.id],
    }),
    approver: one(users, {
      fields: [changeOrders.approvedBy],
      references: [users.id],
    }),
    affectedItems: many(changeOrderAffectedItems),
    impactedItems: many(changeOrderImpactedItems),
    risks: many(changeOrderRisks),
    impactReport: one(changeOrderImpactReports, {
      fields: [changeOrders.itemId],
      references: [changeOrderImpactReports.changeOrderId],
    }),
    // Phase 3: ECO-as-Branch - designs affected by this ECO
    ecoDesigns: many(changeOrderDesigns),
  }),
)

export const changeOrderAffectedItemsRelations = relations(
  changeOrderAffectedItems,
  ({ one }) => ({
    changeOrder: one(changeOrders, {
      fields: [changeOrderAffectedItems.changeOrderId],
      references: [changeOrders.itemId],
    }),
    affectedItem: one(items, {
      fields: [changeOrderAffectedItems.affectedItemId],
      references: [items.id],
      relationName: 'affectedItem',
    }),
    replacementItem: one(items, {
      fields: [changeOrderAffectedItems.replacementItemId],
      references: [items.id],
      relationName: 'replacementItem',
    }),
    workingCopy: one(items, {
      fields: [changeOrderAffectedItems.workingCopyId],
      references: [items.id],
      relationName: 'workingCopy',
    }),
    creator: one(users, {
      fields: [changeOrderAffectedItems.createdBy],
      references: [users.id],
    }),
  }),
)

export const changeOrderImpactedItemsRelations = relations(
  changeOrderImpactedItems,
  ({ one }) => ({
    changeOrder: one(changeOrders, {
      fields: [changeOrderImpactedItems.changeOrderId],
      references: [changeOrders.itemId],
    }),
    impactedItem: one(items, {
      fields: [changeOrderImpactedItems.impactedItemId],
      references: [items.id],
    }),
  }),
)

export const changeOrderRisksRelations = relations(
  changeOrderRisks,
  ({ one }) => ({
    changeOrder: one(changeOrders, {
      fields: [changeOrderRisks.changeOrderId],
      references: [changeOrders.itemId],
    }),
    acknowledger: one(users, {
      fields: [changeOrderRisks.acknowledgedBy],
      references: [users.id],
    }),
  }),
)

export const changeOrderImpactReportsRelations = relations(
  changeOrderImpactReports,
  ({ one }) => ({
    changeOrder: one(changeOrders, {
      fields: [changeOrderImpactReports.changeOrderId],
      references: [changeOrders.itemId],
    }),
  }),
)

export const changeOrderDesignsRelations = relations(
  changeOrderDesigns,
  ({ one }) => ({
    changeOrderItem: one(items, {
      fields: [changeOrderDesigns.changeOrderId],
      references: [items.id],
    }),
    design: one(designs, {
      fields: [changeOrderDesigns.designId],
      references: [designs.id],
    }),
    branch: one(branches, {
      fields: [changeOrderDesigns.branchId],
      references: [branches.id],
    }),
    mergeCommit: one(commits, {
      fields: [changeOrderDesigns.mergeCommitId],
      references: [commits.id],
    }),
  }),
)

export const requirementsRelations = relations(requirements, ({ one }) => ({
  item: one(items, {
    fields: [requirements.itemId],
    references: [items.id],
  }),
  // Phase 2: Parent requirement for derived requirements hierarchy
  parentRequirement: one(items, {
    fields: [requirements.parentRequirementId],
    references: [items.id],
    relationName: 'derivedFromRequirement',
  }),
  // Phase 2: Allocated design
  allocatedDesign: one(designs, {
    fields: [requirements.allocatedDesignId],
    references: [designs.id],
  }),
}))

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  item: one(items, {
    fields: [tasks.itemId],
    references: [items.id],
  }),
  program: one(programs, {
    fields: [tasks.programId],
    references: [programs.id],
  }),
  assignedTo: one(users, {
    fields: [tasks.assignee],
    references: [users.id],
  }),
  parentTask: one(items, {
    fields: [tasks.parentTaskId],
    references: [items.id],
    relationName: 'taskParent',
  }),
  subTasks: many(tasks, {
    relationName: 'taskChildren',
  }),
}))

export const itemRelationshipsRelations = relations(
  itemRelationships,
  ({ one }) => ({
    sourceItem: one(items, {
      fields: [itemRelationships.sourceId],
      references: [items.id],
      relationName: 'sourceItem',
    }),
    targetItem: one(items, {
      fields: [itemRelationships.targetId],
      references: [items.id],
      relationName: 'targetItem',
    }),
    creator: one(users, {
      fields: [itemRelationships.createdBy],
      references: [users.id],
      relationName: 'relationshipCreator',
    }),
    modifier: one(users, {
      fields: [itemRelationships.modifiedBy],
      references: [users.id],
      relationName: 'relationshipModifier',
    }),
    // Cross-design relations
    sourceDesign: one(designs, {
      fields: [itemRelationships.sourceDesignId],
      references: [designs.id],
      relationName: 'sourceDesignRelationships',
    }),
    targetDesign: one(designs, {
      fields: [itemRelationships.targetDesignId],
      references: [designs.id],
      relationName: 'targetDesignRelationships',
    }),
  }),
)

// Phase 3: Test Plan relations
export const testPlansRelations = relations(testPlans, ({ one, many }) => ({
  item: one(items, {
    fields: [testPlans.itemId],
    references: [items.id],
  }),
  testCases: many(testCases),
}))

// Phase 3: Test Case relations
export const testCasesRelations = relations(testCases, ({ one, many }) => ({
  item: one(items, {
    fields: [testCases.itemId],
    references: [items.id],
  }),
  testPlan: one(testPlans, {
    fields: [testCases.testPlanId],
    references: [testPlans.itemId],
  }),
  lastExecutor: one(users, {
    fields: [testCases.lastExecutedBy],
    references: [users.id],
  }),
  executions: many(testExecutions),
}))

// Phase 3: Test Execution relations
export const testExecutionsRelations = relations(testExecutions, ({ one }) => ({
  testCase: one(testCases, {
    fields: [testExecutions.testCaseId],
    references: [testCases.itemId],
  }),
  executor: one(users, {
    fields: [testExecutions.executorId],
    references: [users.id],
  }),
}))

// =====================================================================
// Work Instructions Module
// ============================================================================

/**
 * Step content block types for the simplified block editor
 */
export type StepBlockType = 'text' | 'image' | 'parametric' | 'dataField'

/**
 * Step content block structure for JSONB storage
 */
export interface StepContentBlock {
  id: string
  type: StepBlockType
  // For text blocks
  content?: string // Rich text HTML content
  // For image blocks
  fileId?: string // Reference to file in vault
  alt?: string
  caption?: string
  // For parametric blocks
  partId?: string // Reference to part
  attributePath?: string // e.g., 'weight', 'material', 'attributes.tensileStrength'
  label?: string // Display label
  unit?: string // Display unit override
  fallbackValue?: string // Shown when part unavailable
  // For dataField blocks
  fieldType?: 'text' | 'numeric' | 'checkbox' | 'passFail'
  fieldLabel?: string
  fieldRequired?: boolean
  fieldValidation?: {
    min?: number
    max?: number
    pattern?: string
  }
}

/**
 * Step content schema stored in JSONB
 */
export interface StepContent {
  blocks: Array<StepContentBlock>
}

/**
 * Work Instructions - type-specific table following two-table pattern
 * Extends items table with WorkInstruction-specific fields
 */
export const workInstructions = pgTable('work_instructions', {
  itemId: uuid('item_id')
    .primaryKey()
    .references(() => items.id, { onDelete: 'cascade' }),
  description: text('description'),
  // Estimated time to complete (in minutes)
  estimatedTime: integer('estimated_time'),
  // Difficulty level
  difficulty: varchar('difficulty', { length: 20 }), // 'Easy' | 'Medium' | 'Hard'
  // Safety considerations
  safetyNotes: text('safety_notes'),
  // Required tools/equipment
  requiredTools: text('required_tools'),
})

/**
 * Work Instruction Operations - named groupings of steps (e.g., "Assembly", "Inspection", "Test")
 */
export const workInstructionOperations = pgTable(
  'work_instruction_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workInstructionId: uuid('work_instruction_id')
      .notNull()
      .references(() => workInstructions.itemId, { onDelete: 'cascade' }),
    orderIndex: integer('order_index').notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    description: text('description'),
    estimatedTime: integer('estimated_time'), // in minutes
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_wi_operation_order').on(
      table.workInstructionId,
      table.orderIndex,
    ),
  ],
)

/**
 * Work Instruction Steps - ordered collection of steps within a WI
 */
export const workInstructionSteps = pgTable(
  'work_instruction_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workInstructionId: uuid('work_instruction_id')
      .notNull()
      .references(() => workInstructions.itemId, { onDelete: 'cascade' }),
    operationId: uuid('operation_id').references(
      () => workInstructionOperations.id,
      { onDelete: 'set null' },
    ),
    orderIndex: integer('order_index').notNull(),
    title: varchar('title', { length: 500 }),
    // Content blocks stored as JSONB
    content: jsonb('content').$type<StepContent>().default({ blocks: [] }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_wi_step_order').on(table.workInstructionId, table.orderIndex),
    index('idx_wi_step_operation').on(table.operationId),
  ],
)

/**
 * Work Instruction Part Attachments - many-to-many junction table
 * Links Work Instructions to Parts (typically MBOM parts)
 */
export const workInstructionPartAttachments = pgTable(
  'work_instruction_part_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workInstructionId: uuid('work_instruction_id')
      .notNull()
      .references(() => workInstructions.itemId, { onDelete: 'cascade' }),
    partId: uuid('part_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    // If attached to EBOM part, auto-attach to derived MBOMs
    inheritToMBOM: boolean('inherit_to_mbom').default(false),
    // Tracks which source attachment this was inherited from (EBOM → MBOM)
    inheritedFromId: uuid('inherited_from_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    unique('wi_part_attachment_unique').on(
      table.workInstructionId,
      table.partId,
    ),
    index('idx_wi_part_wi').on(table.workInstructionId),
    index('idx_wi_part_part').on(table.partId),
  ],
)

/**
 * Work Instruction Change Alerts - notify WI authors when linked parts change
 */
export const workInstructionChangeAlerts = pgTable(
  'work_instruction_change_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workInstructionId: uuid('work_instruction_id')
      .notNull()
      .references(() => workInstructions.itemId, { onDelete: 'cascade' }),
    partId: uuid('part_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    ecoId: uuid('eco_id').references(() => items.id, { onDelete: 'set null' }),
    changeType: varchar('change_type', { length: 50 }).notNull(), // 'part_modified' | 'part_obsoleted' | 'parametric_stale'
    changedFields: jsonb('changed_fields').$type<Array<string>>(),
    previousValues: jsonb('previous_values').$type<Record<string, unknown>>(),
    newValues: jsonb('new_values').$type<Record<string, unknown>>(),
    status: varchar('status', { length: 20 }).notNull().default('pending'), // 'pending' | 'acknowledged' | 'dismissed'
    acknowledgedBy: uuid('acknowledged_by').references(() => users.id),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_wi_alert_wi').on(table.workInstructionId),
    index('idx_wi_alert_part').on(table.partId),
    index('idx_wi_alert_status').on(table.status),
    index('idx_wi_alert_eco').on(table.ecoId),
  ],
)

// Work Instructions relations
export const workInstructionsRelations = relations(
  workInstructions,
  ({ one, many }) => ({
    item: one(items, {
      fields: [workInstructions.itemId],
      references: [items.id],
    }),
    operations: many(workInstructionOperations),
    steps: many(workInstructionSteps),
    partAttachments: many(workInstructionPartAttachments),
    changeAlerts: many(workInstructionChangeAlerts),
  }),
)

export const workInstructionOperationsRelations = relations(
  workInstructionOperations,
  ({ one, many }) => ({
    workInstruction: one(workInstructions, {
      fields: [workInstructionOperations.workInstructionId],
      references: [workInstructions.itemId],
    }),
    steps: many(workInstructionSteps),
  }),
)

export const workInstructionStepsRelations = relations(
  workInstructionSteps,
  ({ one }) => ({
    workInstruction: one(workInstructions, {
      fields: [workInstructionSteps.workInstructionId],
      references: [workInstructions.itemId],
    }),
    operation: one(workInstructionOperations, {
      fields: [workInstructionSteps.operationId],
      references: [workInstructionOperations.id],
    }),
  }),
)

export const workInstructionPartAttachmentsRelations = relations(
  workInstructionPartAttachments,
  ({ one }) => ({
    workInstruction: one(workInstructions, {
      fields: [workInstructionPartAttachments.workInstructionId],
      references: [workInstructions.itemId],
    }),
    part: one(items, {
      fields: [workInstructionPartAttachments.partId],
      references: [items.id],
    }),
    creator: one(users, {
      fields: [workInstructionPartAttachments.createdBy],
      references: [users.id],
    }),
  }),
)

export const workInstructionChangeAlertsRelations = relations(
  workInstructionChangeAlerts,
  ({ one }) => ({
    workInstruction: one(workInstructions, {
      fields: [workInstructionChangeAlerts.workInstructionId],
      references: [workInstructions.itemId],
    }),
    part: one(items, {
      fields: [workInstructionChangeAlerts.partId],
      references: [items.id],
      relationName: 'alertPart',
    }),
    eco: one(items, {
      fields: [workInstructionChangeAlerts.ecoId],
      references: [items.id],
      relationName: 'alertEco',
    }),
    acknowledger: one(users, {
      fields: [workInstructionChangeAlerts.acknowledgedBy],
      references: [users.id],
    }),
  }),
)

// Issue relations
export const issuesRelations = relations(issues, ({ one }) => ({
  item: one(items, {
    fields: [issues.itemId],
    references: [items.id],
  }),
  reporter: one(users, {
    fields: [issues.reportedBy],
    references: [users.id],
    relationName: 'issueReporter',
  }),
  assignee: one(users, {
    fields: [issues.assignedTo],
    references: [users.id],
    relationName: 'issueAssignee',
  }),
  program: one(programs, {
    fields: [issues.programId],
    references: [programs.id],
  }),
}))

// ============================================================================
// Tools - Manufacturing equipment, quality instruments, utility devices
// ============================================================================

/**
 * Tools - type-specific table following two-table pattern
 * Extends items table with Tool-specific fields for manufacturing equipment
 */
export const tools = pgTable('tools', {
  itemId: uuid('item_id')
    .primaryKey()
    .references(() => items.id, { onDelete: 'cascade' }),
  // Tool classification
  toolType: varchar('tool_type', { length: 50 }), // 'manufacturing' | 'quality' | 'utility'
  toolSubtype: varchar('tool_subtype', { length: 50 }), // 'fdm_printer', 'cnc_mill', 'laser_cutter', etc.
  // Equipment identity
  manufacturer: varchar('manufacturer', { length: 200 }),
  model: varchar('model', { length: 200 }),
  // Structured capabilities — schema varies by toolSubtype
  capabilities: jsonb('capabilities').$type<Record<string, unknown>>(),
  // Current status
  toolStatus: varchar('tool_status', { length: 20 }).default('available'), // 'available' | 'in_use' | 'maintenance' | 'retired'
  // Physical location
  location: varchar('location', { length: 500 }),
  // Free-form notes
  notes: text('notes'),
})

// Tool relations
export const toolsRelations = relations(tools, ({ one }) => ({
  item: one(items, {
    fields: [tools.itemId],
    references: [items.id],
  }),
}))
