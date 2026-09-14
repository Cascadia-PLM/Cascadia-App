// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import { apiHandler, parseQuery } from '@/lib/api/handler'
import {
  ExtensionRegistry,
  GUARD_OPERATIONS,
  describeExtensions,
  disabledExtensionIds,
  isExtensionEnabled,
} from '@/lib/extensions'

const adapt = tagged('Extensions')

const app = new Hono()

const extensionSchema = z.object({
  id: z.string(),
  phase: z.enum(['guard', 'in-transaction', 'consumed']),
  /** The operation a guard attaches to, or the event type — or `*`. */
  on: z.string(),
  /** The declarative filter, or null when the extension matches everything. */
  when: z.record(z.string(), z.unknown()).nullable(),
  /** The package that contributed it; core's own read as `core`. */
  source: z.string(),
  description: z.string().nullable(),
  /**
   * Whether it runs on this instance: false when an operator switched it off in
   * `extensions.disabled`, or when the extension's own declaration says it does
   * not belong here — a module that is not licensed or not configured.
   */
  enabled: z.boolean(),
  /** Who switched it off when `enabled` is false; null when it runs. */
  disabledBy: z.enum(['operator', 'extension']).nullable(),
})

/**
 * What will run on a subject, in what phase, in what order, from which package.
 *
 * This is the question neither reference model can answer — Aras answers it
 * with a log file written by every handler, Unity with a third-party scene
 * inspector — and it is cheap here only because dispatch is one function over
 * one registry. Two registries would have made it unanswerable for half the
 * system, which is why the consumer registry was folded into this one.
 *
 * Order within the response is registration order per phase, which is the
 * documented tiebreak and the only ordering guarantee the layer offers.
 */
app.get(
  '/',
  adapt(
    apiHandler(
      {
        permission: ['system', 'manage'],
        openapi: {
          summary: 'List registered extensions',
          description:
            'Every extension this process can run, with the operation or ' +
            'event type it attaches to, its phase, its declarative filter and ' +
            'whether it runs here — switched off by an operator, or by its own ' +
            'declaration, when not. Optionally filtered to one subject.',
          request: {
            query: z.object({
              /**
               * An operation (`item.create`) or an event type
               * (`design.released`). Wildcard `consumed` extensions are
               * included for every event type, because they do run on it.
               */
              on: z.string().optional(),
            }),
          },
          responses: {
            200: {
              schema: z.object({
                extensions: z.array(extensionSchema),
                operations: z.array(
                  z.object({
                    operation: z.string(),
                    description: z.string(),
                  }),
                ),
              }),
            },
          },
        },
      },
      async ({ request }) => {
        const { on } = parseQuery(
          request,
          z.object({ on: z.string().optional() }),
        )
        const disabled = await disabledExtensionIds()
        // The operator's switch first, then the extension's own answer,
        // evaluated as dispatch evaluates it. Reading the switch alone reported
        // an unlicensed module's extension as enabled while it never ran.
        const extensions = await Promise.all(
          describeExtensions(on).map(async (extension) => {
            if (disabled.has(extension.id)) {
              return {
                ...extension,
                enabled: false,
                disabledBy: 'operator' as const,
              }
            }
            const registered = ExtensionRegistry.get(extension.id)
            const runs = registered
              ? await isExtensionEnabled(registered)
              : true
            return {
              ...extension,
              enabled: runs,
              disabledBy: runs ? null : ('extension' as const),
            }
          }),
        )
        return {
          extensions,
          // The five guard-able operations, so a caller can discover what a
          // guard may attach to without reading the source.
          operations: GUARD_OPERATIONS.map((operation) => ({
            operation: operation.operation,
            description: operation.description,
          })),
        }
      },
    ),
  ),
)

export default app
