// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import { apiHandler } from '@/lib/api/handler'
import { PackageRegistry } from '@/lib/packages'

const adapt = tagged('Packages')

const app = new Hono()

const packageStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  features: z.array(z.string()),
  enabled: z.boolean(),
})

// GET /api/v1/packages
// Which optional packages this instance is licensed for. The client uses this
// to decide whether to render package-specific UI; the server enforces the same
// entitlement independently on every gated route.
app.get(
  '/',
  adapt(
    apiHandler(
      {
        openapi: {
          summary: 'List optional packages and whether they are enabled',
          responses: {
            200: {
              schema: z.object({ packages: z.array(packageStatusSchema) }),
            },
          },
        },
      },
      // Reading the registry is synchronous; no `async` so the promise is
      // returned rather than manufactured around an awaitless body.
      () => Promise.resolve({ packages: PackageRegistry.list() }),
    ),
  ),
)

export default app
