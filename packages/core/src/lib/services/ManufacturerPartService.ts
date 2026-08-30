// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, ilike, ne, or } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { manufacturerParts, partManufacturerParts } from '@/lib/db/schema'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { likeContains } from '@/lib/db/like-pattern'
import { takeFirst } from '@/lib/db/take-first'

/**
 * Approved Manufacturer List (AML) service.
 *
 * Manufacturer parts are sourcing master data bound to a part's masterId so
 * the AML survives revisions (see docs/features/physical-parts-and-traceability.md).
 * Not change-controlled in v1; qualificationStatus carries the workflow.
 */

const supplierLinkSchema = z.object({
  supplier: z.string().min(1).max(200),
  sku: z.string().max(200).optional(),
  url: z.string().url().max(2000).optional(),
  price: z.number().nonnegative().optional(),
  leadTimeDays: z.number().int().nonnegative().optional(),
})

export const manufacturerPartCreateSchema = z.object({
  manufacturer: z.string().min(1).max(500),
  mpn: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  specs: z.record(z.string(), z.unknown()).optional(),
  datasheetUrl: z.string().url().max(2000).optional(),
  supplierLinks: z.array(supplierLinkSchema).optional(),
  notes: z.string().max(5000).optional(),
})

export const manufacturerPartUpdateSchema =
  manufacturerPartCreateSchema.partial()

export const QUALIFICATION_STATUSES = [
  'proposed',
  'approved',
  'obsolete',
] as const

export const amlAttachSchema = z
  .object({
    // Either an existing manufacturer part id, or inline data to create one.
    manufacturerPartId: z.string().uuid().optional(),
    manufacturerPart: manufacturerPartCreateSchema.optional(),
    qualificationStatus: z.enum(QUALIFICATION_STATUSES).optional(),
    isPreferred: z.boolean().optional(),
    notes: z.string().max(5000).optional(),
  })
  .refine((v) => !!v.manufacturerPartId !== !!v.manufacturerPart, {
    message: 'Provide exactly one of manufacturerPartId or manufacturerPart',
  })

export const amlMappingUpdateSchema = z.object({
  qualificationStatus: z.enum(QUALIFICATION_STATUSES).optional(),
  isPreferred: z.boolean().optional(),
  notes: z.string().max(5000).nullable().optional(),
})

export type ManufacturerPartCreate = z.infer<
  typeof manufacturerPartCreateSchema
>
export type ManufacturerPartUpdate = z.infer<
  typeof manufacturerPartUpdateSchema
>
export type AmlAttachInput = z.infer<typeof amlAttachSchema>
export type AmlMappingUpdate = z.infer<typeof amlMappingUpdateSchema>

export class ManufacturerPartService {
  static async search(criteria: { search?: string; limit?: number }) {
    const limit = Math.min(criteria.limit ?? 50, 200)
    const term = criteria.search?.trim()
    const pattern = term ? likeContains(term) : undefined

    const rows = await db
      .select()
      .from(manufacturerParts)
      .where(
        pattern
          ? or(
              ilike(manufacturerParts.manufacturer, pattern),
              ilike(manufacturerParts.mpn, pattern),
              ilike(manufacturerParts.description, pattern),
            )
          : undefined,
      )
      .orderBy(manufacturerParts.manufacturer, manufacturerParts.mpn)
      .limit(limit)

    return rows
  }

  static async getById(id: string) {
    const [row] = await db
      .select()
      .from(manufacturerParts)
      .where(eq(manufacturerParts.id, id))
      .limit(1)
    if (!row) throw new NotFoundError('ManufacturerPart', id)
    return row
  }

  static async create(data: ManufacturerPartCreate, userId: string) {
    const existing = await db
      .select({ id: manufacturerParts.id })
      .from(manufacturerParts)
      .where(
        and(
          eq(manufacturerParts.manufacturer, data.manufacturer),
          eq(manufacturerParts.mpn, data.mpn),
        ),
      )
      .limit(1)
    if (existing.length > 0) {
      throw new ValidationError(
        `Manufacturer part ${data.manufacturer} ${data.mpn} already exists`,
      )
    }

    return takeFirst(
      await db
        .insert(manufacturerParts)
        .values({
          ...data,
          createdBy: userId,
          modifiedBy: userId,
        })
        .returning(),
    )
  }

  static async update(
    id: string,
    data: ManufacturerPartUpdate,
    userId: string,
  ) {
    const [updated] = await db
      .update(manufacturerParts)
      .set({ ...data, modifiedBy: userId, modifiedAt: new Date() })
      .where(eq(manufacturerParts.id, id))
      .returning()
    if (!updated) throw new NotFoundError('ManufacturerPart', id)
    return updated
  }

  static async delete(id: string) {
    const [deleted] = await db
      .delete(manufacturerParts)
      .where(eq(manufacturerParts.id, id))
      .returning({ id: manufacturerParts.id })
    if (!deleted) throw new NotFoundError('ManufacturerPart', id)
  }

  /** All AML entries for a part lineage, preferred first, then by status/name. */
  static async listForPart(partMasterId: string) {
    const rows = await db
      .select({
        mapping: partManufacturerParts,
        manufacturerPart: manufacturerParts,
      })
      .from(partManufacturerParts)
      .innerJoin(
        manufacturerParts,
        eq(partManufacturerParts.manufacturerPartId, manufacturerParts.id),
      )
      .where(eq(partManufacturerParts.partMasterId, partMasterId))

    return rows
      .map((r) => ({ ...r.mapping, manufacturerPart: r.manufacturerPart }))
      .sort(
        (a, b) =>
          Number(b.isPreferred) - Number(a.isPreferred) ||
          a.manufacturerPart.manufacturer.localeCompare(
            b.manufacturerPart.manufacturer,
          ) ||
          a.manufacturerPart.mpn.localeCompare(b.manufacturerPart.mpn),
      )
  }

  /** Attach a manufacturer part (existing or created inline) to a part lineage. */
  static async attach(
    partMasterId: string,
    input: AmlAttachInput,
    userId: string,
  ) {
    return db.transaction(async (tx) => {
      let manufacturerPartId = input.manufacturerPartId

      if (!manufacturerPartId) {
        const mp = input.manufacturerPart!
        // Find-or-create on (manufacturer, mpn) so attaching a known part by
        // typing its identity does not fail on the unique constraint.
        const [existing] = await tx
          .select({ id: manufacturerParts.id })
          .from(manufacturerParts)
          .where(
            and(
              eq(manufacturerParts.manufacturer, mp.manufacturer),
              eq(manufacturerParts.mpn, mp.mpn),
            ),
          )
          .limit(1)
        if (existing) {
          manufacturerPartId = existing.id
        } else {
          const created = takeFirst(
            await tx
              .insert(manufacturerParts)
              .values({ ...mp, createdBy: userId, modifiedBy: userId })
              .returning({ id: manufacturerParts.id }),
          )
          manufacturerPartId = created.id
        }
      } else {
        const [exists] = await tx
          .select({ id: manufacturerParts.id })
          .from(manufacturerParts)
          .where(eq(manufacturerParts.id, manufacturerPartId))
          .limit(1)
        if (!exists) {
          throw new NotFoundError('ManufacturerPart', manufacturerPartId)
        }
      }

      const [already] = await tx
        .select({ id: partManufacturerParts.id })
        .from(partManufacturerParts)
        .where(
          and(
            eq(partManufacturerParts.partMasterId, partMasterId),
            eq(partManufacturerParts.manufacturerPartId, manufacturerPartId),
          ),
        )
        .limit(1)
      if (already) {
        throw new ValidationError(
          'This manufacturer part is already on the AML for this part',
        )
      }

      if (input.isPreferred) {
        await tx
          .update(partManufacturerParts)
          .set({ isPreferred: false })
          .where(eq(partManufacturerParts.partMasterId, partMasterId))
      }

      return takeFirst(
        await tx
          .insert(partManufacturerParts)
          .values({
            partMasterId,
            manufacturerPartId,
            qualificationStatus: input.qualificationStatus ?? 'proposed',
            isPreferred: input.isPreferred ?? false,
            notes: input.notes,
            createdBy: userId,
          })
          .returning(),
      )
    })
  }

  /**
   * One AML mapping row, by id.
   *
   * The routes that act on a mapping need its `partMasterId` before they can
   * decide whether the caller may reach it, and the mapping id is the only
   * thing the URL carries. Same lookup `updateMapping` and `detach` do.
   */
  static async getMapping(mappingId: string) {
    const [mapping] = await db
      .select()
      .from(partManufacturerParts)
      .where(eq(partManufacturerParts.id, mappingId))
      .limit(1)
    if (!mapping) throw new NotFoundError('AML mapping', mappingId)
    return mapping
  }

  static async updateMapping(mappingId: string, data: AmlMappingUpdate) {
    return db.transaction(async (tx) => {
      const [mapping] = await tx
        .select()
        .from(partManufacturerParts)
        .where(eq(partManufacturerParts.id, mappingId))
        .limit(1)
      if (!mapping) throw new NotFoundError('AML mapping', mappingId)

      // Only one preferred source per part lineage.
      if (data.isPreferred) {
        await tx
          .update(partManufacturerParts)
          .set({ isPreferred: false })
          .where(
            and(
              eq(partManufacturerParts.partMasterId, mapping.partMasterId),
              ne(partManufacturerParts.id, mappingId),
            ),
          )
      }

      return takeFirst(
        await tx
          .update(partManufacturerParts)
          .set(data)
          .where(eq(partManufacturerParts.id, mappingId))
          .returning(),
      )
    })
  }

  static async detach(mappingId: string) {
    const [deleted] = await db
      .delete(partManufacturerParts)
      .where(eq(partManufacturerParts.id, mappingId))
      .returning({ id: partManufacturerParts.id })
    if (!deleted) throw new NotFoundError('AML mapping', mappingId)
  }
}
