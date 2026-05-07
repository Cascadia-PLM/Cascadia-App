/**
 * Collaborative Design Workspace Route
 *
 * Full-page workspace for the collaborative design engine.
 * URL: /designs/collaborative/:sessionId
 */

import { createFileRoute } from '@tanstack/react-router'
import { CollaborativeWorkspace } from '@/components/design-engine/CollaborativeWorkspace'

export const Route = createFileRoute('/designs/collaborative/$sessionId')({
  loader: async ({ params }) => {
    const response = await fetch(
      `/api/v1/design-engine/sessions/${params.sessionId}`,
    )
    if (!response.ok) {
      throw new Error('Failed to load design session')
    }
    const data = await response.json()
    return { session: data.data.session }
  },
  component: CollaborativeWorkspacePage,
})

function CollaborativeWorkspacePage() {
  const { session } = Route.useLoaderData()

  return (
    <CollaborativeWorkspace
      sessionId={session.id}
      initialSession={{
        title: session.title,
        stage: session.stage,
        status: session.status,
        artifacts: session.artifacts,
      }}
    />
  )
}
