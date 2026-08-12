// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { apiFetch } from '@/lib/api/client'

export interface ItemTypeState {
  id: string
  name: string
  color?: string
  description?: string
  isInitial?: boolean
  isFinal?: boolean
}

export interface ItemTypePermissions {
  create: Array<string>
  read: Array<string>
  update: Array<string>
  delete: Array<string>
}

export interface ItemTypeRelationship {
  type: string
  label: string
  targetTypes: Array<string>
  allowMultiple: boolean
}

export interface WorkflowsByChangeType {
  ECO?: string
  ECN?: string
  Deviation?: string
  MCO?: string
  XCO?: string
}

/** The shape both the code definition and the merged view are reported in. */
export interface ItemTypeConfig {
  label: string
  pluralLabel: string
  icon: string
  defaultState?: string
  states: Array<ItemTypeState>
  lifecycleDefinitionId?: string
  permissions: ItemTypePermissions
  relationships: Array<ItemTypeRelationship>
  searchableFields?: Array<string>
  displayField?: string
}

/** The subset an administrator may override at runtime. */
export interface ItemTypeConfigOverrides {
  label?: string
  pluralLabel?: string
  icon?: string
  lifecycleDefinitionId?: string | null
  permissions?: ItemTypePermissions
  workflowsByChangeType?: WorkflowsByChangeType
}

export interface ItemTypeRuntimeConfig {
  id: string
  version: number
  isActive: boolean
  config: ItemTypeConfigOverrides
  modifiedAt: string
  modifiedBy: string
}

export interface ItemTypeConfigSummary {
  itemType: string
  hasCodeDefinition: boolean
  hasRuntimeConfig: boolean
  codeConfig: ItemTypeConfig | null
  runtimeConfig: ItemTypeRuntimeConfig | null
  mergedConfig: ItemTypeConfig
}

export interface ItemTypeConfigDetail {
  itemType: string
  codeConfig: ItemTypeConfig
  runtimeConfig: ItemTypeRuntimeConfig | null
  mergedConfig: ItemTypeConfig | null
}

/**
 * Every registered item type with its code definition, any runtime override,
 * and the merge of the two.
 *
 * Keyed under `admin`, which fans out to `items` — a label or permission
 * override changes how every item of that type renders.
 */
export function itemTypeConfigListQuery() {
  return queryOptions({
    queryKey: qk.collection('admin', 'item-type-configs'),
    queryFn: async (): Promise<Array<ItemTypeConfigSummary>> => {
      const result = await apiFetch<{
        data: { configs: Array<ItemTypeConfigSummary> }
      }>('/api/v1/admin/item-type-configs')
      return result.data.configs
    },
  })
}

/** One item type's configuration, as read by the editor. */
export function itemTypeConfigQuery(itemType: string) {
  return queryOptions({
    queryKey: qk.collection('admin', 'item-type-config', itemType),
    queryFn: async (): Promise<ItemTypeConfigDetail> => {
      const result = await apiFetch<{ data: ItemTypeConfigDetail }>(
        `/api/v1/admin/item-type-configs/${itemType}`,
      )
      return result.data
    },
  })
}
