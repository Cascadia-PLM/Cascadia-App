// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Default lifecycle definitions for every item type.
 *
 * Every item type must have a lifecycle — "no lifecycle" is what every
 * `?? 'Released'` / `|| 'Draft'` fallback used to paper over, and those
 * fallbacks are gone. These are the shipped defaults: `scripts/seed-minimal.ts`
 * seeds them into real databases and the test global-setup seeds them into
 * whatever database the suite runs against, so services can rely on a
 * lifecycle existing in every environment.
 *
 * These are **configuration, not logic**. State names here are what the
 * defaults happen to call things; nothing in the application may reason from
 * the names. Logic sees only `isInitial` / `isFinal` and the change-action
 * mappings.
 *
 * ChangeOrder appears only as a minimal Driving workflow: a ChangeOrder
 * item's state mirrors its workflow instance, so state resolution needs the
 * Driving definition's isInitial flag to exist. The shipped, richer CO
 * workflows live in `scripts/seed-minimal.ts` (first-writer-wins keeps them
 * on seeded databases), and CO test suites override with their own.
 */

import { sql } from 'drizzle-orm'
import { itemTypeConfigs, users, workflowDefinitions } from '../db/schema'
import { LIFECYCLE_IDS } from './lifecycle-ids'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../db/schema'

type DbInstance = PostgresJsDatabase<typeof schema>

/**
 * Fixed system user for `modifiedBy` on config rows, matching the seed
 * script and test fixtures.
 */
const SYSTEM_USER_ID = '00000000-0000-4000-8000-000000000000'

/**
 * Canonical Driven lifecycle for versioned, ECO-controlled item types
 * (Part, Document, Requirement — and Software, which links to the Part
 * definition). All state changes go through ECOs; the change-action
 * mappings are what the merge applies at release.
 */
export const PART_LIFECYCLE_DEFINITION = {
  states: [
    {
      id: 'Draft',
      name: 'Draft',
      color: 'gray',
      isInitial: true,
      isFinal: false,
    },
    {
      id: 'Released',
      name: 'Released',
      color: 'green',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Superseded',
      name: 'Superseded',
      color: 'slate',
      isInitial: false,
      isFinal: true,
    },
    {
      id: 'Obsolete',
      name: 'Obsolete',
      color: 'red',
      isInitial: false,
      isFinal: true,
    },
  ],
  transitions: [],
  changeActionMappings: {
    release: {
      fromState: 'Draft',
      toState: 'Released',
      assignsRevision: true,
    },
    revise: {
      fromState: 'Released',
      newVersionState: 'Released',
      oldVersionState: 'Superseded',
      assignsRevision: true,
    },
    obsolete: {
      fromState: 'Released',
      toState: 'Obsolete',
      assignsRevision: false,
    },
  },
  lifecycleType: 'Driven' as const,
  applicableItemTypes: ['Part'],
}

/**
 * Requirements: Driven (versioned, ECO-released) with review progress as
 * pre-release states — Draft → Proposed → Approved, Rejected with a way back
 * — reached by manual transitions; release maps Approved → Released. The old
 * `requirements.status` column carried these positions beside the lifecycle;
 * they are the lifecycle now. Verification outcome (Passed/Failed) remains the
 * measured `verificationStatus`, not a state.
 */
export const REQUIREMENT_LIFECYCLE_DEFINITION = {
  states: [
    {
      id: 'Draft',
      name: 'Draft',
      color: 'gray',
      isInitial: true,
      isFinal: false,
    },
    {
      id: 'Proposed',
      name: 'Proposed',
      color: 'blue',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Approved',
      name: 'Approved',
      color: 'cyan',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Rejected',
      name: 'Rejected',
      color: 'orange',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Released',
      name: 'Released',
      color: 'green',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Superseded',
      name: 'Superseded',
      color: 'slate',
      isInitial: false,
      isFinal: true,
    },
    {
      id: 'Obsolete',
      name: 'Obsolete',
      color: 'red',
      isInitial: false,
      isFinal: true,
    },
  ],
  transitions: [
    {
      id: 'req-t1',
      name: 'Propose',
      fromStateId: 'Draft',
      toStateId: 'Proposed',
    },
    {
      id: 'req-t2',
      name: 'Approve',
      fromStateId: 'Proposed',
      toStateId: 'Approved',
    },
    {
      id: 'req-t3',
      name: 'Reject',
      fromStateId: 'Proposed',
      toStateId: 'Rejected',
    },
    {
      id: 'req-t4',
      name: 'Rework',
      fromStateId: 'Rejected',
      toStateId: 'Draft',
    },
    {
      id: 'req-t5',
      name: 'Rework',
      fromStateId: 'Approved',
      toStateId: 'Draft',
    },
  ],
  changeActionMappings: {
    release: {
      fromState: 'Approved',
      toState: 'Released',
      assignsRevision: true,
    },
    revise: {
      fromState: 'Released',
      newVersionState: 'Released',
      oldVersionState: 'Superseded',
      assignsRevision: true,
    },
    obsolete: {
      fromState: 'Released',
      toState: 'Obsolete',
      assignsRevision: false,
    },
  },
  lifecycleType: 'Driven' as const,
  applicableItemTypes: ['Requirement'],
}

export const WORK_ORDER_LIFECYCLE_DEFINITION = {
  states: [
    {
      id: 'Not Started',
      name: 'Not Started',
      color: 'gray',
      isInitial: true,
      isFinal: false,
    },
    {
      id: 'In Progress',
      name: 'In Progress',
      color: 'blue',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Complete',
      name: 'Complete',
      color: 'green',
      isInitial: false,
      isFinal: true,
      finalKind: 'complete' as const,
    },
    {
      id: 'Cancelled',
      name: 'Cancelled',
      color: 'red',
      isInitial: false,
      isFinal: true,
      finalKind: 'cancel' as const,
    },
  ],
  transitions: [
    {
      id: 'wo-t1',
      name: 'Start',
      fromStateId: 'Not Started',
      toStateId: 'In Progress',
    },
    {
      id: 'wo-t2',
      name: 'Cancel',
      fromStateId: 'Not Started',
      toStateId: 'Cancelled',
    },
    {
      id: 'wo-t3',
      name: 'Complete',
      fromStateId: 'In Progress',
      toStateId: 'Complete',
    },
    {
      id: 'wo-t4',
      name: 'Cancel In Progress',
      fromStateId: 'In Progress',
      toStateId: 'Cancelled',
    },
  ],
  lifecycleType: 'Free' as const,
  applicableItemTypes: ['WorkOrder'],
}

/** Kanban flow. No 'Draft' — a task enters its own board, at Backlog. */
const TASK_LIFECYCLE_DEFINITION = {
  states: [
    {
      id: 'Backlog',
      name: 'Backlog',
      color: 'slate',
      isInitial: true,
      isFinal: false,
    },
    {
      id: 'ToDo',
      name: 'To Do',
      color: 'blue',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'InProgress',
      name: 'In Progress',
      color: 'yellow',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'InReview',
      name: 'In Review',
      color: 'purple',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Done',
      name: 'Done',
      color: 'green',
      isInitial: false,
      isFinal: true,
    },
    {
      id: 'Cancelled',
      name: 'Cancelled',
      color: 'red',
      isInitial: false,
      isFinal: true,
    },
  ],
  transitions: [
    { id: 'task-t1', name: 'Ready', fromStateId: 'Backlog', toStateId: 'ToDo' },
    {
      id: 'task-t2',
      name: 'Start',
      fromStateId: 'ToDo',
      toStateId: 'InProgress',
    },
    {
      id: 'task-t3',
      name: 'Submit for Review',
      fromStateId: 'InProgress',
      toStateId: 'InReview',
    },
    { id: 'task-t4', name: 'Done', fromStateId: 'InReview', toStateId: 'Done' },
    {
      id: 'task-t5',
      name: 'Rework',
      fromStateId: 'InReview',
      toStateId: 'InProgress',
    },
    {
      id: 'task-t6',
      name: 'Defer',
      fromStateId: 'InProgress',
      toStateId: 'ToDo',
    },
    {
      id: 'task-t7',
      name: 'Shelve',
      fromStateId: 'ToDo',
      toStateId: 'Backlog',
    },
    {
      id: 'task-t8',
      name: 'Cancel',
      fromStateId: 'Backlog',
      toStateId: 'Cancelled',
    },
    {
      id: 'task-t9',
      name: 'Cancel',
      fromStateId: 'ToDo',
      toStateId: 'Cancelled',
    },
    {
      id: 'task-t10',
      name: 'Cancel',
      fromStateId: 'InProgress',
      toStateId: 'Cancelled',
    },
    {
      id: 'task-t11',
      name: 'Cancel',
      fromStateId: 'InReview',
      toStateId: 'Cancelled',
    },
  ],
  lifecycleType: 'Free' as const,
  applicableItemTypes: ['Task'],
}

const TEST_PLAN_LIFECYCLE_DEFINITION = {
  states: [
    {
      id: 'Draft',
      name: 'Draft',
      color: 'gray',
      isInitial: true,
      isFinal: false,
    },
    {
      id: 'Active',
      name: 'Active',
      color: 'blue',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Completed',
      name: 'Completed',
      color: 'green',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Archived',
      name: 'Archived',
      color: 'slate',
      isInitial: false,
      isFinal: true,
    },
    {
      id: 'Obsolete',
      name: 'Obsolete',
      color: 'red',
      isInitial: false,
      isFinal: true,
    },
  ],
  transitions: [
    {
      id: 'tp-t1',
      name: 'Activate',
      fromStateId: 'Draft',
      toStateId: 'Active',
    },
    {
      id: 'tp-t2',
      name: 'Complete',
      fromStateId: 'Active',
      toStateId: 'Completed',
    },
    {
      id: 'tp-t3',
      name: 'Archive',
      fromStateId: 'Completed',
      toStateId: 'Archived',
    },
    {
      id: 'tp-t4',
      name: 'Obsolete',
      fromStateId: 'Draft',
      toStateId: 'Obsolete',
    },
    {
      id: 'tp-t5',
      name: 'Obsolete',
      fromStateId: 'Active',
      toStateId: 'Obsolete',
    },
    {
      id: 'tp-t6',
      name: 'Obsolete',
      fromStateId: 'Completed',
      toStateId: 'Obsolete',
    },
  ],
  lifecycleType: 'Free' as const,
  applicableItemTypes: ['TestPlan'],
}

/**
 * Mirrors the historical testCaseStates palette, execution outcomes
 * included. Whether Passed/Failed belong in the lifecycle at all is the
 * Phase 4 status-absorption question; this default preserves today's shape.
 */
const TEST_CASE_LIFECYCLE_DEFINITION = {
  states: [
    {
      id: 'Draft',
      name: 'Draft',
      color: 'gray',
      isInitial: true,
      isFinal: false,
    },
    {
      id: 'NotRun',
      name: 'Not Run',
      color: 'gray',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Passed',
      name: 'Passed',
      color: 'green',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Failed',
      name: 'Failed',
      color: 'red',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Blocked',
      name: 'Blocked',
      color: 'yellow',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Obsolete',
      name: 'Obsolete',
      color: 'red',
      isInitial: false,
      isFinal: true,
    },
  ],
  transitions: [
    { id: 'tc-t1', name: 'Ready', fromStateId: 'Draft', toStateId: 'NotRun' },
    { id: 'tc-t2', name: 'Pass', fromStateId: 'NotRun', toStateId: 'Passed' },
    { id: 'tc-t3', name: 'Fail', fromStateId: 'NotRun', toStateId: 'Failed' },
    { id: 'tc-t4', name: 'Block', fromStateId: 'NotRun', toStateId: 'Blocked' },
    { id: 'tc-t5', name: 'Re-run', fromStateId: 'Passed', toStateId: 'NotRun' },
    { id: 'tc-t6', name: 'Re-run', fromStateId: 'Failed', toStateId: 'NotRun' },
    {
      id: 'tc-t7',
      name: 'Re-run',
      fromStateId: 'Blocked',
      toStateId: 'NotRun',
    },
    {
      id: 'tc-t8',
      name: 'Obsolete',
      fromStateId: 'NotRun',
      toStateId: 'Obsolete',
    },
    {
      id: 'tc-t9',
      name: 'Obsolete',
      fromStateId: 'Passed',
      toStateId: 'Obsolete',
    },
    {
      id: 'tc-t10',
      name: 'Obsolete',
      fromStateId: 'Failed',
      toStateId: 'Obsolete',
    },
    {
      id: 'tc-t11',
      name: 'Obsolete',
      fromStateId: 'Blocked',
      toStateId: 'Obsolete',
    },
  ],
  lifecycleType: 'Free' as const,
  applicableItemTypes: ['TestCase'],
}

/**
 * Shop-floor procedures are revised informally — a Free lifecycle, not ECO
 * control. 'Released' here is reached by a manual transition, never by a
 * release mapping, so it is NOT in the released family and the branch/edit
 * machinery correctly ignores it. The frozen manufacturing record comes from
 * the work-order traveler snapshot.
 */
const WORK_INSTRUCTION_LIFECYCLE_DEFINITION = {
  states: [
    {
      id: 'Draft',
      name: 'Draft',
      color: 'gray',
      isInitial: true,
      isFinal: false,
    },
    {
      id: 'InReview',
      name: 'In Review',
      color: 'blue',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Approved',
      name: 'Approved',
      color: 'green',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Released',
      name: 'Released',
      color: 'green',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Obsolete',
      name: 'Obsolete',
      color: 'red',
      isInitial: false,
      isFinal: true,
    },
  ],
  transitions: [
    {
      id: 'wi-t1',
      name: 'Submit for Review',
      fromStateId: 'Draft',
      toStateId: 'InReview',
    },
    {
      id: 'wi-t2',
      name: 'Rework',
      fromStateId: 'InReview',
      toStateId: 'Draft',
    },
    {
      id: 'wi-t3',
      name: 'Approve',
      fromStateId: 'InReview',
      toStateId: 'Approved',
    },
    {
      id: 'wi-t4',
      name: 'Release',
      fromStateId: 'Approved',
      toStateId: 'Released',
    },
    {
      id: 'wi-t5',
      name: 'Revise',
      fromStateId: 'Released',
      toStateId: 'Draft',
    },
    {
      id: 'wi-t6',
      name: 'Obsolete',
      fromStateId: 'Released',
      toStateId: 'Obsolete',
    },
  ],
  lifecycleType: 'Free' as const,
  applicableItemTypes: ['WorkInstruction'],
}

const ISSUE_LIFECYCLE_DEFINITION = {
  states: [
    {
      id: 'Open',
      name: 'Open',
      color: 'blue',
      isInitial: true,
      isFinal: false,
    },
    {
      id: 'InProgress',
      name: 'In Progress',
      color: 'yellow',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Pending',
      name: 'Pending',
      color: 'orange',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Resolved',
      name: 'Resolved',
      color: 'green',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Verified',
      name: 'Verified',
      color: 'emerald',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Closed',
      name: 'Closed',
      color: 'slate',
      isInitial: false,
      isFinal: true,
    },
    {
      id: 'Cancelled',
      name: 'Cancelled',
      color: 'red',
      isInitial: false,
      isFinal: true,
    },
  ],
  transitions: [
    {
      id: 'issue-t1',
      name: 'Start Work',
      fromStateId: 'Open',
      toStateId: 'InProgress',
    },
    {
      id: 'issue-t2',
      name: 'Put on Hold',
      fromStateId: 'InProgress',
      toStateId: 'Pending',
    },
    {
      id: 'issue-t3',
      name: 'Resume',
      fromStateId: 'Pending',
      toStateId: 'InProgress',
    },
    {
      id: 'issue-t4',
      name: 'Resolve',
      fromStateId: 'InProgress',
      toStateId: 'Resolved',
    },
    {
      id: 'issue-t5',
      name: 'Resolve from Pending',
      fromStateId: 'Pending',
      toStateId: 'Resolved',
    },
    {
      id: 'issue-t6',
      name: 'Verify',
      fromStateId: 'Resolved',
      toStateId: 'Verified',
    },
    {
      id: 'issue-t7',
      name: 'Reopen',
      fromStateId: 'Resolved',
      toStateId: 'InProgress',
    },
    {
      id: 'issue-t8',
      name: 'Close',
      fromStateId: 'Verified',
      toStateId: 'Closed',
    },
    {
      id: 'issue-t9',
      name: 'Cancel',
      fromStateId: 'Open',
      toStateId: 'Cancelled',
    },
    {
      id: 'issue-t10',
      name: 'Cancel',
      fromStateId: 'InProgress',
      toStateId: 'Cancelled',
    },
    {
      id: 'issue-t11',
      name: 'Cancel',
      fromStateId: 'Pending',
      toStateId: 'Cancelled',
    },
  ],
  lifecycleType: 'Free' as const,
  applicableItemTypes: ['Issue'],
}

/**
 * One machine for the whole tool flow. The old `toolStatus` column
 * (available/in_use/maintenance/retired) ran a second machine beside the
 * lifecycle; its positions are mutually exclusive flow positions, so they
 * ARE lifecycle states — high flip frequency is what Free lifecycles are
 * for. 'Active' split into 'Available' and 'In Use'.
 */
const TOOL_LIFECYCLE_DEFINITION = {
  states: [
    {
      id: 'Draft',
      name: 'Draft',
      color: 'gray',
      isInitial: true,
      isFinal: false,
    },
    {
      id: 'Available',
      name: 'Available',
      color: 'green',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'In Use',
      name: 'In Use',
      color: 'blue',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Maintenance',
      name: 'Maintenance',
      color: 'yellow',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Retired',
      name: 'Retired',
      color: 'red',
      isInitial: false,
      isFinal: true,
    },
  ],
  transitions: [
    {
      id: 'tool-t1',
      name: 'Commission',
      fromStateId: 'Draft',
      toStateId: 'Available',
    },
    {
      id: 'tool-t2',
      name: 'Check Out',
      fromStateId: 'Available',
      toStateId: 'In Use',
    },
    {
      id: 'tool-t3',
      name: 'Return',
      fromStateId: 'In Use',
      toStateId: 'Available',
    },
    {
      id: 'tool-t4',
      name: 'Send to Maintenance',
      fromStateId: 'Available',
      toStateId: 'Maintenance',
    },
    {
      id: 'tool-t5',
      name: 'Send to Maintenance',
      fromStateId: 'In Use',
      toStateId: 'Maintenance',
    },
    {
      id: 'tool-t6',
      name: 'Return to Service',
      fromStateId: 'Maintenance',
      toStateId: 'Available',
    },
    {
      id: 'tool-t7',
      name: 'Retire',
      fromStateId: 'Available',
      toStateId: 'Retired',
    },
    {
      id: 'tool-t8',
      name: 'Retire from Maintenance',
      fromStateId: 'Maintenance',
      toStateId: 'Retired',
    },
  ],
  lifecycleType: 'Free' as const,
  applicableItemTypes: ['Tool'],
}

const PHYSICAL_PART_LIFECYCLE_DEFINITION = {
  states: [
    {
      id: 'Available',
      name: 'Available',
      color: 'green',
      isInitial: true,
      isFinal: false,
    },
    {
      id: 'Consumed',
      name: 'Consumed',
      color: 'blue',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'In Service',
      name: 'In Service',
      color: 'blue',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Scrapped',
      name: 'Scrapped',
      color: 'red',
      isInitial: false,
      isFinal: true,
    },
  ],
  transitions: [
    {
      id: 'pp-t1',
      name: 'Consume',
      fromStateId: 'Available',
      toStateId: 'Consumed',
    },
    {
      id: 'pp-t2',
      name: 'Return to Stock',
      fromStateId: 'Consumed',
      toStateId: 'Available',
    },
    {
      id: 'pp-t3',
      name: 'Put in Service',
      fromStateId: 'Available',
      toStateId: 'In Service',
    },
    {
      id: 'pp-t4',
      name: 'Remove from Service',
      fromStateId: 'In Service',
      toStateId: 'Available',
    },
    {
      id: 'pp-t5',
      name: 'Scrap',
      fromStateId: 'Available',
      toStateId: 'Scrapped',
    },
    {
      id: 'pp-t6',
      name: 'Scrap from Service',
      fromStateId: 'In Service',
      toStateId: 'Scrapped',
    },
  ],
  lifecycleType: 'Free' as const,
  applicableItemTypes: ['PhysicalPart'],
}

/**
 * Minimal Driving workflow so ChangeOrder items resolve an initial state on
 * databases the app seed has not touched. Finals declare `finalKind`; the
 * release-vs-cancel decision is made from that flag alone.
 */
const CHANGE_ORDER_WORKFLOW_DEFINITION = {
  states: [
    {
      id: 'Draft',
      name: 'Draft',
      color: 'gray',
      isInitial: true,
      isFinal: false,
    },
    {
      id: 'InReview',
      name: 'In Review',
      color: 'blue',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Approved',
      name: 'Approved',
      color: 'green',
      isInitial: false,
      isFinal: true,
      finalKind: 'release' as const,
    },
    {
      id: 'Cancelled',
      name: 'Cancelled',
      color: 'red',
      isInitial: false,
      isFinal: true,
      finalKind: 'cancel' as const,
    },
  ],
  transitions: [
    {
      id: 'co-t1',
      name: 'Submit for Review',
      fromStateId: 'Draft',
      toStateId: 'InReview',
    },
    {
      id: 'co-t2',
      name: 'Rework',
      fromStateId: 'InReview',
      toStateId: 'Draft',
    },
    {
      id: 'co-t3',
      name: 'Approve',
      fromStateId: 'InReview',
      toStateId: 'Approved',
    },
    {
      id: 'co-t4',
      name: 'Cancel',
      fromStateId: 'Draft',
      toStateId: 'Cancelled',
    },
    {
      id: 'co-t5',
      name: 'Cancel',
      fromStateId: 'InReview',
      toStateId: 'Cancelled',
    },
  ],
  definitionType: 'lifecycle',
  lifecycleType: 'Driving' as const,
  applicableItemTypes: ['ChangeOrder'],
}

export interface DefaultLifecycle {
  id: string
  name: string
  lifecycleType: 'Driven' | 'Free' | 'Driving'
  definition: Record<string, unknown>
  /**
   * Bump when the shipped default changes shape. Seeding upgrades an
   * existing row only when its stored version is lower, so a database
   * already holding this or a newer version — including one an admin edited
   * through WorkflowService, which bumps the version — is left alone.
   */
  version: number
}

/**
 * Every default item lifecycle, keyed by the well-known ids in
 * `lifecycle-ids.ts`. Software carries no entry: `ITEM_TYPE_LIFECYCLES`
 * links it to the Part definition (driven, ECO-controlled release).
 */
export const DEFAULT_ITEM_LIFECYCLES: ReadonlyArray<DefaultLifecycle> = [
  {
    id: LIFECYCLE_IDS.part,
    name: 'Part - Default Lifecycle',
    lifecycleType: 'Driven',
    definition: PART_LIFECYCLE_DEFINITION,
    version: 1,
  },
  {
    id: LIFECYCLE_IDS.document,
    name: 'Document - Default Lifecycle',
    lifecycleType: 'Driven',
    definition: {
      ...PART_LIFECYCLE_DEFINITION,
      applicableItemTypes: ['Document'],
    },
    version: 1,
  },
  {
    id: LIFECYCLE_IDS.requirement,
    name: 'Requirement - Default Lifecycle',
    lifecycleType: 'Driven',
    definition: REQUIREMENT_LIFECYCLE_DEFINITION,
    // v2: review progress (Proposed/Approved/Rejected) absorbed from the old
    // requirements.status column; release maps from Approved
    version: 2,
  },
  {
    id: LIFECYCLE_IDS.task,
    name: 'Task - Default Lifecycle',
    lifecycleType: 'Free',
    definition: TASK_LIFECYCLE_DEFINITION,
    version: 1,
  },
  {
    id: LIFECYCLE_IDS.testPlan,
    name: 'Test Plan - Default Lifecycle',
    lifecycleType: 'Free',
    definition: TEST_PLAN_LIFECYCLE_DEFINITION,
    version: 1,
  },
  {
    id: LIFECYCLE_IDS.testCase,
    name: 'Test Case - Default Lifecycle',
    lifecycleType: 'Free',
    definition: TEST_CASE_LIFECYCLE_DEFINITION,
    version: 1,
  },
  {
    id: LIFECYCLE_IDS.workInstruction,
    name: 'Work Instruction - Default Lifecycle',
    lifecycleType: 'Free',
    definition: WORK_INSTRUCTION_LIFECYCLE_DEFINITION,
    version: 1,
  },
  {
    id: LIFECYCLE_IDS.issue,
    name: 'Issue - Default Lifecycle',
    lifecycleType: 'Free',
    definition: ISSUE_LIFECYCLE_DEFINITION,
    version: 1,
  },
  {
    id: LIFECYCLE_IDS.tool,
    name: 'Tool - Default Lifecycle',
    lifecycleType: 'Free',
    definition: TOOL_LIFECYCLE_DEFINITION,
    // v2: toolStatus absorbed — Available/In Use replace Active
    version: 2,
  },
  {
    id: LIFECYCLE_IDS.physicalPart,
    name: 'Physical Part - Default Lifecycle',
    lifecycleType: 'Free',
    definition: PHYSICAL_PART_LIFECYCLE_DEFINITION,
    version: 1,
  },
  {
    id: LIFECYCLE_IDS.workOrder,
    name: 'Work Order - Default Lifecycle',
    lifecycleType: 'Free',
    definition: WORK_ORDER_LIFECYCLE_DEFINITION,
    // v2: Complete/Cancelled declare finalKind (traveler gate keys on it)
    version: 2,
  },
  {
    id: LIFECYCLE_IDS.changeOrder,
    name: 'Change Order - Default Workflow',
    lifecycleType: 'Driving',
    definition: CHANGE_ORDER_WORKFLOW_DEFINITION,
    version: 1,
  },
]

/**
 * The item-type → default-lifecycle links this module seeds. The app seed's
 * richer ChangeOrder config (with `workflowsByChangeType`) overwrites the
 * bare link on seeded databases, and CO test suites override with their own.
 */
export const DEFAULT_LIFECYCLE_LINKS: ReadonlyArray<{
  itemType: string
  lifecycleDefinitionId: string
}> = [
  { itemType: 'Part', lifecycleDefinitionId: LIFECYCLE_IDS.part },
  { itemType: 'Document', lifecycleDefinitionId: LIFECYCLE_IDS.document },
  { itemType: 'Requirement', lifecycleDefinitionId: LIFECYCLE_IDS.requirement },
  { itemType: 'Task', lifecycleDefinitionId: LIFECYCLE_IDS.task },
  { itemType: 'TestPlan', lifecycleDefinitionId: LIFECYCLE_IDS.testPlan },
  { itemType: 'TestCase', lifecycleDefinitionId: LIFECYCLE_IDS.testCase },
  {
    itemType: 'WorkInstruction',
    lifecycleDefinitionId: LIFECYCLE_IDS.workInstruction,
  },
  { itemType: 'Issue', lifecycleDefinitionId: LIFECYCLE_IDS.issue },
  { itemType: 'ChangeOrder', lifecycleDefinitionId: LIFECYCLE_IDS.changeOrder },
  // Software shares the Part lifecycle: driven, ECO-controlled release
  { itemType: 'Software', lifecycleDefinitionId: LIFECYCLE_IDS.part },
  { itemType: 'Tool', lifecycleDefinitionId: LIFECYCLE_IDS.tool },
  {
    itemType: 'PhysicalPart',
    lifecycleDefinitionId: LIFECYCLE_IDS.physicalPart,
  },
  { itemType: 'WorkOrder', lifecycleDefinitionId: LIFECYCLE_IDS.workOrder },
]

/**
 * Seed every default item lifecycle and its item-type link, first-writer-wins.
 *
 * Idempotent and non-destructive: `onConflictDoNothing` throughout, so a
 * database already holding richer rows (the app seed's descriptions and
 * layout, a suite's deliberate override, an admin's edits) keeps them. The
 * test global-setup calls this once per run; `scripts/seed-minimal.ts` writes
 * its own richer versions of the long-established types and calls this for
 * the rest.
 */
export async function seedDefaultLifecycles(db: DbInstance): Promise<void> {
  // Config rows reference the system user via modifiedBy
  await db
    .insert(users)
    .values({
      id: SYSTEM_USER_ID,
      email: 'system@test.local',
      name: 'System User',
      passwordHash: 'not-used',
      active: true,
    })
    .onConflictDoNothing()

  for (const lifecycle of DEFAULT_ITEM_LIFECYCLES) {
    const version = lifecycle.version
    await db
      .insert(workflowDefinitions)
      .values({
        id: lifecycle.id,
        name: lifecycle.name,
        version,
        workflowType: 'strict',
        definition: lifecycle.definition,
        isActive: true,
        lifecycleType: lifecycle.lifecycleType,
        drivers: [],
      })
      .onConflictDoUpdate({
        target: workflowDefinitions.id,
        set: {
          name: lifecycle.name,
          version,
          definition: lifecycle.definition,
          lifecycleType: lifecycle.lifecycleType,
        },
        // Upgrade-only: rows at this version or newer — including admin
        // edits, which bump the version through WorkflowService — stay put
        setWhere: sql`${workflowDefinitions.version} < ${version}`,
      })
  }

  for (const link of DEFAULT_LIFECYCLE_LINKS) {
    await db
      .insert(itemTypeConfigs)
      .values({
        itemType: link.itemType,
        config: { lifecycleDefinitionId: link.lifecycleDefinitionId },
        modifiedBy: SYSTEM_USER_ID,
      })
      .onConflictDoNothing()
  }
}
