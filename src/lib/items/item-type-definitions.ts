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
import { partRelationships, partSchema, partStates } from './types/part'
import { taskRelationships, taskSchema, taskStates } from './types/task'
import {
  documentRelationships,
  documentSchema,
  documentStates,
} from './types/document'
import {
  requirementRelationships,
  requirementSchema,
  requirementStates,
} from './types/requirement'
import {
  changeOrderRelationships,
  changeOrderSchema,
  changeOrderStates,
} from './types/change-order'
import {
  testPlanRelationships,
  testPlanSchema,
  testPlanStates,
} from './types/testplan'
import {
  testCaseRelationships,
  testCaseSchema,
  testCaseStates,
} from './types/testcase'
import {
  workInstructionRelationships,
  workInstructionSchema,
  workInstructionStates,
} from './types/work-instruction'
import { issueRelationships, issueSchema, issueStates } from './types/issue'
import { toolRelationships, toolSchema, toolStates } from './types/tool'
import type { RelationshipConfig, StateConfig } from './types/base'
import type { z } from 'zod'

/**
 * Everything about an item type except its UI components.
 */
export interface SharedItemTypeDef {
  name: string
  label: string
  pluralLabel: string
  icon: string
  table: string
  schema: z.ZodSchema
  defaultState: string
  states: Array<StateConfig>
  lifecycleDefinitionId: string
  relationships: Array<RelationshipConfig>
  permissions: {
    create: Array<string>
    read: Array<string>
    update: Array<string>
    delete: Array<string>
  }
  searchableFields: Array<string>
  displayField: string
}

/**
 * All item type definitions, keyed by type name.
 */
export const ITEM_TYPE_DEFINITIONS: Record<string, SharedItemTypeDef> = {
  Part: {
    name: 'Part',
    label: 'Part',
    pluralLabel: 'Parts',
    icon: 'Package',
    table: 'parts',
    schema: partSchema,
    defaultState: 'Draft',
    states: partStates,
    lifecycleDefinitionId: LIFECYCLE_IDS.part,
    relationships: partRelationships,
    permissions: {
      create: ['*'],
      read: ['*'],
      update: ['*'],
      delete: ['Admin', 'Engineer'],
    },
    searchableFields: ['itemNumber', 'name', 'description', 'material'],
    displayField: 'itemNumber',
  },

  Document: {
    name: 'Document',
    label: 'Document',
    pluralLabel: 'Documents',
    icon: 'FileText',
    table: 'documents',
    schema: documentSchema,
    defaultState: 'Draft',
    states: documentStates,
    lifecycleDefinitionId: LIFECYCLE_IDS.document,
    relationships: documentRelationships,
    permissions: {
      create: ['*'],
      read: ['*'],
      update: ['*'],
      delete: ['Admin', 'Engineer'],
    },
    searchableFields: ['itemNumber', 'name', 'description', 'fileName'],
    displayField: 'itemNumber',
  },

  Requirement: {
    name: 'Requirement',
    label: 'Requirement',
    pluralLabel: 'Requirements',
    icon: 'ListChecks',
    table: 'requirements',
    schema: requirementSchema,
    defaultState: 'Draft',
    states: requirementStates,
    lifecycleDefinitionId: LIFECYCLE_IDS.requirement,
    relationships: requirementRelationships,
    permissions: {
      create: ['*'],
      read: ['*'],
      update: ['*'],
      delete: ['Admin', 'Engineer', 'ProductManager'],
    },
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
    label: 'Task',
    pluralLabel: 'Tasks',
    icon: 'CheckSquare',
    table: 'tasks',
    schema: taskSchema,
    defaultState: 'Backlog',
    states: taskStates,
    lifecycleDefinitionId: LIFECYCLE_IDS.task,
    relationships: taskRelationships,
    permissions: {
      create: ['*'],
      read: ['*'],
      update: ['*'],
      delete: ['Admin', 'ProjectManager', 'Engineer'],
    },
    searchableFields: ['itemNumber', 'name', 'description'],
    displayField: 'itemNumber',
  },

  ChangeOrder: {
    name: 'ChangeOrder',
    label: 'Change Order',
    pluralLabel: 'Change Orders',
    icon: 'GitBranch',
    table: 'change_orders',
    schema: changeOrderSchema,
    defaultState: 'Draft',
    states: changeOrderStates,
    lifecycleDefinitionId: LIFECYCLE_IDS.changeOrder,
    relationships: changeOrderRelationships,
    permissions: {
      create: ['*'],
      read: ['*'],
      update: ['*'],
      delete: ['Admin', 'Engineer'],
    },
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
    label: 'Test Plan',
    pluralLabel: 'Test Plans',
    icon: 'ClipboardList',
    table: 'test_plans',
    schema: testPlanSchema,
    defaultState: 'Draft',
    states: testPlanStates,
    lifecycleDefinitionId: LIFECYCLE_IDS.testPlan,
    relationships: testPlanRelationships,
    permissions: {
      create: ['*'],
      read: ['*'],
      update: ['*'],
      delete: ['Admin', 'Engineer', 'QualityEngineer'],
    },
    searchableFields: ['itemNumber', 'name', 'scope', 'environment'],
    displayField: 'itemNumber',
  },

  TestCase: {
    name: 'TestCase',
    label: 'Test Case',
    pluralLabel: 'Test Cases',
    icon: 'TestTube2',
    table: 'test_cases',
    schema: testCaseSchema,
    defaultState: 'Draft',
    states: testCaseStates,
    lifecycleDefinitionId: LIFECYCLE_IDS.testCase,
    relationships: testCaseRelationships,
    permissions: {
      create: ['*'],
      read: ['*'],
      update: ['*'],
      delete: ['Admin', 'Engineer', 'QualityEngineer'],
    },
    searchableFields: ['itemNumber', 'name', 'preconditions', 'testType'],
    displayField: 'itemNumber',
  },

  Issue: {
    name: 'Issue',
    label: 'Issue',
    pluralLabel: 'Issues',
    icon: 'AlertTriangle',
    table: 'issues',
    schema: issueSchema,
    defaultState: 'Open',
    states: issueStates,
    lifecycleDefinitionId: LIFECYCLE_IDS.issue,
    relationships: issueRelationships,
    permissions: {
      create: ['*'],
      read: ['*'],
      update: ['*'],
      delete: ['Admin', 'Engineer', 'QualityEngineer'],
    },
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
    label: 'Work Instruction',
    pluralLabel: 'Work Instructions',
    icon: 'ClipboardCheck',
    table: 'work_instructions',
    schema: workInstructionSchema,
    defaultState: 'Draft',
    states: workInstructionStates,
    lifecycleDefinitionId: LIFECYCLE_IDS.workInstruction,
    relationships: workInstructionRelationships,
    permissions: {
      create: ['*'],
      read: ['*'],
      update: ['*'],
      delete: ['Admin', 'Engineer', 'ManufacturingEngineer'],
    },
    searchableFields: [
      'itemNumber',
      'name',
      'description',
      'safetyNotes',
      'requiredTools',
    ],
    displayField: 'itemNumber',
  },

  Tool: {
    name: 'Tool',
    label: 'Tool',
    pluralLabel: 'Tools',
    icon: 'Wrench',
    table: 'tools',
    schema: toolSchema,
    defaultState: 'Draft',
    states: toolStates,
    lifecycleDefinitionId: LIFECYCLE_IDS.tool,
    relationships: toolRelationships,
    permissions: {
      create: ['*'],
      read: ['*'],
      update: ['*'],
      delete: ['Admin', 'Engineer'],
    },
    searchableFields: [
      'itemNumber',
      'name',
      'manufacturer',
      'model',
      'location',
    ],
    displayField: 'itemNumber',
  },
}
