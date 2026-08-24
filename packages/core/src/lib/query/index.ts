// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The app's data-fetching layer.
 *
 * One cache, one set of keys, one place that knows what a mutation
 * invalidates. Route loaders prime it via `ensureQueryData`; components read
 * the same keys via `useQuery`; mutations refresh it via
 * `useInvalidateResources` or `useResourceMutation`.
 *
 * See `docs/development/data-fetching.md`.
 */

export { createQueryClient, queryClient } from './client'
export { RESOURCES, qk } from './keys'
export type { Resource } from './keys'
export {
  expandResources,
  invalidateEverything,
  invalidateResources,
} from './invalidation'
export { useInvalidateResources, useResourceMutation } from './hooks'
export type { ResourceMutationOptions } from './hooks'
export {
  DEFAULT_PAGE_SIZE,
  gridParamsFromSearch,
  gridParamsToSearchParams,
  gridUrlStateFromSearch,
  toGridParams,
} from './grid-params'
export type {
  GridParams,
  GridQuery,
  GridQueryFactory,
  GridQueryResult,
  GridUrlState,
} from './grid-params'

export {
  collectionQuery,
  entityQuery,
  entitySubQuery,
} from './options/entities'
export {
  itemCollectionQuery,
  itemCountsQuery,
  itemGridQuery,
  itemListQuery,
} from './options/items'
export type { ItemFilters } from './options/items'
export {
  designBranchesQuery,
  designCountsQuery,
  designDetailQuery,
  designFamiliesQuery,
  designGridQuery,
  designListQuery,
  designTagsQuery,
} from './options/designs'
export type {
  DesignBranch,
  DesignCounts,
  DesignFamily,
  DesignTag,
} from './options/designs'
export {
  changeActionOptionsQuery,
  changeOrderAffectedItemsQuery,
  changeOrderApprovalsQuery,
  changeOrderDesignsQuery,
  changeOrderDetailQuery,
  ecoDesignStructureQuery,
  changeOrderSummaryQuery,
  changeOrderWorkflowStructureQuery,
  editableChangeOrdersQuery,
} from './options/change-orders'
export type {
  ChangeOrderApprovals,
  ChangeOrderWorkflowStructure,
  EcoDesignStructure,
  EcoAffectedItem,
  EcoDesign,
  EcoDesignSummary,
  EcoSummary,
  EditableChangeOrder,
} from './options/change-orders'
export {
  testCaseExecutionsQuery,
  testPlanTestCasesQuery,
} from './options/tests'
export type { TestExecution, TestPlanTestCase } from './options/tests'
export { itemModelVersionsQuery } from './options/model-versions'
export type {
  ModelVersionEntry,
  ModelVersionFile,
  ModelVersionFileSource,
} from './options/model-versions'
export { designItemsGridQuery } from './options/design-items'
export type { DesignItem, DesignItemsContext } from './options/design-items'
export { authSessionQuery, currentUserPermissionsQuery } from './options/auth'
export type {
  CurrentUserPermissions,
  SessionState,
  SessionSetupStatus,
} from './options/auth'
export {
  programCountsQuery,
  programDetailQuery,
  programGridQuery,
  programListQuery,
  programMembersQuery,
} from './options/programs'
export type { ProgramCounts } from './options/programs'
export {
  workspaceCommitsQuery,
  workspaceDetailQuery,
  workspaceItemsQuery,
  workspaceListQuery,
} from './options/workspaces'
export type {
  Workspace,
  WorkspaceCommit,
  WorkspaceDetail,
  WorkspaceItem,
} from './options/workspaces'
export {
  workInstructionAlertCountQuery,
  workInstructionDetailQuery,
  workInstructionOperationsQuery,
  workInstructionUsageQuery,
} from './options/work-instructions'
export {
  workOrderDetailQuery,
  workOrderExecutionQuery,
  workOrderExecutionsQuery,
  workOrderInstructionQuery,
  workOrderInstructionsQuery,
  workOrderListQuery,
  workOrderMaterialsQuery,
  workOrderProducedQuery,
  workOrderQualificationQuery,
} from './options/work-orders'
export type {
  QualificationEvidence,
  QualificationGap,
  QualificationRow,
  WorkOrderList,
  WorkOrderMaterial,
  WorkOrderProducedUnit,
  WorkOrderQualification,
} from './options/work-orders'
export {
  physicalPartAsBuiltQuery,
  physicalPartDetailQuery,
  physicalPartEvidenceQuery,
  physicalPartGenealogyQuery,
  physicalPartListQuery,
} from './options/physical-parts'
export type {
  AsBuiltComparison,
  AsBuiltLine,
  GenealogyNode,
  PhysicalPartDetail,
  PhysicalPartEvidenceLink,
  PhysicalPartGenealogy,
  PhysicalPartRow,
  PhysicalPartSearch,
} from './options/physical-parts'
export {
  activeUserListQuery,
  adminUserListQuery,
  roleListQuery,
  userDetailQuery,
  userListQuery,
} from './options/users'
export type { AdminUser } from './options/users'
export { fileListQuery } from './options/files'
export { reportDetailQuery, reportListQuery } from './options/reports'
export { dashboardChartsQuery, dashboardStatsQuery } from './options/dashboard'
export type {
  DashboardCategoryPoint,
  DashboardChartData,
  DashboardSeriesPoint,
  DashboardStats,
} from './options/dashboard'
export {
  lifecycleListQuery,
  lifecycleByItemTypeQuery,
  releasedFamilyStateIds,
} from './options/lifecycles'
export type { ItemTypeLifecycle } from './options/lifecycles'
export { aiSettingsQuery, vaultConfigQuery } from './options/admin'
export type {
  AiProviderSettings,
  AiSettings,
  AiSettingsEnvVars,
} from './options/admin'
export {
  adminApiKeyActivityQuery,
  adminApiKeysQuery,
  apiKeyPolicyQuery,
  myApiKeyActivityQuery,
  myApiKeysQuery,
} from './options/api-keys'
export type {
  AdminApiKeyRecord,
  ApiKeyEvent,
  ApiKeyRecord,
} from './options/api-keys'
export {
  itemTypeConfigListQuery,
  itemTypeConfigQuery,
} from './options/item-types'
export type {
  ItemTypeConfig,
  ItemTypeConfigDetail,
  ItemTypeConfigOverrides,
  ItemTypeConfigSummary,
  ItemTypePermissions,
  ItemTypeRelationship,
  ItemTypeRuntimeConfig,
  ItemTypeState,
  WorkflowsByChangeType,
} from './options/item-types'
export {
  catalogCategoryListQuery,
  catalogEntryListQuery,
} from './options/component-catalog'
export type {
  CatalogCategory,
  CatalogEntryPage,
  CatalogEntrySearch,
} from './options/component-catalog'
export { jobDetailQuery, jobListQuery } from './options/jobs'
export type { Job, JobDetail, JobLog } from './options/jobs'
export { packageListQuery } from './options/packages'
export { itemCheckoutQuery } from './options/checkout'
export {
  itemBomTreeQuery,
  itemGraphQuery,
  itemRelationshipsQuery,
  itemWhereUsedQuery,
} from './options/relationships'
export type {
  ItemGraph,
  ItemGraphDirection,
  ItemGraphParams,
  ItemRelationshipContext,
} from './options/relationships'
export { designStatusQuery } from './options/branches'
export type { DesignStatus } from './options/branches'
export { searchResultsGridQuery } from './options/enterprise-search'
export type { SearchResultRow } from './options/enterprise-search'
export { itemSearchQuery } from './options/item-search'
export type { ItemSearchParams } from './options/item-search'
export { itemRevisionHistoryQuery } from './options/item-history'
