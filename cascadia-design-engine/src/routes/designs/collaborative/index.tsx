// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Design Sessions List Route
 *
 * Lists the current user's collaborative design engine sessions and lets
 * them resume any one (navigating to /designs/collaborative/$sessionId).
 * URL: /designs/collaborative
 */

import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
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
import { designSessionListQuery } from '@/query/options/design-engine'
import { programListQuery } from '@/query'

export const Route = createFileRoute('/designs/collaborative/')({
  component: DesignSessionsListPage,
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.ensureQueryData(designSessionListQuery()),
      queryClient.ensureQueryData(programListQuery()),
    ])
  },
})

function DesignSessionsListPage() {
  const { data: sessionRows = [] } = useQuery(designSessionListQuery())
  const { data: programs = [] } = useQuery(programListQuery())

  // The sessions endpoint returns `programId` only; the table renders the
  // program's code and name, so join them from the programs list here.
  const sessions = useMemo<Array<DesignSessionRow>>(() => {
    const byId = new Map(programs.map((p) => [p.id, p]))
    return sessionRows.map((session) => {
      const program = session.programId
        ? byId.get(session.programId)
        : undefined
      return {
        ...session,
        programCode: program?.code,
        programName: program?.name,
      }
    })
  }, [sessionRows, programs])

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
