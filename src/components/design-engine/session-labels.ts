/**
 * Shared display helpers for design engine sessions.
 *
 * Keeps stage/status labels in one place so the sessions list
 * (SessionsTable) and the per-program TeamSessionsList stay in sync.
 */

import type { BadgeProps } from '@/components/ui'

/** Human-readable label for each design session stage. */
export const STAGE_LABELS: Record<string, string> = {
  idle: 'Not started',
  toolset_establishment: 'Establishing toolset',
  toolset_review: 'Reviewing toolset',
  requirements_drafting: 'Drafting requirements',
  requirements_review: 'Reviewing requirements',
  bom_drafting: 'Drafting BOM',
  bom_review: 'Reviewing BOM',
  materialization: 'Materializing',
  cad_generation: 'Generating CAD',
  cad_review: 'Reviewing CAD',
  assembly_composition: 'Composing assemblies',
  assembly_review: 'Reviewing assemblies',
  complete: 'Complete',
}

/** Resolve a stage value to its label, falling back to the raw value. */
export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage
}

/** Human-readable label for each design session status. */
export const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  completed: 'Completed',
  failed: 'Failed',
}

/** Resolve a status value to its label, falling back to the raw value. */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

/** Badge variant to use for a given session status. */
export function statusBadgeVariant(status: string): BadgeProps['variant'] {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'destructive'
    default:
      return 'default'
  }
}
