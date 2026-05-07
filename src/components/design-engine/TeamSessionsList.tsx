/**
 * TeamSessionsList - Shows all active design sessions for a program.
 * Allows program members to view (read-only) sessions owned by teammates.
 */

import { useCallback, useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Eye, Loader2, Play, Users } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui'

interface TeamSession {
  id: string
  userId: string
  userName?: string
  title: string | null
  description?: string
  stage: string
  status: string
  updatedAt: string
}

interface TeamSessionsListProps {
  programId: string
  currentUserId: string
}

const STAGE_LABELS: Record<string, string> = {
  idle: 'Not started',
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

export function TeamSessionsList({
  programId,
  currentUserId,
}: TeamSessionsListProps) {
  const [sessions, setSessions] = useState<Array<TeamSession>>([])
  const [loading, setLoading] = useState(true)

  const loadSessions = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch(
        `/api/v1/design-engine/sessions?programId=${programId}`,
      )
      if (response.ok) {
        const data = await response.json()
        setSessions(data.data?.sessions ?? [])
      }
    } catch {
      // Silently fail
    } finally {
      setLoading(false)
    }
  }, [programId])

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">
          Loading team sessions...
        </span>
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground text-sm">
        No active design sessions in this program.
      </div>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Users className="h-4 w-4" />
          Team Design Sessions
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {sessions.map((session) => {
          const isOwner = session.userId === currentUserId
          return (
            <div
              key={session.id}
              className="flex items-center justify-between p-3 rounded-md border hover:bg-muted/30"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">
                    {session.title || 'Untitled session'}
                  </span>
                  {isOwner && (
                    <Badge variant="outline" className="text-xs">
                      You
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {STAGE_LABELS[session.stage] ?? session.stage}
                  {' \u00B7 '}
                  {new Date(session.updatedAt).toLocaleDateString()}
                </div>
              </div>
              <Link to={`/designs/collaborative/${session.id}`}>
                <Button variant="ghost" size="sm" className="gap-1.5">
                  {isOwner ? (
                    <>
                      <Play className="h-3.5 w-3.5" />
                      Continue
                    </>
                  ) : (
                    <>
                      <Eye className="h-3.5 w-3.5" />
                      View
                    </>
                  )}
                </Button>
              </Link>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
