// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { and, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm'
import { tagged } from '../adapter'
import { apiHandler } from '@/lib/api/handler'
import { ItemService } from '@/lib/items/services/ItemService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import { db } from '@/lib/db'
import { items, parts, tasks } from '@/lib/db/schema'
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Dashboard')

const app = new Hono()

// GET /api/dashboard/stats
app.get(
  '/stats',
  adapt(
    apiHandler({}, async ({ user }) => {
      // Every tile is a count of things the caller may open. Passing
      // `programIds: null` here meant "all programs" — the admin scope — so
      // the home page reported the whole instance to everyone.
      const [accessDesignIds, programIds] = await Promise.all([
        AccessControlService.getAccessibleDesignIds(user.id),
        AccessControlService.getAccessibleProgramIds(user.id),
      ])

      const [
        partsResult,
        documentsResult,
        changeOrdersResult,
        requirementsResult,
        tasksResult,
        designsResult,
        programsResult,
      ] = await Promise.all([
        ItemService.search('Part', { limit: 1, accessDesignIds }),
        ItemService.search('Document', { limit: 1, accessDesignIds }),
        ItemService.search('ChangeOrder', { limit: 1, accessDesignIds }),
        ItemService.search('Requirement', { limit: 1, accessDesignIds }),
        ItemService.search('Task', { limit: 1, accessDesignIds }),
        DesignService.search({ limit: 1, programIds }),
        ProgramService.search({ limit: 1, programIds }),
      ])

      return {
        stats: {
          parts: partsResult.total,
          documents: documentsResult.total,
          changeOrders: changeOrdersResult.total,
          requirements: requirementsResult.total,
          tasks: tasksResult.total,
          designs: designsResult.total,
          programs: programsResult.total,
        },
      }
    }),
  ),
)

// GET /api/dashboard/charts
app.get(
  '/charts',
  adapt(
    apiHandler({}, async ({ user }) => {
      const sevenDaysAgo = new Date()
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
      sevenDaysAgo.setHours(0, 0, 0, 0)

      // Same bound as /stats: these charts count rows, and a count is a
      // disclosure. `undefined` for cross-program authority drops out of the
      // `and(...)` below, leaving the query as it was.
      const accessDesignIds = await AccessControlService.getAccessibleDesignIds(
        user.id,
      )
      const inScope = accessDesignIds
        ? or(
            accessDesignIds.length > 0
              ? inArray(items.designId, accessDesignIds)
              : undefined,
            isNull(items.designId),
          )
        : undefined

      const [
        changeOrdersByDay,
        partsReleasedByDay,
        partsByTypeResult,
        tasksByPriorityResult,
      ] = await Promise.all([
        // Change orders created in the last week (grouped by day)
        db
          .select({
            date: sql<string>`DATE(${items.createdAt})`.as('date'),
            count: sql<number>`COUNT(*)::int`.as('count'),
          })
          .from(items)
          .where(
            and(
              eq(items.itemType, 'ChangeOrder'),
              gte(items.createdAt, sevenDaysAgo),
              or(isNull(items.isDeleted), eq(items.isDeleted, false)),
              inScope,
            ),
          )
          .groupBy(sql`DATE(${items.createdAt})`)
          .orderBy(sql`DATE(${items.createdAt})`),

        // Parts released in the last week (grouped by day)
        db
          .select({
            date: sql<string>`DATE(${items.modifiedAt})`.as('date'),
            count: sql<number>`COUNT(*)::int`.as('count'),
          })
          .from(items)
          .where(
            and(
              eq(items.itemType, 'Part'),
              eq(items.state, 'Released'),
              gte(items.modifiedAt, sevenDaysAgo),
              or(isNull(items.isDeleted), eq(items.isDeleted, false)),
              inScope,
            ),
          )
          .groupBy(sql`DATE(${items.modifiedAt})`)
          .orderBy(sql`DATE(${items.modifiedAt})`),

        // Parts by type
        db
          .select({
            partType: parts.partType,
            count: sql<number>`COUNT(*)::int`.as('count'),
          })
          .from(parts)
          .innerJoin(items, eq(parts.itemId, items.id))
          .where(
            and(
              or(isNull(items.isDeleted), eq(items.isDeleted, false)),
              inScope,
            ),
          )
          .groupBy(parts.partType),

        // Tasks by priority (non-completed only)
        db
          .select({
            priority: tasks.priority,
            count: sql<number>`COUNT(*)::int`.as('count'),
          })
          .from(tasks)
          .innerJoin(items, eq(tasks.itemId, items.id))
          .where(
            and(
              or(isNull(items.isDeleted), eq(items.isDeleted, false)),
              or(eq(items.state, 'Draft'), eq(items.state, 'InReview')),
              inScope,
            ),
          )
          .groupBy(tasks.priority),
      ])

      // Fill in missing days for the week
      const days: Array<string> = []
      for (let i = 6; i >= 0; i--) {
        const date = new Date()
        date.setDate(date.getDate() - i)
        days.push(date.toISOString().slice(0, 10))
      }

      return {
        changeOrdersWeekly: days.map((day) => ({
          date: day,
          count: changeOrdersByDay.find((d) => d.date === day)?.count ?? 0,
        })),
        partsReleasedWeekly: days.map((day) => ({
          date: day,
          count: partsReleasedByDay.find((d) => d.date === day)?.count ?? 0,
        })),
        partsByType: partsByTypeResult.map((p) => ({
          name: p.partType || 'Unspecified',
          value: p.count,
        })),
        tasksByPriority: tasksByPriorityResult.map((t) => ({
          name: t.priority || 'Unspecified',
          value: t.count,
        })),
      }
    }),
  ),
)

export default app
