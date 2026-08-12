// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { entityQuery, entitySubQuery } from './entities'
import type {
  InstructionExecution,
  WorkOrder,
  WorkOrderInstruction,
} from '@/lib/items/types/work-order'
import { apiFetch } from '@/lib/api/client'

export interface WorkOrderList {
  workOrders: Array<WorkOrder>
  total: number
}

/** Every work order, with the server's total. */
export function workOrderListQuery() {
  return queryOptions({
    queryKey: qk.list('work-orders', {}),
    queryFn: async (): Promise<WorkOrderList> => {
      const result = await apiFetch<{ data: WorkOrderList }>(
        '/api/v1/work-orders',
      )
      return result.data
    },
  })
}

export function workOrderDetailQuery(id: string) {
  return entityQuery<WorkOrder>('work-orders', id, 'workOrder')
}

/**
 * The traveler — instruction lines carried by one order, in build sequence.
 *
 * Keyed beneath the order, so releasing, skipping, or running a line
 * refreshes the order header and its other panels along with the list.
 */
export function workOrderInstructionsQuery(workOrderId: string) {
  return entitySubQuery<WorkOrderInstruction>(
    'work-orders',
    workOrderId,
    'instructions',
    'instructions',
  )
}

/** One traveler line, keyed beneath the traveler it belongs to. */
export function workOrderInstructionQuery(
  workOrderId: string,
  instructionId: string,
) {
  return queryOptions({
    queryKey: qk.sub('work-orders', workOrderId, 'instructions', instructionId),
    queryFn: async (): Promise<WorkOrderInstruction> => {
      const result = await apiFetch<{
        data: { instruction: WorkOrderInstruction }
      }>(`/api/v1/work-orders/${workOrderId}/instructions/${instructionId}`)
      return result.data.instruction
    },
  })
}

/** Every run recorded against this order's traveler. */
export function workOrderExecutionsQuery(workOrderId: string) {
  return entitySubQuery<InstructionExecution>(
    'work-orders',
    workOrderId,
    'executions',
    'executions',
  )
}

/** One execution record. */
export function workOrderExecutionQuery(
  workOrderId: string,
  executionId: string,
) {
  return queryOptions({
    queryKey: qk.sub('work-orders', workOrderId, 'executions', executionId),
    queryFn: async (): Promise<InstructionExecution> => {
      const result = await apiFetch<{
        data: { execution: InstructionExecution }
      }>(`/api/v1/work-orders/${workOrderId}/executions/${executionId}`)
      return result.data.execution
    },
  })
}

export interface WorkOrderMaterial {
  edgeId: string
  kind: 'unit' | 'lot' | 'bulk'
  quantity: number
  targetItemId: string
  partItemNumber: string | null
  partName: string | null
  serialNumber: string | null
  lotNumber: string | null
  partRevision: string | null
  physicalPartNumber: string | null
}

/** What this order consumed — the traceability record. */
export function workOrderMaterialsQuery(workOrderId: string) {
  return entitySubQuery<WorkOrderMaterial>(
    'work-orders',
    workOrderId,
    'materials',
    'materials',
  )
}

export interface WorkOrderProducedUnit {
  unitItemId: string
  physicalPartNumber: string
  state: string
  serialNumber: string | null
}

/** Serials built by this order. */
export function workOrderProducedQuery(workOrderId: string) {
  return entitySubQuery<WorkOrderProducedUnit>(
    'work-orders',
    workOrderId,
    'produced',
    'produced',
  )
}

export interface QualificationEvidence {
  physicalPartItemId: string
  serialNumber: string | null
  lotNumber: string | null
  note: string | null
}

export interface QualificationRow {
  requirementMasterId: string
  requirementItemId: string
  requirementNumber: string
  requirementName: string | null
  viaPartNumber: string | null
  satisfied: boolean
  evidence: Array<QualificationEvidence>
}

export interface QualificationGap {
  physicalPartItemId: string
  serialNumber: string | null
  lotNumber: string | null
  partItemNumber: string | null
}

export interface WorkOrderQualification {
  rows: Array<QualificationRow>
  gaps: Array<QualificationGap>
}

/**
 * The qualification rollup: requirements in scope, their evidence, and the
 * consumed instances nobody certified.
 */
export function workOrderQualificationQuery(workOrderId: string) {
  return queryOptions({
    queryKey: qk.sub('work-orders', workOrderId, 'qualification'),
    queryFn: async (): Promise<WorkOrderQualification> => {
      const result = await apiFetch<{ data: WorkOrderQualification }>(
        `/api/v1/work-orders/${workOrderId}/qualification`,
      )
      return result.data
    },
  })
}
