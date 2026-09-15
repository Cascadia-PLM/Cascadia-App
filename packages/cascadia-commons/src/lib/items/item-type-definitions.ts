// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Shared Item Type Definitions
 *
 * Platform-agnostic metadata for all item types. Contains everything
 * EXCEPT `components` (which differ between server and client).
 *
 * Both registerItemTypes.server.ts and registerItemTypes.tsx import
 * from here and add their own components, ensuring definitions
 * never drift out of sync.
 */

import { LIFECYCLE_IDS } from './lifecycle-ids'
import { partRelationships, partSchema } from './types/part'
import { taskRelationships, taskSchema } from './types/task'
import { documentRelationships, documentSchema } from './types/document'
import {
  requirementRelationships,
  requirementSchema,
} from './types/requirement'
import {
  changeOrderRelationships,
  changeOrderSchema,
} from './types/change-order'
import { testPlanRelationships, testPlanSchema } from './types/testplan'
import { testCaseRelationships, testCaseSchema } from './types/testcase'
import {
  workInstructionRelationships,
  workInstructionSchema,
} from './types/work-instruction'
import { issueRelationships, issueSchema } from './types/issue'
import { toolRelationships, toolSchema } from './types/tool'
import {
  physicalPartRelationships,
  physicalPartSchema,
} from './types/physical-part'
import { workOrderItemSchema, workOrderRelationships } from './types/work-order'
import { softwareRelationships, softwareSchema } from './types/software'
import type { RelationshipConfig } from './types/base'
import type { ResourceType } from '../auth/permissions'
import type { z } from 'zod'

/**
 * Everything about an item type except its UI components.
 */
export interface SharedItemTypeDef {
  name: string
  /**
   * The RBAC resource this type's permissions are held against. Every route,
   * AI tool and MCP handler resolves an item type to one of these and then
   * asks the roles table; a type that reaches the fallback would be charged
   * another type's permission, so it is declared here where the entry does
   * not typecheck without it.
   */
  resource: ResourceType
  /**
   * Base path of the type's detail route (`/parts` -> `/parts/$id`). Read by
   * every surface that links to an item — search results, the digital thread,
   * BOM tables. A type missing from the old hand-kept map was simply
   * unlinkable, with nothing to say so.
   */
  detailPath: string
  label: string
  pluralLabel: string
  icon: string
  schema: z.ZodSchema
  lifecycleDefinitionId: string
  relationships: Array<RelationshipConfig>
  searchableFields: Array<string>
  displayField: string
}

/**
 * All item type definitions, keyed by type name.
 */
export const ITEM_TYPE_DEFINITIONS: Record<string, SharedItemTypeDef> = {
  Part: {
    name: 'Part',
    resource: 'parts',
    detailPath: '/parts',
    label: 'Part',
    pluralLabel: 'Parts',
    icon: 'Package',
    schema: partSchema,
    lifecycleDefinitionId: LIFECYCLE_IDS.part,
    relationships: partRelationships,
    searchableFields: ['itemNumber', 'name', 'description', 'material'],
    displayField: 'itemNumber',
  },

  Document: {
    name: 'Document',
    resource: 'documents',
    detailPath: '/documents',
    label: 'Document',
    pluralLabel: 'Documents',
    icon: 'FileText',
    schema: documentSchema,
    lifecycleDefinitionId: LIFECYCLE_IDS.document,
    relationships: documentRelationships,
    searchableFields: ['itemNumber', 'name', 'description', 'fileName'],
    displayField: 'itemNumber',
  },

  Requirement: {
    name: 'Requirement',
    resource: 'requirements',
    detailPath: '/requirements',
    label: 'Requirement',
    pluralLabel: 'Requirements',
    icon: 'ListChecks',
    schema: requirementSchema,
    lifecycleDefinitionId: LIFECYCLE_IDS.requirement,
    relationships: requirementRelationships,
    searchableFields: [
      'itemNumber',
      'name',
      'description',
      'category',
      'source',
    ],
    displayField: 'itemNumber',
  },

  Task: {
    name: 'Task',
    resource: 'tasks',
    detailPath: '/tasks',
    label: 'Task',
    pluralLabel: 'Tasks',
    icon: 'CheckSquare',
    schema: taskSchema,
    lifecycleDefinitionId: LIFECYCLE_IDS.task,
    relationships: taskRelationships,
    searchableFields: ['itemNumber', 'name', 'description'],
    displayField: 'itemNumber',
  },

  ChangeOrder: {
    name: 'ChangeOrder',
    resource: 'change_orders',
    detailPath: '/change-orders',
    label: 'Change Order',
    pluralLabel: 'Change Orders',
    icon: 'GitBranch',
    schema: changeOrderSchema,
    lifecycleDefinitionId: LIFECYCLE_IDS.changeOrder,
    relationships: changeOrderRelationships,
    searchableFields: [
      'itemNumber',
      'name',
      'reasonForChange',
      'impactDescription',
    ],
    displayField: 'itemNumber',
  },

  TestPlan: {
    name: 'TestPlan',
    resource: 'test_plans',
    detailPath: '/test-plans',
    label: 'Test Plan',
    pluralLabel: 'Test Plans',
    icon: 'ClipboardList',
    schema: testPlanSchema,
    lifecycleDefinitionId: LIFECYCLE_IDS.testPlan,
    relationships: testPlanRelationships,
    searchableFields: ['itemNumber', 'name', 'scope', 'environment'],
    displayField: 'itemNumber',
  },

  TestCase: {
    name: 'TestCase',
    resource: 'test_cases',
    detailPath: '/test-cases',
    label: 'Test Case',
    pluralLabel: 'Test Cases',
    icon: 'TestTube2',
    schema: testCaseSchema,
    lifecycleDefinitionId: LIFECYCLE_IDS.testCase,
    relationships: testCaseRelationships,
    searchableFields: ['itemNumber', 'name', 'preconditions', 'testType'],
    displayField: 'itemNumber',
  },

  Issue: {
    name: 'Issue',
    resource: 'issues',
    detailPath: '/issues',
    label: 'Issue',
    pluralLabel: 'Issues',
    icon: 'AlertTriangle',
    schema: issueSchema,
    lifecycleDefinitionId: LIFECYCLE_IDS.issue,
    relationships: issueRelationships,
    searchableFields: [
      'itemNumber',
      'name',
      'description',
      'category',
      'resolution',
      'rootCause',
    ],
    displayField: 'itemNumber',
  },

  WorkInstruction: {
    name: 'WorkInstruction',
    resource: 'work_instructions',
    detailPath: '/work-instructions',
    label: 'Work Instruction',
    pluralLabel: 'Work Instructions',
    icon: 'ClipboardCheck',
    schema: workInstructionSchema,
    lifecycleDefinitionId: LIFECYCLE_IDS.workInstruction,
    relationships: workInstructionRelationships,
    searchableFields: [
      'itemNumber',
      'name',
      'description',
      'safetyNotes',
      'requiredTools',
    ],
    displayField: 'itemNumber',
  },

  Software: {
    name: 'Software',
    resource: 'software',
    detailPath: '/software',
    label: 'Software',
    pluralLabel: 'Software',
    icon: 'Cpu',
    schema: softwareSchema,
    lifecycleDefinitionId: LIFECYCLE_IDS.part,
    relationships: softwareRelationships,
    searchableFields: [
      'itemNumber',
      'name',
      'description',
      'version',
      'targetHardware',
    ],
    displayField: 'itemNumber',
  },

  Tool: {
    name: 'Tool',
    resource: 'tools',
    detailPath: '/tools',
    label: 'Tool',
    pluralLabel: 'Tools',
    icon: 'Wrench',
    schema: toolSchema,
    lifecycleDefinitionId: LIFECYCLE_IDS.tool,
    relationships: toolRelationships,
    searchableFields: [
      'itemNumber',
      'name',
      'manufacturer',
      'model',
      'location',
    ],
    displayField: 'itemNumber',
  },

  PhysicalPart: {
    name: 'PhysicalPart',
    resource: 'physical_parts',
    detailPath: '/physical-parts',
    label: 'Physical Part',
    pluralLabel: 'Physical Parts',
    icon: 'Package',
    schema: physicalPartSchema,
    lifecycleDefinitionId: LIFECYCLE_IDS.physicalPart,
    relationships: physicalPartRelationships,
    searchableFields: ['itemNumber', 'name', 'serialNumber', 'lotNumber'],
    displayField: 'itemNumber',
  },

  WorkOrder: {
    name: 'WorkOrder',
    resource: 'work_orders',
    detailPath: '/work-orders',
    label: 'Work Order',
    pluralLabel: 'Work Orders',
    icon: 'Factory',
    schema: workOrderItemSchema,
    lifecycleDefinitionId: LIFECYCLE_IDS.workOrder,
    relationships: workOrderRelationships,
    searchableFields: ['itemNumber', 'name', 'customerOrder'],
    displayField: 'itemNumber',
  },
}
