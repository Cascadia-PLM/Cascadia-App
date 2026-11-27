// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Collaborative Design Workspace Route
 *
 * Full-page workspace for the collaborative design engine.
 * URL: /designs/collaborative/:sessionId
 */

import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { CollaborativeWorkspace } from '@/components/design-engine/CollaborativeWorkspace'
import { designSessionDetailQuery } from '@/query/options/design-engine'

export const Route = createFileRoute('/designs/collaborative/$sessionId')({
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(designSessionDetailQuery(params.sessionId)),
  component: CollaborativeWorkspacePage,
})

function CollaborativeWorkspacePage() {
  const { sessionId } = Route.useParams()
  const { data: session } = useQuery(designSessionDetailQuery(sessionId))

  if (!session) return null

  return (
    <CollaborativeWorkspace
      sessionId={session.id}
      initialSession={{
        title: session.title,
        stage: session.stage,
        status: session.status,
        artifacts: session.artifacts,
        llmHistory: session.llmHistory,
      }}
    />
  )
}
