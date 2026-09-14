// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { defineDomainEvent } from '../publish'

export const designCreatedPayloadSchema = z
  .object({
    designId: z.string().uuid(),
    /**
     * Nullable because the column is: a design outside any program is
     * representable in this schema, and telling a consumer so is better than
     * an event that throws at runtime on a row the database accepts.
     */
    programId: z.string().uuid().nullable(),
    name: z.string(),
    code: z.string(),
    /** `Family`, `Product`, `Variant`, … */
    designType: z.string(),
    parentDesignId: z.string().uuid().nullable(),
    /** Set when this design was cloned from another. */
    cloneSourceDesignId: z.string().uuid().nullable(),
    /**
     * The main branch and initial commit a versioned design gets on creation.
     * Both null for a `Family` design, which is a container and has neither —
     * the one field the two arms legitimately differ on.
     */
    mainBranchId: z.string().uuid().nullable(),
    initialCommitId: z.string().uuid().nullable(),
  })
  .strict()

export type DesignCreatedPayload = z.infer<typeof designCreatedPayloadSchema>

/**
 * A design came into existence.
 *
 * **Why this exists at all:** `design.released` names a design a consumer has
 * never been told about, so anything mirroring the hierarchy had to back-fill a
 * design out of its first release — inferring a parent from a child, which is
 * exactly the shape of integration that breaks the first time a design is
 * created and not released.
 *
 * Design creation has two arms — a `Family` container and a versioned design
 * that gets a main branch and an initial commit — and both emit this same
 * shape, so a consumer cannot tell them apart except by the fields that
 * legitimately differ (`mainBranchId` and `initialCommitId`, null for a
 * family). That is deliberate: an integration keying on which arm ran would be
 * keying on an implementation detail.
 *
 * Emitted however a design comes into existence: `DesignService.create` —
 * which the design-clone job goes through, so a clone's target design is
 * announced like any other — and MBOM generation, for the Manufacturing design
 * it derives. What those two jobs deliberately do not announce is the
 * thousands of masters they copy into the new design; see `item.updated`'s
 * note on volume paths.
 */
export const DESIGN_CREATED = defineDomainEvent({
  type: 'design.created',
  schemaVersion: 1,
  description: 'A design was created',
  subjectType: 'design',
  payloadSchema: designCreatedPayloadSchema,
})

export const programCreatedPayloadSchema = z
  .object({
    programId: z.string().uuid(),
    name: z.string(),
    code: z.string(),
    status: z.string(),
    customer: z.string().nullable(),
    contractNumber: z.string().nullable(),
  })
  .strict()

export type ProgramCreatedPayload = z.infer<typeof programCreatedPayloadSchema>

/**
 * A program came into existence, with its creator already an administrator of
 * it.
 *
 * A program is the permission boundary, so this is the top of the hierarchy a
 * consumer mirroring Cascadia needs first. The event commits with both the
 * program row *and* the creator's membership row — which, before this, were two
 * separate pool writes: a failed membership insert left an ownerless program,
 * and an ownerless permission boundary is not recoverable through the product.
 */
export const PROGRAM_CREATED = defineDomainEvent({
  type: 'program.created',
  schemaVersion: 1,
  description: 'A program was created, with its creator as administrator',
  subjectType: 'program',
  payloadSchema: programCreatedPayloadSchema,
})
