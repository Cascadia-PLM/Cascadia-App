/**
 * Well-known lifecycle definition IDs.
 * These IDs are used in both code registration and seed scripts
 * to ensure consistent linkage between item types and their lifecycles.
 *
 * Each item type should have exactly one lifecycle assigned by default.
 */
export const LIFECYCLE_IDS = {
  // Driven lifecycles (controlled by ECOs)
  part: '00000000-0000-4000-8000-000000000100',
  document: '00000000-0000-4000-8000-000000000101',
  requirement: '00000000-0000-4000-8000-000000000105',

  // Driving lifecycles (ECO workflows that control Driven lifecycles)
  changeOrder: '00000000-0000-4000-8000-000000000102',
  flexibleChangeOrder: '00000000-0000-4000-8000-000000000103',

  // Free lifecycles (self-controlled, no ECO required)
  task: '00000000-0000-4000-8000-000000000106',
  testPlan: '00000000-0000-4000-8000-000000000107',
  testCase: '00000000-0000-4000-8000-000000000108',
  workInstruction: '00000000-0000-4000-8000-000000000109',
  issue: '00000000-0000-4000-8000-000000000110',
  tool: '00000000-0000-4000-8000-000000000111',
} as const

/**
 * Mapping of item types to their default lifecycle IDs.
 * This is the source of truth for which lifecycle each item type uses.
 */
export const ITEM_TYPE_LIFECYCLES: Record<string, string> = {
  Part: LIFECYCLE_IDS.part,
  Document: LIFECYCLE_IDS.document,
  Requirement: LIFECYCLE_IDS.requirement,
  ChangeOrder: LIFECYCLE_IDS.changeOrder,
  Task: LIFECYCLE_IDS.task,
  TestPlan: LIFECYCLE_IDS.testPlan,
  TestCase: LIFECYCLE_IDS.testCase,
  WorkInstruction: LIFECYCLE_IDS.workInstruction,
  Issue: LIFECYCLE_IDS.issue,
  Tool: LIFECYCLE_IDS.tool,
}
