// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

/**
 * Collaborative Design Engine
 *
 * AI-powered human-in-the-loop workflow:
 * description -> requirements -> BOM structure -> materialization
 */

export { CollaborativeDesignEngine, designEngine } from './engine'
export { DesignSessionService } from './session-service'
export { MaterializationService } from './materialize'

// Re-export all types
export type {
  DesignSessionStatus,
  DesignSessionStage,
  StageEvent,
  RequirementDraft,
  BomNodeDraft,
  ProposedPart,
  BomDraft,
  DesignArtifacts,
  MaterializationPreview,
  MaterializationResult,
  DesignSessionContext,
  RequirementEdit,
  DesignEngine,
  ValidationIssue,
  LlmHistoryEntry,
  ManufacturingScope,
  SessionTool,
  DesignSessionToolset,
  ManufacturingConstraints,
} from './types'
