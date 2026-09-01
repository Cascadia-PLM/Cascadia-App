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
  itemAvailableContextsQuery,
  itemCollectionQuery,
  itemCountsQuery,
  itemEditContextQuery,
  itemGridQuery,
  itemListQuery,
} from './options/items'
export type { ItemFilters } from './options/items'
export {
  designBranchesQuery,
  designEcosQuery,
  designCountsQuery,
  designDetailQuery,
  designFamiliesQuery,
  designGapAnalysisQuery,
  designHistoryGraphQuery,
  designGridQuery,
  designListQuery,
  designScopeGraphQuery,
  designStructureQuery,
  designTagsQuery,
} from './options/designs'
export type {
  DesignBranch,
  DesignCounts,
  DesignEco,
  DesignFamily,
  DesignScopeGraphParams,
  DesignStructure,
  DesignStructureContext,
  DesignTag,
  ScopeGraphDirection,
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
export { designItemsGridQuery, designItemsQuery } from './options/design-items'
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
  programHistoryGraphQuery,
  programListQuery,
  programMembersQuery,
  programScopeGraphQuery,
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
  partWorkInstructionsQuery,
  workInstructionAlertCountQuery,
  workInstructionAlertsQuery,
  workInstructionDetailQuery,
  workInstructionOperationsQuery,
  workInstructionResolvedParametricsQuery,
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
export {
  reportDetailQuery,
  reportExecutionQuery,
  reportListQuery,
} from './options/reports'
export type { ReportExecutionParams } from './options/reports'
export { dashboardChartsQuery, dashboardStatsQuery } from './options/dashboard'
export type {
  DashboardCategoryPoint,
  DashboardChartData,
  DashboardSeriesPoint,
  DashboardStats,
} from './options/dashboard'
export {
  itemTransitionsQuery,
  lifecycleListQuery,
  lifecycleByItemTypeQuery,
  releasedFamilyStateIds,
} from './options/lifecycles'
export type { ItemTypeLifecycle } from './options/lifecycles'
export {
  aiSettingsQuery,
  settingQuery,
  vaultConfigQuery,
} from './options/admin'
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
export { jobDetailQuery, jobListQuery, jobStatusQuery } from './options/jobs'
export type { Job, JobDetail, JobLog, JobStatusSnapshot } from './options/jobs'
export { packageListQuery } from './options/packages'
export { itemCheckoutQuery } from './options/checkout'
export {
  itemBomTreeQuery,
  itemGraphQuery,
  itemRelationshipsQuery,
  itemThreadQuery,
  itemWhereUsedQuery,
  threadComparisonTargetsQuery,
} from './options/relationships'
export type {
  ItemGraph,
  ItemGraphDirection,
  ItemGraphParams,
  ItemRelationshipContext,
  ItemThreadParams,
} from './options/relationships'
export { branchDetailQuery, designStatusQuery } from './options/branches'
export type { BranchDetail, DesignStatus } from './options/branches'
export {
  enterpriseSearchQuery,
  searchResultsGridQuery,
} from './options/enterprise-search'
export type { SearchResultRow } from './options/enterprise-search'
export { itemSearchQuery, itemTextSearchQuery } from './options/item-search'
export type { ItemSearchParams } from './options/item-search'
export { itemHistoryQuery } from './options/item-history'
export { workflowDefinitionQuery } from './options/workflows'
export { upstreamChangesQuery } from './options/mbom'
export type { UpstreamChange } from './options/mbom'
export { aiSessionMessagesQuery, aiSessionsQuery } from './options/ai'
export type { AiChatSession } from './options/ai'
export {
  softwareDiffQuery,
  softwareFileQuery,
  softwareTreeQuery,
  softwareVersionsQuery,
} from './options/software'
export type {
  SoftwareDiffChange,
  SoftwareFile,
  SoftwareManifestEntry,
  SoftwareTree,
  SoftwareVersion,
} from './options/software'
