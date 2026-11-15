// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
/**
 * Interfaces: what joins the system elements of a design.
 *
 * An interface is an item (`Interface`), versioned and ECO-controlled like
 * the elements it joins. What it joins is its `CONNECTS` edges — interface →
 * element, one per element, the port named in the edge's metadata. They are
 * the interface's own content: outgoing edges, so they ride its checkout
 * onto the working copy and the release rebuilds them on the released row,
 * by the machinery every other outgoing edge uses.
 *
 * Two rules follow from who owns what:
 *
 * - attaching or detaching an end is an edit of the **interface**, so the
 *   edit lock asks for the interface (a row created on the branch, or one
 *   whose checkout the caller holds) and never for the element;
 * - a port is a field of the **element**, so creating one on the way — the
 *   block diagram's "drag to a new port" — is an edit of the element and
 *   needs the element to be editable.
 *
 * The design's interfaces at a version context, with their ends resolved,
 * are part of `SystemElementService.forDesign`.
 */
import { and, eq } from 'drizzle-orm'
import { CONNECTS_PORT_KEY } from '@cascadia/commons/items/types/interface'
import { db } from '../db'
import { itemRelationships, items } from '../db/schema/items'
import { NotFoundError, ValidationError } from '../errors'
import { ItemService } from '../items/services/ItemService'
import { CONNECTS_RELATIONSHIP } from '../items/traceability-relationships'
import { CheckoutService } from './CheckoutService'
import { resolveOnBranch } from './link-ends'
import { SystemElementService } from './SystemElementService'
import type { LinkWriteOptions } from './link-ends'
import type { PortInput } from './SystemElementService'
import type {
  InterfaceItem,
  InterfaceKind,
} from '@cascadia/commons/items/types/interface'
import type { PersistedItem } from '@cascadia/commons/items/types/base'

/**
 * One end of an interface as a caller names it: an element, and either a
 * port it already has or one to create on it.
 */
export type InterfaceEndInput = { elementId: string } & (
  | { portId: string; newPort?: undefined }
  | { newPort: PortInput; portId?: undefined }
)

export interface ConnectInput {
  name?: string | null
  kind?: InterfaceKind | null
  ends: Array<InterfaceEndInput>
}

type EdgeRow = typeof itemRelationships.$inferSelect

export class InterfaceService {
  private static async requireInterface(
    interfaceId: string,
    operation: string,
  ): Promise<PersistedItem> {
    const item = await ItemService.findById(interfaceId)
    if (!item || item.itemType !== 'Interface') {
      throw new NotFoundError('Interface', interfaceId, { operation })
    }
    return item
  }

  /** The `CONNECTS` edge `relationshipId`, or a not-found. */
  static async requireEnd(relationshipId: string): Promise<EdgeRow> {
    const [edge] = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.id, relationshipId),
          eq(itemRelationships.relationshipType, CONNECTS_RELATIONSHIP),
        ),
      )
      .limit(1)
    if (!edge) {
      throw new NotFoundError('Interface end', relationshipId, {
        operation: 'requireEnd',
      })
    }
    return edge
  }

  /**
   * The element row an end attaches to and the port on it: the element as
   * the branch has it, the port checked against that row's list or created
   * on it.
   */
  private static async resolveEnd(
    designId: string,
    end: InterfaceEndInput,
    userId: string,
    options?: LinkWriteOptions,
  ): Promise<{ element: PersistedItem; portId: string }> {
    const named = await ItemService.findById(end.elementId)
    if (!named || named.itemType !== 'SystemElement') {
      throw new NotFoundError('SystemElement', end.elementId, {
        operation: 'resolveEnd',
      })
    }
    if (named.designId !== designId) {
      throw new ValidationError(
        `${named.itemNumber} is not in this design; an interface does not cross designs`,
        [{ field: 'ends', message: 'Element is in another design' }],
      )
    }
    const element = options?.branchId
      ? await resolveOnBranch(named, options.branchId)
      : named
    if (end.newPort) {
      const port = await SystemElementService.addPort(
        element.id,
        end.newPort,
        userId,
      )
      return { element, portId: port.id }
    }
    const ports = await SystemElementService.getPorts(element.id)
    if (!ports.some((port) => port.id === end.portId)) {
      throw new ValidationError(`${element.itemNumber} has no such port`, [
        { field: 'ends', message: 'Port not found on the element' },
      ])
    }
    return { element, portId: end.portId }
  }

  /** The masters of the elements `interfaceRowId` is already attached to. */
  private static async attachedMasters(
    interfaceRowId: string,
  ): Promise<Set<string>> {
    const rows = await db
      .select({ masterId: items.masterId })
      .from(itemRelationships)
      .innerJoin(items, eq(items.id, itemRelationships.targetId))
      .where(
        and(
          eq(itemRelationships.sourceId, interfaceRowId),
          eq(itemRelationships.relationshipType, CONNECTS_RELATIONSHIP),
        ),
      )
    return new Set(rows.map((row) => row.masterId))
  }

  /**
   * Create an interface in `designId` joining `ends` — the block diagram's
   * "draw a line". Each end names a different element. Ports asked for are
   * created first, so a refusal to edit an element leaves no interface
   * behind; the interface is then created (on the branch when one is named)
   * and attached.
   */
  static async connect(
    designId: string,
    input: ConnectInput,
    userId: string,
    options?: LinkWriteOptions,
  ): Promise<{ interfaceId: string; itemNumber: string }> {
    if (input.ends.length === 0) {
      throw new ValidationError('An interface needs at least one end', [
        { field: 'ends', message: 'At least one end is required' },
      ])
    }
    if (
      new Set(input.ends.map((end) => end.elementId)).size !== input.ends.length
    ) {
      throw new ValidationError(
        'An interface attaches to an element once; name each element in one end',
        [{ field: 'ends', message: 'Two ends name the same element' }],
      )
    }

    const resolved: Array<{ element: PersistedItem; portId: string }> = []
    for (const end of input.ends) {
      resolved.push(await this.resolveEnd(designId, end, userId, options))
    }
    if (
      new Set(resolved.map(({ element }) => element.masterId)).size !==
      resolved.length
    ) {
      throw new ValidationError(
        'An interface attaches to an element once; name each element in one end',
        [{ field: 'ends', message: 'Two ends name the same element' }],
      )
    }

    const name =
      input.name?.trim() ||
      resolved.map(({ element }) => element.itemNumber).join(' – ')
    const data = {
      itemType: 'Interface',
      itemNumber: '',
      name,
      designId,
      ...(input.kind && { interfaceKind: input.kind }),
    } as unknown as InterfaceItem
    const created = options?.branchId
      ? ((
          await ItemService.createOnBranch(
            'Interface',
            data,
            options.branchId,
            `Created Interface ${name}`,
            userId,
          )
        ).item as PersistedItem)
      : await ItemService.create<PersistedItem>(
          'Interface',
          data as unknown as PersistedItem,
          userId,
        )

    // A row created on a branch is branch content already, but editing its
    // structure still takes the lock — as the item's page does before an
    // edit. The creator holds it from here, so the ends can be attached now
    // and the interface edited further without a separate checkout.
    if (options?.branchId) {
      await CheckoutService.checkout(
        { itemMasterId: created.masterId, branchId: options.branchId },
        userId,
      )
    }

    for (const { element, portId } of resolved) {
      await ItemService.addRelationship(
        created.id,
        element.id,
        CONNECTS_RELATIONSHIP,
        userId,
        { metadata: { [CONNECTS_PORT_KEY]: portId } },
      )
    }
    return { interfaceId: created.id, itemNumber: created.itemNumber }
  }

  /**
   * Attach an existing interface to one more element — how a line becomes a
   * bus. Refused when the interface already attaches to that element.
   */
  static async attach(
    interfaceId: string,
    end: InterfaceEndInput,
    userId: string,
    options?: LinkWriteOptions,
  ): Promise<{ relationshipId: string }> {
    const named = await this.requireInterface(interfaceId, 'attach')
    if (!named.designId) {
      throw new ValidationError('The interface belongs to no design')
    }
    const item = options?.branchId
      ? await resolveOnBranch(named, options.branchId)
      : named
    const target = await ItemService.findById(end.elementId)
    if (target && (await this.attachedMasters(item.id)).has(target.masterId)) {
      throw new ValidationError(
        `${item.itemNumber} is already attached to ${target.itemNumber}`,
        [{ field: 'elementId', message: 'Already attached to this element' }],
      )
    }
    const { element, portId } = await this.resolveEnd(
      named.designId,
      end,
      userId,
      options,
    )
    const edge = await ItemService.addRelationship(
      item.id,
      element.id,
      CONNECTS_RELATIONSHIP,
      userId,
      { metadata: { [CONNECTS_PORT_KEY]: portId } },
    )
    return { relationshipId: edge.id }
  }

  /** Detach one end. The interface stays, with whatever ends remain. */
  static async detach(relationshipId: string, userId: string): Promise<void> {
    await this.requireEnd(relationshipId)
    await ItemService.removeRelationship(relationshipId, userId)
  }
}
