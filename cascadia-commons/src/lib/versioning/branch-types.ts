// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The persisted `branches.branch_type` and `tags.tag_type` values, named
 * once.
 *
 * A change order's branch is spelled `'eco'` in the database and in every v1
 * response that carries a branch type, and the tag its release cuts is
 * `'eco-release'`. Both values stay (remediation plan, Decision 2 — they are
 * in the frozen v1 contract) and are renamed at v2; until then the code
 * reads these constants, so the spelling lives here alone. Client-safe: no
 * database imports.
 */
export const BRANCH_TYPES = {
  main: 'main',
  changeOrder: 'eco',
  workspace: 'workspace',
  release: 'release',
} as const

export type BranchType = (typeof BRANCH_TYPES)[keyof typeof BRANCH_TYPES]

export const TAG_TYPES = {
  baseline: 'baseline',
  release: 'release',
  milestone: 'milestone',
  changeOrderRelease: 'eco-release',
} as const

export type TagType = (typeof TAG_TYPES)[keyof typeof TAG_TYPES]
