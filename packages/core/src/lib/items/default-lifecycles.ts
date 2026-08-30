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
 * This is the single source of the shipped defaults: the app seed writes no
 * lifecycle of its own. The two change-order workflows are here too — a
 * ChangeOrder item's state mirrors its workflow instance, so state resolution
 * needs a Driving definition to exist everywhere — and CO test suites still
 * override with their own. Descriptions and the editor's node positions ride
 * along, so a fresh database opens each default laid out and explained.
 */

import { sql } from 'drizzle-orm'
// Laid out at module load, synchronously. That is the constraint on ever
// replacing dagre here: an async layout library (elkjs) cannot be called
// from a module-level constant. See the note in
// components/versioning/graph-layout.ts.
import dagre from 'dagre'
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

interface LayoutEdge {
  fromStateId: string
  toStateId: string
}

interface LayoutableDefinition {
  states: ReadonlyArray<{ id: string }>
  transitions?: ReadonlyArray<LayoutEdge>
  changeActionMappings?: Record<
    string,
    { fromState?: string; toState?: string; oldVersionState?: string }
  >
}

/**
 * The definition with dagre-positioned states, so the lifecycle editor opens
 * a shipped default laid out left-to-right instead of stacked at the origin.
 * Layout edges are the manual transitions plus the moves the change-action
 * mappings describe — a Driven lifecycle has no transitions; its shape *is*
 * its mappings. Same geometry the editor's own auto-layout uses.
 */
function withLayout<T extends LayoutableDefinition>(definition: T): T {
  const edges: Array<LayoutEdge> = [...(definition.transitions ?? [])]
  for (const move of Object.values(definition.changeActionMappings ?? {})) {
    for (const to of [move.toState, move.oldVersionState]) {
      if (move.fromState && to && to !== move.fromState) {
        edges.push({ fromStateId: move.fromState, toStateId: to })
      }
    }
  }
  const width = 180
  const height = 80
  const graph = new dagre.graphlib.Graph()
  graph.setDefaultEdgeLabel(() => ({}))
  graph.setGraph({
    rankdir: 'LR',
    ranksep: 100,
    nodesep: 50,
    marginx: 20,
    marginy: 20,
  })
  for (const state of definition.states) {
    graph.setNode(state.id, { width, height })
  }
  for (const edge of edges) graph.setEdge(edge.fromStateId, edge.toStateId)
  dagre.layout(graph)
  return {
    ...definition,
    states: definition.states.map((state) => {
      const node = graph.node(state.id)
      return {
        ...state,
        position: { x: node.x - width / 2, y: node.y - height / 2 },
      }
    }),
  }
}

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
      description: 'Item is being created or edited',
      color: 'gray',
      isInitial: true,
      isFinal: false,
    },
    {
      id: 'Released',
      name: 'Released',
      description: 'Item is released for use',
      color: 'green',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Superseded',
      name: 'Superseded',
      description: 'Replaced by a newer revision',
      color: 'slate',
      isInitial: false,
      isFinal: true,
    },
    {
      id: 'Obsolete',
      name: 'Obsolete',
      description: 'Item is no longer used',
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
  description:
    'Standard lifecycle for Parts and Documents. All state changes go through ECOs.',
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
  description:
    'Requirement lifecycle. Draft → Proposed → Approved by review; release, revision and obsolescence go through ECOs.',
  applicableItemTypes: ['Requirement'],
}

export const WORK_ORDER_LIFECYCLE_DEFINITION = {
  states: [
    {
      id: 'Not Started',
      name: 'Not Started',
      description: 'Work order is planned but execution has not begun',
      color: 'gray',
      isInitial: true,
      isFinal: false,
    },
    {
      id: 'In Progress',
      name: 'In Progress',
      description: 'Execution underway on the shop floor',
      color: 'blue',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Complete',
      name: 'Complete',
      description: 'All quantities completed',
      color: 'green',
      isInitial: false,
      isFinal: true,
      finalKind: 'complete' as const,
    },
    {
      id: 'Cancelled',
      name: 'Cancelled',
      description: 'Work order cancelled before completion',
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
      description: 'Begin execution',
      fromStateId: 'Not Started',
      toStateId: 'In Progress',
    },
    {
      id: 'wo-t2',
      name: 'Cancel',
      description: 'Cancel before starting',
      fromStateId: 'Not Started',
      toStateId: 'Cancelled',
    },
    {
      id: 'wo-t3',
      name: 'Complete',
      description: 'All quantities completed',
      fromStateId: 'In Progress',
      toStateId: 'Complete',
    },
    {
      id: 'wo-t4',
      name: 'Cancel In Progress',
      description: 'Cancel a running work order',
      fromStateId: 'In Progress',
      toStateId: 'Cancelled',
    },
  ],
  lifecycleType: 'Free' as const,
  description:
    'Work order execution lifecycle. Not Started → In Progress → Complete, cancellable until complete.',
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
      description: 'Issue has been reported and is awaiting triage',
      color: 'blue',
      isInitial: true,
      isFinal: false,
    },
    {
      id: 'InProgress',
      name: 'In Progress',
      description: 'Issue is being actively investigated or worked on',
      color: 'yellow',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Pending',
      name: 'Pending',
      description: 'Issue is waiting for external input or action',
      color: 'orange',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Resolved',
      name: 'Resolved',
      description: 'Issue has been resolved but not yet verified',
      color: 'green',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Verified',
      name: 'Verified',
      description: 'Resolution has been verified and confirmed',
      color: 'emerald',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Closed',
      name: 'Closed',
      description: 'Issue is closed and complete',
      color: 'slate',
      isInitial: false,
      isFinal: true,
    },
    {
      id: 'Cancelled',
      name: 'Cancelled',
      description: 'Issue was cancelled (duplicate, invalid, etc.)',
      color: 'red',
      isInitial: false,
      isFinal: true,
    },
  ],
  transitions: [
    {
      id: 'issue-t1',
      name: 'Start Work',
      description: 'Begin investigating or working on the issue',
      fromStateId: 'Open',
      toStateId: 'InProgress',
    },
    {
      id: 'issue-t2',
      name: 'Put on Hold',
      description: 'Waiting for external input or action',
      fromStateId: 'InProgress',
      toStateId: 'Pending',
    },
    {
      id: 'issue-t3',
      name: 'Resume',
      description: 'Resume work on the issue',
      fromStateId: 'Pending',
      toStateId: 'InProgress',
    },
    {
      id: 'issue-t4',
      name: 'Resolve',
      description: 'Mark the issue as resolved',
      fromStateId: 'InProgress',
      toStateId: 'Resolved',
    },
    {
      id: 'issue-t5',
      name: 'Resolve from Pending',
      description: 'Mark the issue as resolved',
      fromStateId: 'Pending',
      toStateId: 'Resolved',
    },
    {
      id: 'issue-t6',
      name: 'Verify',
      description: 'Verify the resolution',
      fromStateId: 'Resolved',
      toStateId: 'Verified',
    },
    {
      id: 'issue-t7',
      name: 'Reopen',
      description: 'Reopen the issue for further work',
      fromStateId: 'Resolved',
      toStateId: 'InProgress',
    },
    {
      id: 'issue-t8',
      name: 'Close',
      description: 'Close the issue',
      fromStateId: 'Verified',
      toStateId: 'Closed',
    },
    {
      id: 'issue-t9',
      name: 'Cancel from Open',
      description: 'Cancel the issue',
      fromStateId: 'Open',
      toStateId: 'Cancelled',
    },
    {
      id: 'issue-t10',
      name: 'Cancel from InProgress',
      description: 'Cancel the issue',
      fromStateId: 'InProgress',
      toStateId: 'Cancelled',
    },
    {
      id: 'issue-t11',
      name: 'Cancel from Pending',
      description: 'Cancel the issue',
      fromStateId: 'Pending',
      toStateId: 'Cancelled',
    },
  ],
  lifecycleType: 'Free' as const,
  description:
    'Issue tracking lifecycle. Users can manually transition states without ECO approval.',
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
      description: 'Tool is being configured and has not been validated',
      color: 'gray',
      isInitial: true,
      isFinal: false,
    },
    {
      id: 'Available',
      name: 'Available',
      description: 'Tool is in stock and available for use',
      color: 'green',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'In Use',
      name: 'In Use',
      description: 'Tool is checked out to a work order or operator',
      color: 'blue',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Maintenance',
      name: 'Maintenance',
      description: 'Tool is undergoing maintenance or calibration',
      color: 'yellow',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Retired',
      name: 'Retired',
      description: 'Tool is no longer in service',
      color: 'red',
      isInitial: false,
      isFinal: true,
    },
  ],
  transitions: [
    {
      id: 'tool-t1',
      name: 'Commission',
      description: 'Mark tool as available for use',
      fromStateId: 'Draft',
      toStateId: 'Available',
    },
    {
      id: 'tool-t2',
      name: 'Check Out',
      description: 'Check the tool out for use',
      fromStateId: 'Available',
      toStateId: 'In Use',
    },
    {
      id: 'tool-t3',
      name: 'Return',
      description: 'Return the tool to available stock',
      fromStateId: 'In Use',
      toStateId: 'Available',
    },
    {
      id: 'tool-t4',
      name: 'Send to Maintenance',
      description: 'Take tool offline for maintenance or calibration',
      fromStateId: 'Available',
      toStateId: 'Maintenance',
    },
    {
      id: 'tool-t5',
      name: 'Send to Maintenance',
      description: 'Take a tool in use offline for maintenance or calibration',
      fromStateId: 'In Use',
      toStateId: 'Maintenance',
    },
    {
      id: 'tool-t6',
      name: 'Return to Service',
      description: 'Return tool to available stock after maintenance',
      fromStateId: 'Maintenance',
      toStateId: 'Available',
    },
    {
      id: 'tool-t7',
      name: 'Retire',
      description: 'Permanently retire tool from service',
      fromStateId: 'Available',
      toStateId: 'Retired',
    },
    {
      id: 'tool-t8',
      name: 'Retire from Maintenance',
      description: 'Retire tool that is currently in maintenance',
      fromStateId: 'Maintenance',
      toStateId: 'Retired',
    },
  ],
  lifecycleType: 'Free' as const,
  description:
    'Tool lifecycle for manufacturing equipment. Draft → Available ↔ In Use, Maintenance ↔ Available, → Retired.',
  applicableItemTypes: ['Tool'],
}

const PHYSICAL_PART_LIFECYCLE_DEFINITION = {
  states: [
    {
      id: 'Available',
      name: 'Available',
      description: 'Instance exists and can be consumed or put in service',
      color: 'green',
      isInitial: true,
      isFinal: false,
    },
    {
      id: 'Consumed',
      name: 'Consumed',
      description: 'Consumed by a work order (reversible while WO is open)',
      color: 'blue',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'In Service',
      name: 'In Service',
      description: 'Fielded/in use as an end item',
      color: 'blue',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Scrapped',
      name: 'Scrapped',
      description: 'Destroyed or disposed — identity retained for history',
      color: 'red',
      isInitial: false,
      isFinal: true,
    },
  ],
  transitions: [
    {
      id: 'pp-t1',
      name: 'Consume',
      description: 'Consumed as material by a work order',
      fromStateId: 'Available',
      toStateId: 'Consumed',
    },
    {
      id: 'pp-t2',
      name: 'Return to Stock',
      description: 'Undo consumption (work order line removed)',
      fromStateId: 'Consumed',
      toStateId: 'Available',
    },
    {
      id: 'pp-t3',
      name: 'Put in Service',
      description: 'Delivered/fielded as an end item',
      fromStateId: 'Available',
      toStateId: 'In Service',
    },
    {
      id: 'pp-t4',
      name: 'Return from Service',
      description: 'Returned from the field',
      fromStateId: 'In Service',
      toStateId: 'Available',
    },
    {
      id: 'pp-t5',
      name: 'Scrap',
      description: 'Destroyed or disposed',
      fromStateId: 'Available',
      toStateId: 'Scrapped',
    },
    {
      id: 'pp-t6',
      name: 'Scrap from Service',
      description: 'Retired from the field and disposed',
      fromStateId: 'In Service',
      toStateId: 'Scrapped',
    },
  ],
  lifecycleType: 'Free' as const,
  description:
    'Physical part lifecycle for serialized units and lots. Available ↔ Consumed / In Service → Scrapped.',
  applicableItemTypes: ['PhysicalPart'],
}

/**
 * The shipped ECO approval workflow. Finals declare `finalKind`; the
 * release-vs-cancel decision is made from that flag alone. Returning to the
 * initial state reopens the change order's scope, and a cancel path exists
 * from every pre-final state — without one a submitted ECO could only ever be
 * approved or sit in review forever.
 */
const CHANGE_ORDER_WORKFLOW_DEFINITION = {
  states: [
    {
      id: 'Draft',
      name: 'Draft',
      color: 'gray',
      description: 'ECO is being prepared',
      isInitial: true,
      isFinal: false,
    },
    {
      id: 'InReview',
      name: 'In Review',
      color: 'yellow',
      description: 'ECO is under review',
      isInitial: false,
      isFinal: false,
    },
    {
      id: 'Approved',
      name: 'Approved',
      color: 'green',
      description: 'ECO has been approved and items are released',
      isInitial: false,
      isFinal: true,
      // Completing here merges branches and assigns revisions
      finalKind: 'release' as const,
    },
    {
      id: 'Cancelled',
      name: 'Cancelled',
      color: 'red',
      description: 'ECO was abandoned; branches are archived unmerged',
      isInitial: false,
      isFinal: true,
      // Completing here archives branches without merging
      finalKind: 'cancel' as const,
    },
  ],
  transitions: [
    {
      id: 't1',
      name: 'Submit for Review',
      fromStateId: 'Draft',
      toStateId: 'InReview',
      description: 'Submit ECO for review',
    },
    {
      id: 't2',
      name: 'Approve',
      fromStateId: 'InReview',
      toStateId: 'Approved',
      // Approved is final with finalKind 'release': completing the workflow
      // runs the merge, which applies each affected item's
      // changeActionMappings — no per-transition actions needed
      description: 'Approve the ECO and release affected items',
    },
    {
      id: 't3',
      name: 'Return to Draft',
      fromStateId: 'InReview',
      toStateId: 'Draft',
      description: 'Send the ECO back for rework',
    },
    {
      id: 't4',
      name: 'Cancel',
      fromStateId: 'InReview',
      toStateId: 'Cancelled',
      description: 'Abandon the ECO; branches are archived unmerged',
    },
    {
      id: 't5',
      name: 'Cancel',
      fromStateId: 'Draft',
      toStateId: 'Cancelled',
      description: 'Abandon the ECO before review',
    },
  ],
  lifecycleType: 'Driving' as const,
  description: 'Simple approval workflow for Engineering Change Orders',
  applicableItemTypes: ['ChangeOrder'],
}

/**
 * Template for ad-hoc change orders (`workflowType: 'flexible'`): each
 * instance adds its own review states and transitions between Start and
 * Complete. Completing releases exactly as the default ECO workflow does.
 */
const FLEXIBLE_CHANGE_ORDER_WORKFLOW_DEFINITION = {
  states: [
    {
      id: 'start',
      name: 'Start',
      color: 'gray',
      description: 'Initial state - add review steps as needed',
      isInitial: true,
      isFinal: false,
    },
    {
      id: 'complete',
      name: 'Complete',
      color: 'green',
      description: 'Workflow completed',
      isInitial: false,
      isFinal: true,
      // Completing here merges branches and assigns revisions
      finalKind: 'release' as const,
    },
  ],
  transitions: [
    {
      id: 'complete-transition',
      name: 'Complete',
      fromStateId: 'start',
      toStateId: 'complete',
      // 'complete' is final with finalKind 'release': the merge applies each
      // affected item's changeActionMappings — no actions needed
      description: 'Mark as complete',
    },
  ],
  lifecycleType: 'Driving' as const,
  description:
    'Flexible workflow template for Change Orders. Each instance can customize its own review steps and transitions.',
  applicableItemTypes: ['ChangeOrder'],
}

export interface DefaultLifecycle {
  id: string
  name: string
  lifecycleType: 'Driven' | 'Free' | 'Driving'
  /** `strict` unless the definition is a per-instance template. */
  workflowType?: 'strict' | 'flexible'
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
 *
 * Versions: v2 everywhere is the layout-and-descriptions pass that made this
 * module the only source (the seed's copies carried them; now every
 * database gets them). Tool, Work Order and Requirement had already moved
 * for their own reasons and are one higher.
 */
export const DEFAULT_ITEM_LIFECYCLES: ReadonlyArray<DefaultLifecycle> = [
  {
    id: LIFECYCLE_IDS.part,
    name: 'Part - Default Lifecycle',
    lifecycleType: 'Driven',
    definition: withLayout(PART_LIFECYCLE_DEFINITION),
    version: 2,
  },
  {
    id: LIFECYCLE_IDS.document,
    name: 'Document - Default Lifecycle',
    lifecycleType: 'Driven',
    definition: withLayout({
      ...PART_LIFECYCLE_DEFINITION,
      applicableItemTypes: ['Document'],
    }),
    version: 2,
  },
  {
    id: LIFECYCLE_IDS.requirement,
    name: 'Requirement - Default Lifecycle',
    lifecycleType: 'Driven',
    definition: withLayout(REQUIREMENT_LIFECYCLE_DEFINITION),
    // v2: review progress (Proposed/Approved/Rejected) absorbed from the old
    // requirements.status column; release maps from Approved. v3: layout.
    version: 3,
  },
  {
    id: LIFECYCLE_IDS.task,
    name: 'Task - Default Lifecycle',
    lifecycleType: 'Free',
    definition: withLayout(TASK_LIFECYCLE_DEFINITION),
    version: 2,
  },
  {
    id: LIFECYCLE_IDS.testPlan,
    name: 'Test Plan - Default Lifecycle',
    lifecycleType: 'Free',
    definition: withLayout(TEST_PLAN_LIFECYCLE_DEFINITION),
    version: 2,
  },
  {
    id: LIFECYCLE_IDS.testCase,
    name: 'Test Case - Default Lifecycle',
    lifecycleType: 'Free',
    definition: withLayout(TEST_CASE_LIFECYCLE_DEFINITION),
    version: 2,
  },
  {
    id: LIFECYCLE_IDS.workInstruction,
    name: 'Work Instruction - Default Lifecycle',
    lifecycleType: 'Free',
    definition: withLayout(WORK_INSTRUCTION_LIFECYCLE_DEFINITION),
    version: 2,
  },
  {
    id: LIFECYCLE_IDS.issue,
    name: 'Issue - Default Lifecycle',
    lifecycleType: 'Free',
    definition: withLayout(ISSUE_LIFECYCLE_DEFINITION),
    version: 2,
  },
  {
    id: LIFECYCLE_IDS.tool,
    name: 'Tool - Default Lifecycle',
    lifecycleType: 'Free',
    definition: withLayout(TOOL_LIFECYCLE_DEFINITION),
    // v2: toolStatus absorbed — Available/In Use replace Active. v3: layout.
    version: 3,
  },
  {
    id: LIFECYCLE_IDS.physicalPart,
    name: 'Physical Part - Default Lifecycle',
    lifecycleType: 'Free',
    definition: withLayout(PHYSICAL_PART_LIFECYCLE_DEFINITION),
    version: 2,
  },
  {
    id: LIFECYCLE_IDS.workOrder,
    name: 'Work Order - Default Lifecycle',
    lifecycleType: 'Free',
    definition: withLayout(WORK_ORDER_LIFECYCLE_DEFINITION),
    // v2: Complete/Cancelled declare finalKind (traveler gate keys on it).
    // v3: layout.
    version: 3,
  },
  {
    id: LIFECYCLE_IDS.changeOrder,
    name: 'ECO - Default Workflow',
    lifecycleType: 'Driving',
    definition: withLayout(CHANGE_ORDER_WORKFLOW_DEFINITION),
    // v2: the shipped workflow, which used to live only in the app seed,
    // replaces the minimal stand-in this module carried for test databases
    version: 2,
  },
  {
    id: LIFECYCLE_IDS.flexibleChangeOrder,
    name: 'Dynamic Change Order',
    lifecycleType: 'Driving',
    workflowType: 'flexible',
    definition: withLayout(FLEXIBLE_CHANGE_ORDER_WORKFLOW_DEFINITION),
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
 * test global-setup calls this once per run and `scripts/seed-minimal.ts`
 * seeds real databases with it — the seed writes no lifecycle of its own,
 * so a re-seed can only ever upgrade a row, never hand it an older shape.
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
        workflowType: lifecycle.workflowType ?? 'strict',
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
          workflowType: lifecycle.workflowType ?? 'strict',
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
