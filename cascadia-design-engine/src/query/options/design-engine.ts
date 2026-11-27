// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import type {
  DesignArtifacts,
  DesignSessionStage,
  LlmHistoryEntry,
  MaterializationPreview,
} from '@/design-engine/types'
import type { ResolvedCadGenerationSettings } from '@/cad-generation/settings-types'
import { CAD_GENERATION_DEFAULTS } from '@/cad-generation/settings-types'
import { qk } from '@/query/keys'
import { apiFetch } from '@/api/client'

/**
 * A collaborative design session as the list endpoint returns it.
 *
 * Sessions hang off `/api/v1/design-engine/sessions` rather than off the
 * resource root, so neither `collectionQuery` nor `entityQuery` fits.
 */
export interface DesignSessionSummary {
  id: string
  userId: string
  title: string | null
  stage: string
  status: string
  programId: string | null
  updatedAt: string
  createdAt: string
  completedAt: string | null
  forkedFromSessionId?: string | null
}

/** The current user's design sessions, or a program's when scoped. */
export function designSessionListQuery(programId?: string) {
  return queryOptions({
    queryKey: qk.collection(
      'design-engine',
      'sessions',
      programId ? { programId } : {},
    ),
    queryFn: async (): Promise<Array<DesignSessionSummary>> => {
      const qs = new URLSearchParams()
      if (programId) qs.set('programId', programId)
      const suffix = qs.size > 0 ? `?${qs}` : ''
      const result = await apiFetch<{
        data: { sessions: Array<DesignSessionSummary> }
      }>(`/api/v1/design-engine/sessions${suffix}`)
      return result.data.sessions
    },
  })
}

export interface DesignSessionDetail extends DesignSessionSummary {
  artifacts: DesignArtifacts | null
  llmHistory?: Array<LlmHistoryEntry> | null
}

export function designSessionDetailQuery(id: string) {
  return queryOptions({
    queryKey: qk.detail('design-engine', id),
    queryFn: async (): Promise<DesignSessionDetail> => {
      const result = await apiFetch<{ data: { session: DesignSessionDetail } }>(
        `/api/v1/design-engine/sessions/${id}`,
      )
      return result.data.session
    },
  })
}

/**
 * The review gates that diff against their own last confirmed snapshot.
 * Every other stage has nothing to diff, so the query stays disabled there.
 */
const DIFFABLE_REVIEW_STAGES: ReadonlyArray<DesignSessionStage> = [
  'requirements_review',
  'bom_review',
]

/**
 * The artifacts a review gate diffs against: the latest confirmed snapshot of
 * that same gate, or `null` when there is none.
 *
 * A snapshot of a gate exists only once that gate has been confirmed, so a
 * first-pass review resolves to `null` and shows no diff; a reopened one
 * resolves to what was approved last time round. The endpoint returns metadata
 * newest-first, so the first entry matching the stage is the one to fetch.
 *
 * `staleTime: 0` overrides the client's 30s default deliberately. Confirming a
 * gate writes a new snapshot through the SSE stream, which names no resource
 * to invalidate; re-entering the gate inside the default window would
 * otherwise diff against the snapshot from the round before last.
 */
export function sessionDiffBaseQuery(
  sessionId: string,
  stage: DesignSessionStage,
) {
  return queryOptions({
    queryKey: qk.sub('design-engine', sessionId, 'diff-base', { stage }),
    queryFn: async (): Promise<DesignArtifacts | null> => {
      const list = await apiFetch<{
        data: { snapshots: Array<{ id: string; stage: string }> }
      }>(`/api/v1/design-engine/sessions/${sessionId}/snapshots`)
      const match = list.data.snapshots.find((s) => s.stage === stage)
      if (!match) return null
      const detail = await apiFetch<{
        data: { snapshot: { artifacts: DesignArtifacts } }
      }>(`/api/v1/design-engine/sessions/${sessionId}/snapshots/${match.id}`)
      return detail.data.snapshot.artifacts
    },
    enabled: DIFFABLE_REVIEW_STAGES.includes(stage),
    staleTime: 0,
  })
}

/**
 * What materializing this session would create — the plan and its counts.
 *
 * A read, despite the endpoint's name: the POST at the same path is what
 * writes. Enabled only on the materialization stage, so the preview loads on
 * arrival rather than on every mount of the workspace.
 */
export function sessionMaterializePreviewQuery(
  sessionId: string,
  stage: DesignSessionStage,
) {
  return queryOptions({
    queryKey: qk.sub('design-engine', sessionId, 'materialize-preview'),
    queryFn: async (): Promise<MaterializationPreview> => {
      const result = await apiFetch<{
        data: { preview: MaterializationPreview }
      }>(`/api/v1/design-engine/sessions/${sessionId}/materialize`)
      return result.data.preview
    },
    enabled: stage === 'materialization',
  })
}

/**
 * The AI CAD generation settings as the admin endpoint reports them: the
 * stored switch and agent budget with defaults applied, plus whether any AI
 * provider resolves for the agent to call.
 */
export interface CadSettingsResponse {
  settings: ResolvedCadGenerationSettings
  aiConfigured: boolean
}

/**
 * AI CAD generation settings.
 *
 * Keyed under `admin` rather than `design-engine` because the endpoint is
 * mounted on the admin surface and a settings write is what changes it — so
 * saving the form, which names `admin`, restages this without the card
 * reloading itself.
 */
export function cadSettingsQuery() {
  return queryOptions({
    queryKey: qk.collection('admin', 'cad-settings'),
    queryFn: async (): Promise<CadSettingsResponse> => {
      const result = await apiFetch<{ data: Partial<CadSettingsResponse> }>(
        '/api/v1/admin/cad-settings',
      )
      return {
        settings: result.data.settings ?? CAD_GENERATION_DEFAULTS,
        aiConfigured: result.data.aiConfigured ?? false,
      }
    },
  })
}
