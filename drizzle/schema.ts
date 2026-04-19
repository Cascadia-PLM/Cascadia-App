import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

export const sessions = pgTable(
  'sessions',
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    userId: uuid('user_id').notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'sessions_user_id_users_id_fk',
    }).onDelete('cascade'),
  ],
)

export const changeOrders = pgTable(
  'change_orders',
  {
    itemId: uuid('item_id').primaryKey().notNull(),
    changeType: varchar('change_type', { length: 20 }).notNull(),
    priority: varchar({ length: 20 }).default('medium'),
    reasonForChange: text('reason_for_change'),
    impactDescription: text('impact_description'),
    implementationDate: timestamp('implementation_date', {
      withTimezone: true,
      mode: 'string',
    }),
    submittedAt: timestamp('submitted_at', {
      withTimezone: true,
      mode: 'string',
    }),
    approvedAt: timestamp('approved_at', {
      withTimezone: true,
      mode: 'string',
    }),
    approvedBy: uuid('approved_by'),
    implementedAt: timestamp('implemented_at', {
      withTimezone: true,
      mode: 'string',
    }),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'string' }),
    impactAssessmentStatus: varchar('impact_assessment_status', {
      length: 20,
    }).default('pending'),
    riskLevel: varchar('risk_level', { length: 20 }),
  },
  (table) => [
    foreignKey({
      columns: [table.itemId],
      foreignColumns: [items.id],
      name: 'change_orders_item_id_items_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.approvedBy],
      foreignColumns: [users.id],
      name: 'change_orders_approved_by_users_id_fk',
    }),
  ],
)

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id').notNull(),
    roleId: uuid('role_id').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'user_roles_user_id_users_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.roleId],
      foreignColumns: [roles.id],
      name: 'user_roles_role_id_roles_id_fk',
    }).onDelete('cascade'),
  ],
)

export const roles = pgTable(
  'roles',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: varchar({ length: 100 }).notNull(),
    description: text(),
    permissions: jsonb(),
  },
  (table) => [unique('roles_name_unique').on(table.name)],
)

export const changeOrderImpactReports = pgTable(
  'change_order_impact_reports',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    changeOrderId: uuid('change_order_id').notNull(),
    generatedAt: timestamp('generated_at', {
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    totalImpactedItems: integer('total_impacted_items'),
    maxBomDepth: integer('max_bom_depth'),
    reportData: jsonb('report_data'),
    generationDurationMs: integer('generation_duration_ms'),
  },
  (table) => [
    foreignKey({
      columns: [table.changeOrderId],
      foreignColumns: [changeOrders.itemId],
      name: 'change_order_impact_reports_change_order_id_change_orders_item_',
    }).onDelete('cascade'),
    unique('change_order_impact_reports_change_order_id_unique').on(
      table.changeOrderId,
    ),
  ],
)

export const changeOrderImpactedItems = pgTable(
  'change_order_impacted_items',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    changeOrderId: uuid('change_order_id').notNull(),
    impactedItemId: uuid('impacted_item_id').notNull(),
    impactType: varchar('impact_type', { length: 50 }).notNull(),
    impactSeverity: varchar('impact_severity', { length: 20 }),
    depth: integer(),
    path: jsonb(),
    metadata: jsonb(),
    discoveredAt: timestamp('discovered_at', {
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_co_impacted').using(
      'btree',
      table.changeOrderId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_impacted_item').using(
      'btree',
      table.impactedItemId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.impactedItemId],
      foreignColumns: [items.id],
      name: 'change_order_impacted_items_impacted_item_id_items_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.changeOrderId],
      foreignColumns: [changeOrders.itemId],
      name: 'change_order_impacted_items_change_order_id_change_orders_item_',
    }).onDelete('cascade'),
  ],
)

export const changeOrderRisks = pgTable(
  'change_order_risks',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    changeOrderId: uuid('change_order_id').notNull(),
    category: varchar({ length: 50 }).notNull(),
    severity: varchar({ length: 20 }).notNull(),
    description: text().notNull(),
    affectedItems: jsonb('affected_items'),
    mitigation: text(),
    requiresAcknowledgement: boolean('requires_acknowledgement').default(false),
    acknowledgedBy: uuid('acknowledged_by'),
    acknowledgedAt: timestamp('acknowledged_at', {
      withTimezone: true,
      mode: 'string',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_co_risks').using(
      'btree',
      table.changeOrderId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.changeOrderId],
      foreignColumns: [changeOrders.itemId],
      name: 'change_order_risks_change_order_id_change_orders_item_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.acknowledgedBy],
      foreignColumns: [users.id],
      name: 'change_order_risks_acknowledged_by_users_id_fk',
    }),
  ],
)

export const users = pgTable(
  'users',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    email: varchar({ length: 255 }).notNull(),
    name: varchar({ length: 255 }),
    passwordHash: varchar('password_hash', { length: 255 }),
    provider: varchar({ length: 50 }).default('local'),
    providerId: varchar('provider_id', { length: 255 }),
    active: boolean().default(true).notNull(),
    organizationId: uuid('organization_id'),
    lastLogin: timestamp('last_login', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
      name: 'users_organization_id_organizations_id_fk',
    }),
    unique('users_email_unique').on(table.email),
  ],
)

export const changeOrderAffectedItems = pgTable(
  'change_order_affected_items',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    changeOrderId: uuid('change_order_id').notNull(),
    affectedItemId: uuid('affected_item_id'),
    affectedItemMasterId: uuid('affected_item_master_id'),
    changeAction: varchar('change_action', { length: 20 }).notNull(),
    currentState: varchar('current_state', { length: 50 }),
    currentRevision: varchar('current_revision', { length: 10 }),
    targetState: varchar('target_state', { length: 50 }),
    targetRevision: varchar('target_revision', { length: 10 }),
    replacementItemId: uuid('replacement_item_id'),
    newItemData: jsonb('new_item_data'),
    newItemType: varchar('new_item_type', { length: 50 }),
    changeDescription: text('change_description'),
    isDirectlyAffected: boolean('is_directly_affected').default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by').notNull(),
  },
  (table) => [
    index('idx_affected_item').using(
      'btree',
      table.affectedItemId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_change_order').using(
      'btree',
      table.changeOrderId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.affectedItemId],
      foreignColumns: [items.id],
      name: 'change_order_affected_items_affected_item_id_items_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.replacementItemId],
      foreignColumns: [items.id],
      name: 'change_order_affected_items_replacement_item_id_items_id_fk',
    }),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: 'change_order_affected_items_created_by_users_id_fk',
    }),
    foreignKey({
      columns: [table.changeOrderId],
      foreignColumns: [changeOrders.itemId],
      name: 'change_order_affected_items_change_order_id_change_orders_item_',
    }).onDelete('cascade'),
  ],
)

export const itemRelationships = pgTable(
  'item_relationships',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    sourceId: uuid('source_id').notNull(),
    targetId: uuid('target_id').notNull(),
    relationshipType: varchar('relationship_type', { length: 50 }).notNull(),
    quantity: numeric({ precision: 10, scale: 3 }),
    referenceDesignator: text('reference_designator'),
    findNumber: integer('find_number'),
    metadata: jsonb(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by').notNull(),
  },
  (table) => [
    index('idx_source').using(
      'btree',
      table.sourceId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_target').using(
      'btree',
      table.targetId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.sourceId],
      foreignColumns: [items.id],
      name: 'item_relationships_source_id_items_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.targetId],
      foreignColumns: [items.id],
      name: 'item_relationships_target_id_items_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: 'item_relationships_created_by_users_id_fk',
    }),
    unique(
      'item_relationships_source_id_target_id_relationship_type_unique',
    ).on(table.targetId, table.sourceId, table.relationshipType),
  ],
)

export const documents = pgTable(
  'documents',
  {
    itemId: uuid('item_id').primaryKey().notNull(),
    description: text(),
    fileId: uuid('file_id'),
    fileName: varchar('file_name', { length: 500 }),
    fileSize: integer('file_size'),
    mimeType: varchar('mime_type', { length: 100 }),
    storagePath: text('storage_path'),
  },
  (table) => [
    foreignKey({
      columns: [table.itemId],
      foreignColumns: [items.id],
      name: 'documents_item_id_items_id_fk',
    }).onDelete('cascade'),
  ],
)

export const files = pgTable(
  'files',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    itemId: uuid('item_id'),
    fileName: varchar('file_name', { length: 500 }).notNull(),
    originalFileName: varchar('original_file_name', { length: 500 }),
    fileSize: integer('file_size').notNull(),
    mimeType: varchar('mime_type', { length: 100 }),
    storagePath: text('storage_path').notNull(),
    storageType: varchar('storage_type', { length: 20 }).default('local'),
    checksum: varchar({ length: 64 }),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    uploadedBy: uuid('uploaded_by').notNull(),
  },
  (table) => [
    index('idx_file_item').using(
      'btree',
      table.itemId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_file_uploaded').using(
      'btree',
      table.uploadedAt.asc().nullsLast().op('timestamptz_ops'),
    ),
    foreignKey({
      columns: [table.itemId],
      foreignColumns: [items.id],
      name: 'files_item_id_items_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.uploadedBy],
      foreignColumns: [users.id],
      name: 'files_uploaded_by_users_id_fk',
    }),
  ],
)

export const projects = pgTable(
  'projects',
  {
    itemId: uuid('item_id').primaryKey().notNull(),
    parentProjectId: uuid('parent_project_id'),
    description: text(),
    type: varchar({ length: 50 }),
    startDate: timestamp('start_date', { withTimezone: true, mode: 'string' }),
    targetDate: timestamp('target_date', {
      withTimezone: true,
      mode: 'string',
    }),
    completedDate: timestamp('completed_date', {
      withTimezone: true,
      mode: 'string',
    }),
    budget: numeric({ precision: 12, scale: 2 }),
    actualCost: numeric('actual_cost', { precision: 12, scale: 2 }),
    currency: varchar({ length: 3 }).default('USD'),
    projectManager: uuid('project_manager'),
    priority: varchar({ length: 20 }),
  },
  (table) => [
    index('idx_parent_project').using(
      'btree',
      table.parentProjectId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.itemId],
      foreignColumns: [items.id],
      name: 'projects_item_id_items_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.parentProjectId],
      foreignColumns: [items.id],
      name: 'projects_parent_project_id_items_id_fk',
    }),
    foreignKey({
      columns: [table.projectManager],
      foreignColumns: [users.id],
      name: 'projects_project_manager_users_id_fk',
    }),
  ],
)

export const parts = pgTable(
  'parts',
  {
    itemId: uuid('item_id').primaryKey().notNull(),
    description: text(),
    partType: varchar('part_type', { length: 20 }),
    material: varchar({ length: 100 }),
    weight: numeric({ precision: 10, scale: 3 }),
    weightUnit: varchar('weight_unit', { length: 10 }),
    cost: numeric({ precision: 10, scale: 2 }),
    costCurrency: varchar('cost_currency', { length: 3 }),
    leadTimeDays: integer('lead_time_days'),
    quantityOnHand: integer('quantity_on_hand').default(0),
    reorderPoint: integer('reorder_point'),
    location: text(),
    lastInventoryCheck: timestamp('last_inventory_check', {
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => [
    foreignKey({
      columns: [table.itemId],
      foreignColumns: [items.id],
      name: 'parts_item_id_items_id_fk',
    }).onDelete('cascade'),
  ],
)

export const tasks = pgTable(
  'tasks',
  {
    itemId: uuid('item_id').primaryKey().notNull(),
    projectId: uuid('project_id'),
    parentTaskId: uuid('parent_task_id'),
    description: text(),
    assignee: uuid(),
    priority: varchar({ length: 20 }),
    dueDate: timestamp('due_date', { withTimezone: true, mode: 'string' }),
    estimatedHours: numeric('estimated_hours', { precision: 6, scale: 2 }),
    actualHours: numeric('actual_hours', { precision: 6, scale: 2 }),
    tags: jsonb(),
  },
  (table) => [
    index('idx_parent_task').using(
      'btree',
      table.parentTaskId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_task_assignee').using(
      'btree',
      table.assignee.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_task_project').using(
      'btree',
      table.projectId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.itemId],
      foreignColumns: [items.id],
      name: 'tasks_item_id_items_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [items.id],
      name: 'tasks_project_id_items_id_fk',
    }),
    foreignKey({
      columns: [table.parentTaskId],
      foreignColumns: [items.id],
      name: 'tasks_parent_task_id_items_id_fk',
    }),
    foreignKey({
      columns: [table.assignee],
      foreignColumns: [users.id],
      name: 'tasks_assignee_users_id_fk',
    }),
  ],
)

export const workflowInstances = pgTable(
  'workflow_instances',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    workflowDefinitionId: uuid('workflow_definition_id'),
    itemId: uuid('item_id'),
    currentState: varchar('current_state', { length: 100 }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    context: jsonb(),
  },
  (table) => [
    foreignKey({
      columns: [table.itemId],
      foreignColumns: [items.id],
      name: 'workflow_instances_item_id_items_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workflowDefinitionId],
      foreignColumns: [workflowDefinitions.id],
      name: 'workflow_instances_workflow_definition_id_workflow_definitions_',
    }),
  ],
)

export const vaultFiles = pgTable(
  'vault_files',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    itemId: uuid('item_id').notNull(),
    fileName: text('file_name').notNull(),
    originalFileName: text('original_file_name').notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    fileSize: bigint('file_size', { mode: 'number' }).notNull(),
    mimeType: varchar('mime_type', { length: 200 }).notNull(),
    fileHash: varchar('file_hash', { length: 64 }).notNull(),
    storageType: varchar('storage_type', { length: 50 })
      .default('local')
      .notNull(),
    storagePath: text('storage_path').notNull(),
    fileVersion: integer('file_version').default(1).notNull(),
    isLatestVersion: boolean('is_latest_version').default(true).notNull(),
    isCheckedOut: boolean('is_checked_out').default(false).notNull(),
    checkedOutBy: uuid('checked_out_by'),
    checkedOutAt: timestamp('checked_out_at', {
      withTimezone: true,
      mode: 'string',
    }),
    uploadedBy: uuid('uploaded_by').notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    metadata: jsonb(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    deletedBy: uuid('deleted_by'),
  },
  (table) => [
    index('idx_vault_files_checked_out_by').using(
      'btree',
      table.checkedOutBy.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_vault_files_deleted').using(
      'btree',
      table.deletedAt.asc().nullsLast().op('timestamptz_ops'),
    ),
    index('idx_vault_files_hash').using(
      'btree',
      table.fileHash.asc().nullsLast().op('text_ops'),
    ),
    index('idx_vault_files_item_id').using(
      'btree',
      table.itemId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_vault_files_latest').using(
      'btree',
      table.isLatestVersion.asc().nullsLast().op('bool_ops'),
    ),
    foreignKey({
      columns: [table.itemId],
      foreignColumns: [items.id],
      name: 'vault_files_item_id_items_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.checkedOutBy],
      foreignColumns: [users.id],
      name: 'vault_files_checked_out_by_users_id_fk',
    }),
    foreignKey({
      columns: [table.uploadedBy],
      foreignColumns: [users.id],
      name: 'vault_files_uploaded_by_users_id_fk',
    }),
    foreignKey({
      columns: [table.deletedBy],
      foreignColumns: [users.id],
      name: 'vault_files_deleted_by_users_id_fk',
    }),
  ],
)

export const workflowDefinitions = pgTable(
  'workflow_definitions',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: varchar({ length: 200 }).notNull(),
    version: integer().notNull(),
    workflowType: varchar('workflow_type', { length: 20 }).notNull(),
    definition: jsonb().notNull(),
    isActive: boolean('is_active').default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [unique('workflow_definitions_name_unique').on(table.name)],
)

export const vaultFileHistory = pgTable(
  'vault_file_history',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    fileId: uuid('file_id').notNull(),
    action: varchar({ length: 50 }).notNull(),
    performedBy: uuid('performed_by').notNull(),
    performedAt: timestamp('performed_at', {
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    details: jsonb(),
  },
  (table) => [
    index('idx_vault_history_file_id').using(
      'btree',
      table.fileId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_vault_history_performed_at').using(
      'btree',
      table.performedAt.asc().nullsLast().op('timestamptz_ops'),
    ),
    index('idx_vault_history_performed_by').using(
      'btree',
      table.performedBy.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.fileId],
      foreignColumns: [vaultFiles.id],
      name: 'vault_file_history_file_id_vault_files_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.performedBy],
      foreignColumns: [users.id],
      name: 'vault_file_history_performed_by_users_id_fk',
    }),
  ],
)

export const requirements = pgTable(
  'requirements',
  {
    itemId: uuid('item_id').primaryKey().notNull(),
    description: text(),
    type: varchar({ length: 50 }),
    priority: varchar({ length: 20 }),
    status: varchar({ length: 50 }),
    acceptanceCriteria: text('acceptance_criteria'),
    source: varchar({ length: 200 }),
    category: varchar({ length: 100 }),
  },
  (table) => [
    foreignKey({
      columns: [table.itemId],
      foreignColumns: [items.id],
      name: 'requirements_item_id_items_id_fk',
    }).onDelete('cascade'),
  ],
)

export const reports = pgTable(
  'reports',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: varchar({ length: 255 }).notNull(),
    description: text(),
    itemType: varchar('item_type', { length: 50 }).notNull(),
    isPublic: boolean('is_public').default(false).notNull(),
    sharedWithRoles: jsonb('shared_with_roles'),
    sharedWithUsers: jsonb('shared_with_users'),
    config: jsonb(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by').notNull(),
    modifiedAt: timestamp('modified_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    modifiedBy: uuid('modified_by').notNull(),
  },
  (table) => [
    index('idx_reports_created_by').using(
      'btree',
      table.createdBy.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_reports_is_public').using(
      'btree',
      table.isPublic.asc().nullsLast().op('bool_ops'),
    ),
    index('idx_reports_item_type').using(
      'btree',
      table.itemType.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: 'reports_created_by_users_id_fk',
    }),
    foreignKey({
      columns: [table.modifiedBy],
      foreignColumns: [users.id],
      name: 'reports_modified_by_users_id_fk',
    }),
  ],
)

export const cotsComponents = pgTable(
  'cots_components',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: text().notNull(),
    manufacturer: text(),
    mpn: text(),
    description: text(),
    specs: jsonb(),
    datasheetUrl: text('datasheet_url'),
    imageUrl: text('image_url'),
    supplierLinks: jsonb('supplier_links'),
    source: text().notNull(),
    tags: text().array(),
    importDate: timestamp('import_date', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    lastUpdated: timestamp('last_updated', {
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('cots_components_manufacturer_idx').using(
      'btree',
      table.manufacturer.asc().nullsLast().op('text_ops'),
    ),
    index('cots_components_source_idx').using(
      'btree',
      table.source.asc().nullsLast().op('text_ops'),
    ),
    index('cots_components_tags_idx').using(
      'btree',
      table.tags.asc().nullsLast().op('array_ops'),
    ),
  ],
)

export const reportExecutions = pgTable(
  'report_executions',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    reportId: uuid('report_id').notNull(),
    executedBy: uuid('executed_by').notNull(),
    executedAt: timestamp('executed_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    rowCount: integer('row_count'),
    durationMs: integer('duration_ms'),
    parameters: jsonb(),
    success: boolean().default(true).notNull(),
    errorMessage: text('error_message'),
  },
  (table) => [
    index('idx_report_executions_executed_at').using(
      'btree',
      table.executedAt.asc().nullsLast().op('timestamptz_ops'),
    ),
    index('idx_report_executions_executed_by').using(
      'btree',
      table.executedBy.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_report_executions_report').using(
      'btree',
      table.reportId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.reportId],
      foreignColumns: [reports.id],
      name: 'report_executions_report_id_reports_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.executedBy],
      foreignColumns: [users.id],
      name: 'report_executions_executed_by_users_id_fk',
    }),
  ],
)

export const reportExports = pgTable(
  'report_exports',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    reportId: uuid('report_id').notNull(),
    executionId: uuid('execution_id'),
    exportedBy: uuid('exported_by').notNull(),
    exportedAt: timestamp('exported_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    format: varchar({ length: 20 }).default('csv').notNull(),
    fileName: varchar('file_name', { length: 255 }),
    fileSize: integer('file_size'),
    storagePath: text('storage_path'),
  },
  (table) => [
    index('idx_report_exports_exported_by').using(
      'btree',
      table.exportedBy.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_report_exports_report').using(
      'btree',
      table.reportId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.reportId],
      foreignColumns: [reports.id],
      name: 'report_exports_report_id_reports_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.executionId],
      foreignColumns: [reportExecutions.id],
      name: 'report_exports_execution_id_report_executions_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.exportedBy],
      foreignColumns: [users.id],
      name: 'report_exports_exported_by_users_id_fk',
    }),
  ],
)

export const reportFilters = pgTable(
  'report_filters',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    reportId: uuid('report_id').notNull(),
    fieldPath: varchar('field_path', { length: 255 }).notNull(),
    operator: varchar({ length: 50 }).notNull(),
    value: text(),
    value2: text(),
    displayOrder: integer('display_order').default(0).notNull(),
  },
  (table) => [
    index('idx_report_filters_report').using(
      'btree',
      table.reportId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.reportId],
      foreignColumns: [reports.id],
      name: 'report_filters_report_id_reports_id_fk',
    }).onDelete('cascade'),
  ],
)

export const reportSorts = pgTable(
  'report_sorts',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    reportId: uuid('report_id').notNull(),
    fieldPath: varchar('field_path', { length: 255 }).notNull(),
    direction: varchar({ length: 10 }).default('asc').notNull(),
    priority: integer().default(0).notNull(),
  },
  (table) => [
    index('idx_report_sorts_report').using(
      'btree',
      table.reportId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.reportId],
      foreignColumns: [reports.id],
      name: 'report_sorts_report_id_reports_id_fk',
    }).onDelete('cascade'),
  ],
)

export const authEvents = pgTable(
  'auth_events',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    userId: uuid('user_id'),
    eventType: varchar('event_type', { length: 50 }).notNull(),
    ipAddress: varchar('ip_address', { length: 45 }),
    metadata: jsonb(),
    timestamp: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'auth_events_user_id_users_id_fk',
    }),
  ],
)

export const organizations = pgTable(
  'organizations',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: varchar({ length: 200 }).notNull(),
    slug: varchar({ length: 100 }).notNull(),
    active: boolean().default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [unique('organizations_slug_unique').on(table.slug)],
)

export const items = pgTable(
  'items',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    masterId: uuid('master_id').notNull(),
    itemNumber: varchar('item_number', { length: 100 }).notNull(),
    revision: varchar({ length: 10 }).notNull(),
    itemType: varchar('item_type', { length: 50 }).notNull(),
    name: varchar({ length: 500 }),
    state: varchar({ length: 50 }).default('Draft').notNull(),
    isCurrent: boolean('is_current').default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by').notNull(),
    modifiedAt: timestamp('modified_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    modifiedBy: uuid('modified_by').notNull(),
    organizationId: uuid('organization_id').notNull(),
    lockedBy: uuid('locked_by'),
    lockedAt: timestamp('locked_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    index('idx_current').using(
      'btree',
      table.isCurrent.asc().nullsLast().op('bool_ops'),
    ),
    index('idx_item_type_state').using(
      'btree',
      table.itemType.asc().nullsLast().op('text_ops'),
      table.state.asc().nullsLast().op('text_ops'),
    ),
    index('idx_master_id').using(
      'btree',
      table.masterId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_organization').using(
      'btree',
      table.organizationId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: 'items_created_by_users_id_fk',
    }),
    foreignKey({
      columns: [table.modifiedBy],
      foreignColumns: [users.id],
      name: 'items_modified_by_users_id_fk',
    }),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
      name: 'items_organization_id_organizations_id_fk',
    }),
    foreignKey({
      columns: [table.lockedBy],
      foreignColumns: [users.id],
      name: 'items_locked_by_users_id_fk',
    }),
    unique('items_item_number_revision_unique').on(
      table.revision,
      table.itemNumber,
    ),
  ],
)

export const workflowHistory = pgTable(
  'workflow_history',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    instanceId: uuid('instance_id').notNull(),
    fromState: varchar('from_state', { length: 100 }),
    toState: varchar('to_state', { length: 100 }),
    action: varchar({ length: 200 }),
    actorId: uuid('actor_id'),
    timestamp: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    comments: text(),
    data: jsonb(),
  },
  (table) => [
    foreignKey({
      columns: [table.instanceId],
      foreignColumns: [workflowInstances.id],
      name: 'workflow_history_instance_id_workflow_instances_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [users.id],
      name: 'workflow_history_actor_id_users_id_fk',
    }),
  ],
)

export const settings = pgTable(
  'settings',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    key: varchar({ length: 100 }).notNull(),
    value: text(),
    jsonValue: jsonb('json_value'),
    description: text(),
    modifiedAt: timestamp('modified_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    modifiedBy: uuid('modified_by').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.modifiedBy],
      foreignColumns: [users.id],
      name: 'settings_modified_by_users_id_fk',
    }),
    unique('settings_key_unique').on(table.key),
  ],
)

export const partCotsMapping = pgTable(
  'part_cots_mapping',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    partId: uuid('part_id').notNull(),
    cotsComponentId: uuid('cots_component_id').notNull(),
    isPreferred: boolean('is_preferred').default(false),
    notes: text(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by'),
  },
  (table) => [
    index('part_cots_mapping_cots_idx').using(
      'btree',
      table.cotsComponentId.asc().nullsLast().op('uuid_ops'),
    ),
    index('part_cots_mapping_part_idx').using(
      'btree',
      table.partId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.partId],
      foreignColumns: [parts.itemId],
      name: 'part_cots_mapping_part_id_parts_item_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.cotsComponentId],
      foreignColumns: [cotsComponents.id],
      name: 'part_cots_mapping_cots_component_id_cots_components_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: 'part_cots_mapping_created_by_users_id_fk',
    }),
  ],
)

export const reportColumns = pgTable(
  'report_columns',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    reportId: uuid('report_id').notNull(),
    fieldPath: varchar('field_path', { length: 255 }).notNull(),
    label: varchar({ length: 255 }).notNull(),
    displayOrder: integer('display_order').default(0).notNull(),
    formatType: varchar('format_type', { length: 50 }),
    isVisible: boolean('is_visible').default(true).notNull(),
    width: integer(),
  },
  (table) => [
    index('idx_report_columns_report').using(
      'btree',
      table.reportId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.reportId],
      foreignColumns: [reports.id],
      name: 'report_columns_report_id_reports_id_fk',
    }).onDelete('cascade'),
  ],
)

export const itemTypeConfigs = pgTable(
  'item_type_configs',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    itemType: varchar('item_type', { length: 50 }).notNull(),
    config: jsonb().notNull(),
    version: integer().default(1).notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    modifiedBy: uuid('modified_by').notNull(),
    modifiedAt: timestamp('modified_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.modifiedBy],
      foreignColumns: [users.id],
      name: 'item_type_configs_modified_by_users_id_fk',
    }),
    unique('item_type_configs_item_type_unique').on(table.itemType),
  ],
)

export const errorLogs = pgTable(
  'error_logs',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    code: text().notNull(),
    message: text().notNull(),
    severity: text().notNull(),
    httpStatus: integer('http_status'),
    isOperational: boolean('is_operational').default(true),
    requestId: text('request_id'),
    userId: uuid('user_id'),
    resource: text(),
    operation: text(),
    method: text(),
    path: text(),
    userAgent: text('user_agent'),
    stack: text(),
    context: jsonb(),
    fieldErrors: jsonb('field_errors'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_error_logs_code').using(
      'btree',
      table.code.asc().nullsLast().op('text_ops'),
    ),
    index('idx_error_logs_created_at').using(
      'btree',
      table.createdAt.asc().nullsLast().op('timestamptz_ops'),
    ),
    index('idx_error_logs_severity').using(
      'btree',
      table.severity.asc().nullsLast().op('text_ops'),
    ),
    index('idx_error_logs_user_id').using(
      'btree',
      table.userId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'error_logs_user_id_users_id_fk',
    }).onDelete('set null'),
  ],
)
