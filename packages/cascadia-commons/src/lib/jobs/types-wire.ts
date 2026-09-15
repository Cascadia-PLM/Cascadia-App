// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Job status and priority as the jobs API reports them. The `jobs` schema
 * re-exports these; they live here so the admin UI can name them without
 * importing the schema.
 */

// Job status and priority types
export type JobStatus =
  'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type JobPriority = 'low' | 'normal' | 'high' | 'critical'
