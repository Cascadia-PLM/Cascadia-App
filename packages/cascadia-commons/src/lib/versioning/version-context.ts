// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Version context types for viewing items
 */
export type VersionContext =
  | { type: 'released'; designId: string } // main branch HEAD
  | { type: 'branch'; branchId: string } // any branch HEAD
  | { type: 'commit'; commitId: string } // specific commit
  | { type: 'tag'; tagId: string } // tag's commit
