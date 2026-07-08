/**
 * Design Sessions List Route
 *
 * Lists the current user's collaborative design engine sessions and lets
 * them resume any one (navigating to /designs/collaborative/$sessionId).
 * URL: /designs/collaborative
 */

import { createFileRoute } from '@tanstack/react-router'
import type { DesignSessionRow } from '@/components/design-engine/SessionsTable'
import { SessionsTable } from '@/components/design-engine/SessionsTable'
import { PageContainer } from '@/components/layout'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { apiFetch } from '@/lib/api/client'

interface ProgramInfo {
  id: string
  code: string
  name: string
}

// The list endpoint returns full DesignSession rows; we only read list fields.
interface SessionListItem {
  id: string
  userId: string
  title: string | null
  stage: string
  status: string
  programId: string | null
  updatedAt: string
  createdAt: string
  completedAt: string | null
}

export const Route = createFileRoute('/designs/collaborative/')({
  component: DesignSessionsListPage,
  loader: async () => {
    let sessions: Array<DesignSessionRow> = []
    try {
      const sessionsResult = await apiFetch<{
        data: { sessions: Array<SessionListItem> }
      }>('/api/v1/design-engine/sessions')

      // Program names are best-effort enrichment — failing here still lists sessions.
      let programMap = new Map<string, ProgramInfo>()
      try {
        const programsResult = await apiFetch<{
          data: { programs: Array<ProgramInfo> }
        }>('/api/v1/programs')
        programMap = new Map(
          programsResult.data.programs.map((p) => [p.id, p]),
        )
      } catch {
        // Ignore — sessions render without program codes.
      }

      sessions = sessionsResult.data.sessions.map((s) => ({
        id: s.id,
        userId: s.userId,
        title: s.title,
        stage: s.stage,
        status: s.status,
        programId: s.programId,
        programCode: s.programId
          ? programMap.get(s.programId)?.code
          : undefined,
        programName: s.programId
          ? programMap.get(s.programId)?.name
          : undefined,
        updatedAt: s.updatedAt,
        createdAt: s.createdAt,
        completedAt: s.completedAt,
      }))
    } catch (error) {
      console.error('Error loading design sessions:', error)
    }

    return { sessions }
  },
})

function DesignSessionsListPage() {
  const { sessions } = Route.useLoaderData()

  return (
    <PageContainer>
      {/* Header */}
      <div>
        <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
          Design Sessions
        </h1>
        <p className="text-slate-600 dark:text-slate-400 mt-2">
          Resume a collaborative design engine session you've started.
        </p>
      </div>

      {/* Sessions Table */}
      <Card>
        <CardHeader>
          <CardTitle>Your Sessions</CardTitle>
          <CardDescription>
            {sessions.length} {sessions.length === 1 ? 'session' : 'sessions'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SessionsTable items={sessions} />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
