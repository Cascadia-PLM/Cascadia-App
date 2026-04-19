import { relations } from 'drizzle-orm/relations'
import {
  authEvents,
  changeOrderAffectedItems,
  changeOrderImpactReports,
  changeOrderImpactedItems,
  changeOrderRisks,
  changeOrders,
  cotsComponents,
  documents,
  errorLogs,
  files,
  itemRelationships,
  itemTypeConfigs,
  items,
  organizations,
  partCotsMapping,
  parts,
  projects,
  reportColumns,
  reportExecutions,
  reportExports,
  reportFilters,
  reportSorts,
  reports,
  requirements,
  roles,
  sessions,
  settings,
  tasks,
  userRoles,
  users,
  vaultFileHistory,
  vaultFiles,
  workflowDefinitions,
  workflowHistory,
  workflowInstances,
} from './schema'

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}))

export const usersRelations = relations(users, ({ one, many }) => ({
  sessions: many(sessions),
  changeOrders: many(changeOrders),
  userRoles: many(userRoles),
  changeOrderRisks: many(changeOrderRisks),
  organization: one(organizations, {
    fields: [users.organizationId],
    references: [organizations.id],
  }),
  changeOrderAffectedItems: many(changeOrderAffectedItems),
  itemRelationships: many(itemRelationships),
  files: many(files),
  projects: many(projects),
  tasks: many(tasks),
  vaultFiles_checkedOutBy: many(vaultFiles, {
    relationName: 'vaultFiles_checkedOutBy_users_id',
  }),
  vaultFiles_uploadedBy: many(vaultFiles, {
    relationName: 'vaultFiles_uploadedBy_users_id',
  }),
  vaultFiles_deletedBy: many(vaultFiles, {
    relationName: 'vaultFiles_deletedBy_users_id',
  }),
  vaultFileHistories: many(vaultFileHistory),
  reports_createdBy: many(reports, {
    relationName: 'reports_createdBy_users_id',
  }),
  reports_modifiedBy: many(reports, {
    relationName: 'reports_modifiedBy_users_id',
  }),
  reportExecutions: many(reportExecutions),
  reportExports: many(reportExports),
  authEvents: many(authEvents),
  items_createdBy: many(items, {
    relationName: 'items_createdBy_users_id',
  }),
  items_modifiedBy: many(items, {
    relationName: 'items_modifiedBy_users_id',
  }),
  items_lockedBy: many(items, {
    relationName: 'items_lockedBy_users_id',
  }),
  workflowHistories: many(workflowHistory),
  settings: many(settings),
  partCotsMappings: many(partCotsMapping),
  itemTypeConfigs: many(itemTypeConfigs),
  errorLogs: many(errorLogs),
}))

export const changeOrdersRelations = relations(
  changeOrders,
  ({ one, many }) => ({
    item: one(items, {
      fields: [changeOrders.itemId],
      references: [items.id],
    }),
    user: one(users, {
      fields: [changeOrders.approvedBy],
      references: [users.id],
    }),
    changeOrderImpactReports: many(changeOrderImpactReports),
    changeOrderImpactedItems: many(changeOrderImpactedItems),
    changeOrderRisks: many(changeOrderRisks),
    changeOrderAffectedItems: many(changeOrderAffectedItems),
  }),
)

export const itemsRelations = relations(items, ({ one, many }) => ({
  changeOrders: many(changeOrders),
  changeOrderImpactedItems: many(changeOrderImpactedItems),
  changeOrderAffectedItems_affectedItemId: many(changeOrderAffectedItems, {
    relationName: 'changeOrderAffectedItems_affectedItemId_items_id',
  }),
  changeOrderAffectedItems_replacementItemId: many(changeOrderAffectedItems, {
    relationName: 'changeOrderAffectedItems_replacementItemId_items_id',
  }),
  itemRelationships_sourceId: many(itemRelationships, {
    relationName: 'itemRelationships_sourceId_items_id',
  }),
  itemRelationships_targetId: many(itemRelationships, {
    relationName: 'itemRelationships_targetId_items_id',
  }),
  documents: many(documents),
  files: many(files),
  projects_itemId: many(projects, {
    relationName: 'projects_itemId_items_id',
  }),
  projects_parentProjectId: many(projects, {
    relationName: 'projects_parentProjectId_items_id',
  }),
  parts: many(parts),
  tasks_itemId: many(tasks, {
    relationName: 'tasks_itemId_items_id',
  }),
  tasks_projectId: many(tasks, {
    relationName: 'tasks_projectId_items_id',
  }),
  tasks_parentTaskId: many(tasks, {
    relationName: 'tasks_parentTaskId_items_id',
  }),
  workflowInstances: many(workflowInstances),
  vaultFiles: many(vaultFiles),
  requirements: many(requirements),
  user_createdBy: one(users, {
    fields: [items.createdBy],
    references: [users.id],
    relationName: 'items_createdBy_users_id',
  }),
  user_modifiedBy: one(users, {
    fields: [items.modifiedBy],
    references: [users.id],
    relationName: 'items_modifiedBy_users_id',
  }),
  organization: one(organizations, {
    fields: [items.organizationId],
    references: [organizations.id],
  }),
  user_lockedBy: one(users, {
    fields: [items.lockedBy],
    references: [users.id],
    relationName: 'items_lockedBy_users_id',
  }),
}))

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, {
    fields: [userRoles.userId],
    references: [users.id],
  }),
  role: one(roles, {
    fields: [userRoles.roleId],
    references: [roles.id],
  }),
}))

export const rolesRelations = relations(roles, ({ many }) => ({
  userRoles: many(userRoles),
}))

export const changeOrderImpactReportsRelations = relations(
  changeOrderImpactReports,
  ({ one }) => ({
    changeOrder: one(changeOrders, {
      fields: [changeOrderImpactReports.changeOrderId],
      references: [changeOrders.itemId],
    }),
  }),
)

export const changeOrderImpactedItemsRelations = relations(
  changeOrderImpactedItems,
  ({ one }) => ({
    item: one(items, {
      fields: [changeOrderImpactedItems.impactedItemId],
      references: [items.id],
    }),
    changeOrder: one(changeOrders, {
      fields: [changeOrderImpactedItems.changeOrderId],
      references: [changeOrders.itemId],
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
    user: one(users, {
      fields: [changeOrderRisks.acknowledgedBy],
      references: [users.id],
    }),
  }),
)

export const organizationsRelations = relations(organizations, ({ many }) => ({
  users: many(users),
  items: many(items),
}))

export const changeOrderAffectedItemsRelations = relations(
  changeOrderAffectedItems,
  ({ one }) => ({
    item_affectedItemId: one(items, {
      fields: [changeOrderAffectedItems.affectedItemId],
      references: [items.id],
      relationName: 'changeOrderAffectedItems_affectedItemId_items_id',
    }),
    item_replacementItemId: one(items, {
      fields: [changeOrderAffectedItems.replacementItemId],
      references: [items.id],
      relationName: 'changeOrderAffectedItems_replacementItemId_items_id',
    }),
    user: one(users, {
      fields: [changeOrderAffectedItems.createdBy],
      references: [users.id],
    }),
    changeOrder: one(changeOrders, {
      fields: [changeOrderAffectedItems.changeOrderId],
      references: [changeOrders.itemId],
    }),
  }),
)

export const itemRelationshipsRelations = relations(
  itemRelationships,
  ({ one }) => ({
    item_sourceId: one(items, {
      fields: [itemRelationships.sourceId],
      references: [items.id],
      relationName: 'itemRelationships_sourceId_items_id',
    }),
    item_targetId: one(items, {
      fields: [itemRelationships.targetId],
      references: [items.id],
      relationName: 'itemRelationships_targetId_items_id',
    }),
    user: one(users, {
      fields: [itemRelationships.createdBy],
      references: [users.id],
    }),
  }),
)

export const documentsRelations = relations(documents, ({ one }) => ({
  item: one(items, {
    fields: [documents.itemId],
    references: [items.id],
  }),
}))

export const filesRelations = relations(files, ({ one }) => ({
  item: one(items, {
    fields: [files.itemId],
    references: [items.id],
  }),
  user: one(users, {
    fields: [files.uploadedBy],
    references: [users.id],
  }),
}))

export const projectsRelations = relations(projects, ({ one }) => ({
  item_itemId: one(items, {
    fields: [projects.itemId],
    references: [items.id],
    relationName: 'projects_itemId_items_id',
  }),
  item_parentProjectId: one(items, {
    fields: [projects.parentProjectId],
    references: [items.id],
    relationName: 'projects_parentProjectId_items_id',
  }),
  user: one(users, {
    fields: [projects.projectManager],
    references: [users.id],
  }),
}))

export const partsRelations = relations(parts, ({ one, many }) => ({
  item: one(items, {
    fields: [parts.itemId],
    references: [items.id],
  }),
  partCotsMappings: many(partCotsMapping),
}))

export const tasksRelations = relations(tasks, ({ one }) => ({
  item_itemId: one(items, {
    fields: [tasks.itemId],
    references: [items.id],
    relationName: 'tasks_itemId_items_id',
  }),
  item_projectId: one(items, {
    fields: [tasks.projectId],
    references: [items.id],
    relationName: 'tasks_projectId_items_id',
  }),
  item_parentTaskId: one(items, {
    fields: [tasks.parentTaskId],
    references: [items.id],
    relationName: 'tasks_parentTaskId_items_id',
  }),
  user: one(users, {
    fields: [tasks.assignee],
    references: [users.id],
  }),
}))

export const workflowInstancesRelations = relations(
  workflowInstances,
  ({ one, many }) => ({
    item: one(items, {
      fields: [workflowInstances.itemId],
      references: [items.id],
    }),
    workflowDefinition: one(workflowDefinitions, {
      fields: [workflowInstances.workflowDefinitionId],
      references: [workflowDefinitions.id],
    }),
    workflowHistories: many(workflowHistory),
  }),
)

export const workflowDefinitionsRelations = relations(
  workflowDefinitions,
  ({ many }) => ({
    workflowInstances: many(workflowInstances),
  }),
)

export const vaultFilesRelations = relations(vaultFiles, ({ one, many }) => ({
  item: one(items, {
    fields: [vaultFiles.itemId],
    references: [items.id],
  }),
  user_checkedOutBy: one(users, {
    fields: [vaultFiles.checkedOutBy],
    references: [users.id],
    relationName: 'vaultFiles_checkedOutBy_users_id',
  }),
  user_uploadedBy: one(users, {
    fields: [vaultFiles.uploadedBy],
    references: [users.id],
    relationName: 'vaultFiles_uploadedBy_users_id',
  }),
  user_deletedBy: one(users, {
    fields: [vaultFiles.deletedBy],
    references: [users.id],
    relationName: 'vaultFiles_deletedBy_users_id',
  }),
  vaultFileHistories: many(vaultFileHistory),
}))

export const vaultFileHistoryRelations = relations(
  vaultFileHistory,
  ({ one }) => ({
    vaultFile: one(vaultFiles, {
      fields: [vaultFileHistory.fileId],
      references: [vaultFiles.id],
    }),
    user: one(users, {
      fields: [vaultFileHistory.performedBy],
      references: [users.id],
    }),
  }),
)

export const requirementsRelations = relations(requirements, ({ one }) => ({
  item: one(items, {
    fields: [requirements.itemId],
    references: [items.id],
  }),
}))

export const reportsRelations = relations(reports, ({ one, many }) => ({
  user_createdBy: one(users, {
    fields: [reports.createdBy],
    references: [users.id],
    relationName: 'reports_createdBy_users_id',
  }),
  user_modifiedBy: one(users, {
    fields: [reports.modifiedBy],
    references: [users.id],
    relationName: 'reports_modifiedBy_users_id',
  }),
  reportExecutions: many(reportExecutions),
  reportExports: many(reportExports),
  reportFilters: many(reportFilters),
  reportSorts: many(reportSorts),
  reportColumns: many(reportColumns),
}))

export const reportExecutionsRelations = relations(
  reportExecutions,
  ({ one, many }) => ({
    report: one(reports, {
      fields: [reportExecutions.reportId],
      references: [reports.id],
    }),
    user: one(users, {
      fields: [reportExecutions.executedBy],
      references: [users.id],
    }),
    reportExports: many(reportExports),
  }),
)

export const reportExportsRelations = relations(reportExports, ({ one }) => ({
  report: one(reports, {
    fields: [reportExports.reportId],
    references: [reports.id],
  }),
  reportExecution: one(reportExecutions, {
    fields: [reportExports.executionId],
    references: [reportExecutions.id],
  }),
  user: one(users, {
    fields: [reportExports.exportedBy],
    references: [users.id],
  }),
}))

export const reportFiltersRelations = relations(reportFilters, ({ one }) => ({
  report: one(reports, {
    fields: [reportFilters.reportId],
    references: [reports.id],
  }),
}))

export const reportSortsRelations = relations(reportSorts, ({ one }) => ({
  report: one(reports, {
    fields: [reportSorts.reportId],
    references: [reports.id],
  }),
}))

export const authEventsRelations = relations(authEvents, ({ one }) => ({
  user: one(users, {
    fields: [authEvents.userId],
    references: [users.id],
  }),
}))

export const workflowHistoryRelations = relations(
  workflowHistory,
  ({ one }) => ({
    workflowInstance: one(workflowInstances, {
      fields: [workflowHistory.instanceId],
      references: [workflowInstances.id],
    }),
    user: one(users, {
      fields: [workflowHistory.actorId],
      references: [users.id],
    }),
  }),
)

export const settingsRelations = relations(settings, ({ one }) => ({
  user: one(users, {
    fields: [settings.modifiedBy],
    references: [users.id],
  }),
}))

export const partCotsMappingRelations = relations(
  partCotsMapping,
  ({ one }) => ({
    part: one(parts, {
      fields: [partCotsMapping.partId],
      references: [parts.itemId],
    }),
    cotsComponent: one(cotsComponents, {
      fields: [partCotsMapping.cotsComponentId],
      references: [cotsComponents.id],
    }),
    user: one(users, {
      fields: [partCotsMapping.createdBy],
      references: [users.id],
    }),
  }),
)

export const cotsComponentsRelations = relations(
  cotsComponents,
  ({ many }) => ({
    partCotsMappings: many(partCotsMapping),
  }),
)

export const reportColumnsRelations = relations(reportColumns, ({ one }) => ({
  report: one(reports, {
    fields: [reportColumns.reportId],
    references: [reports.id],
  }),
}))

export const itemTypeConfigsRelations = relations(
  itemTypeConfigs,
  ({ one }) => ({
    user: one(users, {
      fields: [itemTypeConfigs.modifiedBy],
      references: [users.id],
    }),
  }),
)

export const errorLogsRelations = relations(errorLogs, ({ one }) => ({
  user: one(users, {
    fields: [errorLogs.userId],
    references: [users.id],
  }),
}))
