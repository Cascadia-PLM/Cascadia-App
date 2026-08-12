// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, KeyRound } from 'lucide-react'
import { PageContainer } from '@/components/layout'
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { ApiKeyManager } from '@/components/api-keys'
import { myApiKeysQuery } from '@/lib/query'

export const Route = createFileRoute('/profile/api-keys')({
  component: MyApiKeysPage,
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(myApiKeysQuery()),
})

/**
 * Self-service key management.
 *
 * Every read and write here is scoped server-side to the signed-in user, so
 * this page needs no permission beyond being authenticated — which is the
 * point: issuing a key for your own integrations should not require an admin.
 */
function MyApiKeysPage() {
  const { data, isPending, error } = useQuery(myApiKeysQuery())

  const keys = data?.apiKeys ?? []
  const activeCount = keys.filter((k) => k.status === 'active').length

  return (
    <PageContainer maxWidth="wide">
      <div>
        <Link
          to="/profile"
          className="inline-flex items-center gap-1 text-sm text-slate-600 dark:text-slate-400 hover:underline"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to profile
        </Link>
        <div className="flex items-center gap-3 mt-3">
          <KeyRound className="w-8 h-8 text-slate-700 dark:text-slate-300" />
          <div>
            <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
              API Keys
            </h1>
            <p className="text-slate-600 dark:text-slate-400 mt-2">
              Credentials for headless clients that act as you — CI jobs, CAD
              connectors, and MCP.
            </p>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>Your keys</CardTitle>
            <Badge variant="secondary">{activeCount} active</Badge>
          </div>
          <CardDescription>
            A key can only ever do less than you can, never more. Scope each one
            to what its client actually needs — if it leaks, the scope is the
            blast radius.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isPending && (
            <p className="text-sm text-muted-foreground">Loading keys…</p>
          )}
          {error && (
            <div className="bg-destructive/10 border border-destructive/20 text-destructive px-4 py-3 rounded">
              {error.message}
            </div>
          )}
          {!isPending && !error && (
            <ApiKeyManager
              keys={data.apiKeys}
              scopableRoles={data.scopableRoles}
              basePath="/api/v1/auth/api-keys"
              scope="self"
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Using a key</CardTitle>
          <CardDescription>
            Send it as a bearer token on any <code>/api/v1</code> request.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="p-3 bg-slate-100 dark:bg-slate-800 rounded text-xs overflow-x-auto">
            {`curl -H "Authorization: Bearer csc_..." \\
  ${typeof window === 'undefined' ? '' : window.location.origin}/api/v1/parts`}
          </pre>
          <p className="text-xs text-muted-foreground mt-3">
            The same key authenticates the MCP endpoint at{' '}
            <code>/api/v1/mcp</code>, which accepts keys only — never browser
            sessions.
          </p>
        </CardContent>
      </Card>
    </PageContainer>
  )
}
