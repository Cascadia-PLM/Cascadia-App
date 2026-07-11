/**
 * Collaborative Design Engine - Core Type Definitions
 *
 * Defines the data model for the human-in-the-loop design workflow:
 * description -> requirements -> BOM structure -> materialization
 */

// ============================================================================
// Session Types
// ============================================================================

// ============================================================================
// Zod Schemas for API Validation
// ============================================================================

import { z } from 'zod'

export type DesignSessionStatus = 'active' | 'paused' | 'completed' | 'failed'

export type DesignSessionStage =
  | 'idle'
  | 'toolset_establishment'
  | 'toolset_review'
  | 'requirements_drafting'
  | 'requirements_review'
  | 'bom_drafting'
  | 'bom_review'
  | 'materialization'
  | 'cad_generation'
  | 'cad_review'
  | 'assembly_composition'
  | 'assembly_review'
  | 'complete'
  | 'error'

/**
 * Canonical forward order of session stages. 'error' sits at the end so a
 * failed session can still be reopened to any real stage.
 */
export const DESIGN_SESSION_STAGE_ORDER: Array<DesignSessionStage> = [
  'idle',
  'toolset_establishment',
  'toolset_review',
  'requirements_drafting',
  'requirements_review',
  'bom_drafting',
  'bom_review',
  'materialization',
  'cad_generation',
  'cad_review',
  'assembly_composition',
  'assembly_review',
  'complete',
  'error',
]

export function stageIndex(stage: DesignSessionStage): number {
  return DESIGN_SESSION_STAGE_ORDER.indexOf(stage)
}

/** Review gates that can be reopened after being confirmed (pre-materialization only). */
export type ReopenableStage =
  | 'toolset_review'
  | 'requirements_review'
  | 'bom_review'

export const REOPENABLE_STAGES: Array<ReopenableStage> = [
  'toolset_review',
  'requirements_review',
  'bom_review',
]

// ============================================================================
// Clarification & User Message Types
// ============================================================================

export interface ClarificationEntry {
  questionId: string
  question: string
  options?: Array<string>
  multiSelect?: boolean
  answer: string
  answeredAt: string // ISO timestamp
  stage: DesignSessionStage
}

export interface UserMessage {
  id: string
  text: string
  createdAt: string // ISO timestamp
  stage: DesignSessionStage
}

// ============================================================================
// Manufacturing Toolset Types
// ============================================================================

export type ManufacturingScope =
  | 'in_house_only'
  | 'in_house_preferred'
  | 'unconstrained'

export interface SessionTool {
  id: string
  toolItemId?: string
  toolItemNumber?: string
  adhocTool?: {
    name: string
    toolType: string
    toolSubtype: string
    capabilities: Record<string, unknown>
  }
  name: string
  toolType: string
  toolSubtype: string
  capabilities: Record<string, unknown>
  source: 'prompt_detected' | 'user_selected' | 'user_freeform'
}

export interface DesignSessionToolset {
  scope: ManufacturingScope
  tools: Array<SessionTool>
}

// ============================================================================
// Manufacturing Constraints (BOM node-level)
// ============================================================================

export interface ManufacturingConstraints {
  process: string // matches toolSubtype: 'fdm_printer', 'laser_cutter', etc.
  toolReference: string // SessionTool.id
  fdm?: {
    buildVolume: [number, number, number]
    nozzleDiameter: number
    layerHeight: number
    material: string
    needsSupports: boolean
    segmentation?: {
      needed: boolean
      maxSegmentSize: [number, number, number]
      jointType:
        | 'dovetail'
        | 'pin_slot'
        | 'bolt_through'
        | 'tongue_groove'
        | 'glue_face'
      overlapLength?: number
      alignmentFeatures?: boolean
    }
  }
  laserCut?: {
    bedSize: [number, number]
    material: string
    thickness: number
    requiresNesting: boolean
  }
  cnc?: {
    workVolume: [number, number, number]
    material: string
    minToolDiameter: number
    axes: number
  }
  manualCut?: {
    toolReference: string
    maxCutWidth?: number
    maxCutDepth?: number
    cutTypes: Array<string>
  }
  outsourced?: boolean
  outsourceNotes?: string
}

// ============================================================================
// Stage Events (discriminated union for streaming)
// ============================================================================

export type StageEvent =
  | { type: 'stage_change'; stage: DesignSessionStage }
  | { type: 'artifact_update'; artifacts: Partial<DesignArtifacts> }
  | { type: 'llm_text'; text: string }
  | { type: 'tool_call'; toolName: string; args: Record<string, unknown> }
  | {
      type: 'tool_result'
      toolName: string
      result: Record<string, unknown>
    }
  | {
      type: 'clarification_needed'
      questionId: string
      question: string
      options?: Array<string>
      multiSelect?: boolean
    }
  | { type: 'stage_complete'; stage: DesignSessionStage; summary: string }
  | { type: 'error'; message: string }
  | { type: 'paused'; reason: string }
  | { type: 'user_message'; id: string; text: string }

// ============================================================================
// Per-item Review State
// ============================================================================

/**
 * Review state of an AI-proposed artifact item.
 * - 'proposed': awaiting review (AI output not yet looked at)
 * - 'accepted': explicitly approved by the user
 * - 'edited': the user changed it (implicit approval of their own edit)
 * - 'rejected': explicitly declined; kept (requirements) or tombstoned (BOM)
 */
export type ReviewStatus = 'proposed' | 'accepted' | 'rejected' | 'edited'

/**
 * Effective review status for items that predate review tracking:
 * user-authored items are implicitly accepted, AI items start proposed.
 */
export function effectiveReviewStatus(item: {
  reviewStatus?: ReviewStatus
  source?: 'ai' | 'user'
}): ReviewStatus {
  if (item.reviewStatus) return item.reviewStatus
  return item.source === 'user' ? 'accepted' : 'proposed'
}

/** Requirements that should flow downstream (BOM prompt, coverage, materialization). */
export function activeRequirements(
  requirements: Array<RequirementDraft>,
): Array<RequirementDraft> {
  return requirements.filter(
    (r) => effectiveReviewStatus(r) !== 'rejected',
  )
}

/** Tombstone recording a BOM node the user rejected (the node itself is removed from the tree). */
export interface BomRejectionEntry {
  tempId: string
  name: string
  partType?: string
  parentName?: string
  reason?: string
  rejectedAt: string // ISO timestamp
  stage: DesignSessionStage
}

// ============================================================================
// Requirement Draft
// ============================================================================

export interface RequirementDraft {
  tempId: string
  name: string
  description: string
  requirementType:
    | 'Functional'
    | 'Performance'
    | 'Interface'
    | 'Constraint'
    | 'Other'
  priority: 'low' | 'medium' | 'high' | 'critical'
  verificationMethod: 'Analysis' | 'Inspection' | 'Test' | 'Demonstration'
  rationale: string
  confidence: number // 0-1
  source: 'ai' | 'user'
  reviewStatus?: ReviewStatus
  reviewNote?: string
}

// ============================================================================
// Interface Intent Types (CAD generation metadata)
// ============================================================================

export interface InterfaceIntent {
  id: string
  description: string // "4x M4 mounting holes on bottom face"
  mateType:
    | 'coaxial'
    | 'coincident'
    | 'concentric'
    | 'insert'
    | 'parallel_offset'
    | 'tangent'
    | 'fixed_offset'
  geometry: {
    shape: 'circular' | 'rectangular' | 'linear' | 'planar' | 'cylindrical'
    nominalDimensions: Record<string, number> // { diameter: 6, depth: 12 }
    units: 'mm' | 'in'
    count?: number
    patternType?: 'linear' | 'circular' | 'rectangular_grid'
    patternSpacing?: number
  }
  locationHint: string // "bottom face", "left side"
}

export interface InterfaceMapping {
  id: string
  partATempId: string
  interfaceAId: string
  partBTempId: string
  interfaceBId: string
  mateType: InterfaceIntent['mateType']
  positioningIntent: string // LLM's natural-language description
}

export type ShapeTemplate =
  | 'bushing'
  | 'spacer'
  | 'tube'
  | 'plate'
  | 'plate_with_holes'
  | 'block'
  | 'bracket_l'
  | 'bracket_u'
  | 'extrusion_rectangular'
  | 'extrusion_circular'

export interface ParametricPartSpec {
  shapeTemplate: ShapeTemplate
  parameters: Record<string, number>
  units: 'mm' | 'in'
}

// ============================================================================
// Mechanism Template Types
// ============================================================================

export type MechanismType = 'rack_and_pinion'

export interface MechanismPartMapping {
  role: string
  tempId: string
}

export interface MechanismTemplate {
  mechanismType: MechanismType
  parameters: Record<string, number>
  units: 'mm' | 'in'
  partMapping: Array<MechanismPartMapping>
}

export interface CadGenerationStatus {
  status: 'pending' | 'generating' | 'complete' | 'failed'
  generationMethod?: 'parametric' | 'zoo' | 'mechanism'
  zooRequestId?: string
  stepFileKey?: string
  errorMessage?: string
  promptUsed?: string
  boundingBox?: {
    minX: number
    minY: number
    minZ: number
    maxX: number
    maxY: number
    maxZ: number
  }
}

export interface AssemblyCompositionStatus {
  status:
    | 'pending'
    | 'planning'
    | 'rendering'
    | 'complete'
    | 'code_only'
    | 'failed'
  assemblyPlan?: string // JSON of AssemblyPlan
  kclProjectRef?: string
  assemblyStepFileKey?: string
  errorMessage?: string
}

// ============================================================================
// BOM Draft Types
// ============================================================================

export interface BomNodeDraft {
  tempId: string
  name: string
  existingItemId?: string
  existingItemNumber?: string
  isNew: boolean
  quantity: number
  findNumber?: number
  children: Array<BomNodeDraft>
  requirementTempIds: Array<string>
  partType?: 'Manufacture' | 'Purchase' | 'Software' | 'Phantom'
  material?: string
  rationale: string
  confidence: number // 0-1
  reviewStatus?: ReviewStatus
  reviewNote?: string
  // CAD generation metadata
  parametricSpec?: ParametricPartSpec
  interfaces?: Array<InterfaceIntent>
  interfaceMappings?: Array<InterfaceMapping>
  cadGeneration?: CadGenerationStatus
  assemblyComposition?: AssemblyCompositionStatus
  // Component catalog metadata
  catalogComponentId?: string
  requiresManualSourcing?: boolean
  selectedStockSize?: string // label from stockSizes for raw_stock entries
  // Manufacturing data (Layer 2)
  assignedToolId?: string // SessionTool.id from toolset
  manufacturingConstraints?: ManufacturingConstraints
  cadGenerationHint?: string // Detailed geometry description for CAD generation
  // Mechanism template (Layer 3)
  mechanismTemplate?: MechanismTemplate
}

export interface ProposedPart {
  tempId: string
  name: string
  description: string
  partType: 'Manufacture' | 'Purchase' | 'Software' | 'Phantom'
  material?: string
  estimatedCost?: number
  rationale: string
  satisfiesRequirements: Array<string> // requirement tempIds
  parametricSpec?: ParametricPartSpec
  // Component catalog metadata
  catalogComponentId?: string
  requiresManualSourcing?: boolean
  selectedStockSize?: string
  // Manufacturing data (Layer 2)
  assignedToolId?: string
  manufacturingConstraints?: ManufacturingConstraints
  cadGenerationHint?: string
  // Mechanism template (Layer 3)
  mechanismTemplate?: MechanismTemplate
}

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info'
  message: string
  path?: string // e.g., "rootAssembly.children[2].quantity"
}

export interface BomDraft {
  rootAssembly: BomNodeDraft
  proposedParts: Array<ProposedPart>
  requirementsCoverage: Record<string, Array<string>> // requirementTempId -> part tempIds
  uncoveredRequirements: Array<string> // requirement tempIds with no linked parts
  validationIssues: Array<ValidationIssue>
}

// ============================================================================
// Design Artifacts (persisted as JSONB)
// ============================================================================

export interface CadGenerationState {
  status:
    | 'not_started'
    | 'generating_parts'
    | 'assembling'
    | 'complete'
    | 'failed'
  partsTotal: number
  partsCompleted: number
  partsFailed: number
  assembliesTotal: number
  assembliesCompleted: number
  assembliesFailed: number
  startedAt?: string
  completedAt?: string
}

export interface DesignArtifacts {
  description: string
  toolset?: DesignSessionToolset
  requirements: Array<RequirementDraft>
  bom: BomDraft | null
  /** Tombstones of BOM nodes the user rejected — fed back into BOM prompts. */
  bomRejections?: Array<BomRejectionEntry>
  clarifications: Array<ClarificationEntry>
  userMessages: Array<UserMessage>
  pendingClarificationId?: string
  pendingClarification?: {
    id: string
    question: string
    options?: Array<string>
    multiSelect?: boolean
  }
  materializationResult?: MaterializationResult
  cadGenerationState?: CadGenerationState
}

// ============================================================================
// Materialization Types
// ============================================================================

/**
 * How materialization will write the session's artifacts into the PLM database.
 *
 * - 'create_design': the session has no target design — a new design is created
 *   in the session's program, and all items land on its main branch.
 * - 'add_to_design': the target design exists and is pre-release (no released
 *   items) — items are added directly to its main branch.
 * - 'eco_required': the target design has released items, so changes must go
 *   through an ECO branch. Materialization creates the ECO, adds the new items
 *   to its branch, and they are released with revision letters when the ECO is
 *   approved and merged.
 */
export type MaterializationMode =
  | 'create_design'
  | 'add_to_design'
  | 'eco_required'

/**
 * The materialization contract: exactly what executing materialization will do.
 * Both the preview shown to the user and the execution derive from this plan,
 * so the stated behavior cannot drift from the actual behavior.
 */
export interface MaterializationPlan {
  mode: MaterializationMode
  /** False when execution would be refused (see blockedReason) */
  supported: boolean
  programId: string
  programName: string | null
  targetDesignId: string | null
  targetDesignName: string | null
  /** Name the new design will be given (mode 'create_design' only) */
  newDesignName?: string
  /** Name of the ECO that will be created (mode 'eco_required' only) */
  ecoName?: string
  /** Lifecycle state every created item starts in */
  initialState: 'Draft'
  /**
   * Branch the items are created on. 'main' for the create/add modes; for
   * 'eco_required' the items land on a new ECO branch (whose name isn't known
   * until the ECO is created) but reach 'main' when the ECO merges.
   */
  targetBranch: 'main'
  /** Human-readable reason when supported is false */
  blockedReason?: string
}

export interface MaterializationPreview {
  plan: MaterializationPlan
  newPartsCount: number
  reusedPartsCount: number
  newRequirementsCount: number
  bomRelationshipsCount: number
  items: Array<{
    tempId: string
    name: string
    itemType: string
    isNew: boolean
    existingItemNumber?: string
  }>
}

export interface MaterializationResult {
  // mode/designName/initialState are optional because results persisted by
  // older sessions predate these fields
  mode?: MaterializationMode
  designId: string
  designName?: string | null
  /** Lifecycle state the created items start in */
  initialState?: 'Draft'
  /** The ECO created when materializing into a released design (mode 'eco_required') */
  ecoId?: string
  ecoNumber?: string
  createdItems: Array<{
    tempId: string
    itemId: string
    itemNumber: string
    itemType: string
    name: string
  }>
  bomRelationshipsCreated: number
}

// ============================================================================
// Engine Interface
// ============================================================================

export interface DesignSessionContext {
  userId: string
  programId: string
  designId?: string
  description: string
  aiChatSessionId?: string
}

export interface RequirementEdit {
  action: 'add' | 'update' | 'remove'
  tempId?: string
  data?: Partial<RequirementDraft>
}

export interface DesignEngine {
  createSession: (
    context: DesignSessionContext,
  ) => Promise<{ sessionId: string }>
  runToolsetEstablishmentStage: (
    sessionId: string,
    signal?: AbortSignal,
  ) => AsyncIterable<StageEvent>
  runRequirementsStage: (
    sessionId: string,
    signal?: AbortSignal,
  ) => AsyncIterable<StageEvent>
  runBomStage: (
    sessionId: string,
    signal?: AbortSignal,
  ) => AsyncIterable<StageEvent>
  runCadGenerationStage: (
    sessionId: string,
    signal?: AbortSignal,
  ) => AsyncIterable<StageEvent>
  runAssemblyCompositionStage: (
    sessionId: string,
    signal?: AbortSignal,
  ) => AsyncIterable<StageEvent>
  regeneratePart: (
    sessionId: string,
    tempId: string,
    feedback?: string,
    signal?: AbortSignal,
  ) => AsyncIterable<StageEvent>
  pause: (sessionId: string) => Promise<void>
  updateDescription: (sessionId: string, description: string) => Promise<void>
  updateRequirements: (
    sessionId: string,
    edits: Array<RequirementEdit>,
  ) => Promise<void>
  confirmStage: (
    sessionId: string,
    stage: 'toolset' | 'requirements' | 'bom' | 'cad' | 'assembly',
    options?: { force?: boolean },
  ) => Promise<void>
  reopenStage: (
    sessionId: string,
    targetStage: ReopenableStage,
  ) => Promise<void>
  materialize: (sessionId: string) => Promise<MaterializationResult>
}

// ============================================================================
// LLM History Entry (persisted as JSONB)
// ============================================================================

export interface LlmHistoryEntry {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

const clarificationEntrySchema = z.object({
  questionId: z.string(),
  question: z.string(),
  options: z.array(z.string()).optional(),
  multiSelect: z.boolean().optional(),
  answer: z.string(),
  answeredAt: z.string(),
  stage: z.string(),
})

const userMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  createdAt: z.string(),
  stage: z.string(),
})

const requirementDraftSchema = z.object({
  tempId: z.string(),
  name: z.string(),
  description: z.string(),
  requirementType: z.enum([
    'Functional',
    'Performance',
    'Interface',
    'Constraint',
    'Other',
  ]),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  verificationMethod: z.enum([
    'Analysis',
    'Inspection',
    'Test',
    'Demonstration',
  ]),
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
  source: z.enum(['ai', 'user']),
  reviewStatus: z.enum(['proposed', 'accepted', 'rejected', 'edited']).optional(),
  reviewNote: z.string().optional(),
})

const bomRejectionEntrySchema = z.object({
  tempId: z.string(),
  name: z.string(),
  partType: z.string().optional(),
  parentName: z.string().optional(),
  reason: z.string().optional(),
  rejectedAt: z.string(),
  stage: z.string(),
})

// BOM tree is deeply recursive — validate top-level shape, passthrough nested
const bomNodeDraftSchema: z.ZodType<unknown> = z
  .object({
    tempId: z.string(),
    name: z.string(),
    isNew: z.boolean(),
    quantity: z.number(),
    children: z.lazy(() => z.array(bomNodeDraftSchema)),
    requirementTempIds: z.array(z.string()),
    rationale: z.string(),
    confidence: z.number(),
  })
  .passthrough()

const bomDraftSchema = z
  .object({
    rootAssembly: bomNodeDraftSchema,
    proposedParts: z.array(
      z.object({ tempId: z.string(), name: z.string() }).passthrough(),
    ),
    requirementsCoverage: z.record(z.string(), z.array(z.string())),
    uncoveredRequirements: z.array(z.string()),
    validationIssues: z.array(
      z.object({ severity: z.string(), message: z.string() }).passthrough(),
    ),
  })
  .nullable()

export const designSessionStageSchema = z.enum([
  'idle',
  'toolset_establishment',
  'toolset_review',
  'requirements_drafting',
  'requirements_review',
  'bom_drafting',
  'bom_review',
  'materialization',
  'cad_generation',
  'cad_review',
  'assembly_composition',
  'assembly_review',
  'complete',
  'error',
])

/** Validates artifacts for PATCH endpoint — validates structure without over-constraining deeply nested types */
export const designArtifactsPatchSchema = z
  .object({
    description: z.string(),
    toolset: z
      .object({
        scope: z.enum(['in_house_only', 'in_house_preferred', 'unconstrained']),
        tools: z.array(
          z
            .object({
              id: z.string(),
              name: z.string(),
              toolType: z.string(),
              toolSubtype: z.string(),
            })
            .passthrough(),
        ),
      })
      .optional(),
    requirements: z.array(requirementDraftSchema),
    bom: bomDraftSchema,
    bomRejections: z.array(bomRejectionEntrySchema),
    clarifications: z.array(clarificationEntrySchema),
    userMessages: z.array(userMessageSchema),
    pendingClarificationId: z.string().optional(),
    pendingClarification: z
      .object({
        id: z.string(),
        question: z.string(),
        options: z.array(z.string()).optional(),
        multiSelect: z.boolean().optional(),
      })
      .optional(),
    materializationResult: z
      .object({
        designId: z.string(),
      })
      .passthrough()
      .optional(),
    cadGenerationState: z
      .object({
        status: z.enum([
          'not_started',
          'generating_parts',
          'assembling',
          'complete',
          'failed',
        ]),
      })
      .passthrough()
      .optional(),
  })
  .partial()
