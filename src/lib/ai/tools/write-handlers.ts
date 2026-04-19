/**
 * AI Write Tool Handlers
 *
 * Server-side implementations for write (mutation) tools.
 * Each handler:
 * 1. Checks if confirmation is required
 * 2. Returns confirmation message if not yet confirmed
 * 3. Executes the operation after confirmation
 * 4. Enforces ECO-as-Branch model for protected designs
 */

import { randomUUID } from 'node:crypto'

import { withWritePermissionAndAudit } from './permission-wrapper'
import type { BaseItem } from '@/lib/items/types/base'

import type { ToolContext, WriteOperationMeta } from './permission-wrapper'
import { ChangeOrderService } from '@/lib/items/services/ChangeOrderService'
import { ItemService } from '@/lib/items/services/ItemService'
import { BranchService } from '@/lib/services/BranchService'
import { DesignService } from '@/lib/services/DesignService'
import { aiLogger } from '@/lib/logging/logger'

// ============================================================================
// Input Types (manually defined for better type inference)
// ============================================================================

interface CreateItemInput {
  itemType: 'Part' | 'Document' | 'Requirement' | 'Task'
  name: string
  designId?: string
  changeOrderId?: string
  description?: string
  partType?: 'Manufacture' | 'Purchase' | 'Software' | 'Phantom'
  material?: string
  assignee?: string
  priority?: 'low' | 'medium' | 'high' | 'critical'
  dueDate?: string
  requirementType?:
    | 'Functional'
    | 'Performance'
    | 'Interface'
    | 'Constraint'
    | 'Other'
  confirmed?: boolean
}

interface UpdateItemInput {
  itemId: string
  name?: string
  description?: string
  partType?: 'Manufacture' | 'Purchase' | 'Software' | 'Phantom'
  material?: string
  weight?: number
  weightUnit?: string
  cost?: number
  costCurrency?: string
  assignee?: string
  priority?: 'low' | 'medium' | 'high' | 'critical'
  dueDate?: string
  changeOrderId?: string
  confirmed?: boolean
}

interface CreateRelationshipInput {
  sourceItemId: string
  targetItemId: string
  relationshipType: 'BOM' | 'Document' | 'Affects'
  quantity?: number
  findNumber?: number
  referenceDesignator?: string
  confirmed?: boolean
}

interface TransitionItemStateInput {
  itemId: string
  targetState: string
  comments?: string
  confirmed?: boolean
}

interface CreateChangeOrderInput {
  name: string
  changeType: 'ECO' | 'ECN' | 'Deviation' | 'MCO'
  priority?: 'low' | 'medium' | 'high' | 'critical'
  reasonForChange?: string
  impactDescription?: string
  affectedItemIds?: Array<string>
  designIds?: Array<string>
  confirmed?: boolean
}

// Write tool response structure
interface WriteToolResponse {
  requiresConfirmation: boolean
  confirmationMessage?: string
  confirmationDetails?: {
    action: string
    itemType?: string
    itemName?: string
    designName?: string
    changeOrderNumber?: string
    additionalInfo?: Array<string>
  }
  success?: boolean
  itemId?: string
  itemNumber?: string
  error?: string
  suggestCreateEco?: boolean
  suggestEcoMessage?: string
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Resolve a design identifier to a UUID.
 * Accepts either a UUID or a design code (e.g., "PC-PROTO").
 */
async function resolveDesignId(
  designIdOrCode: string | undefined,
): Promise<string | undefined> {
  if (!designIdOrCode) return undefined

  // Check if it's already a UUID (basic pattern check)
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (uuidPattern.test(designIdOrCode)) {
    return designIdOrCode
  }

  // Otherwise, treat as design code and look it up
  const design = await DesignService.getByCode(designIdOrCode)
  if (!design) {
    throw new Error(`Design not found: "${designIdOrCode}"`)
  }
  return design.id
}

/**
 * Check if a design requires ECO for modifications.
 * Returns true if the design has any released items on main branch.
 */
async function designRequiresEco(designId: string): Promise<boolean> {
  return BranchService.isMainBranchProtected(designId)
}

/**
 * Get design name for display in confirmation messages.
 */
async function getDesignName(designId: string): Promise<string> {
  const design = await DesignService.getById(designId)
  return design?.name || design?.code || 'Unknown Design'
}

/**
 * Build a confirmation response (operation not executed yet).
 */
function confirmationRequired(
  action: string,
  details: WriteToolResponse['confirmationDetails'],
  message?: string,
): WriteToolResponse {
  return {
    requiresConfirmation: true,
    confirmationMessage:
      message || `Are you sure you want to ${action.toLowerCase()}?`,
    confirmationDetails: details,
  }
}

/**
 * Build an ECO suggestion response.
 */
function suggestEco(itemNumber: string, designName: string): WriteToolResponse {
  return {
    requiresConfirmation: false,
    suggestCreateEco: true,
    suggestEcoMessage: `Item ${itemNumber} is in a released design "${designName}". Would you like me to create an ECO to make these changes?`,
  }
}

/**
 * Build a success response.
 */
function successResponse(
  itemId: string,
  itemNumber: string,
  message?: string,
): WriteToolResponse {
  return {
    requiresConfirmation: false,
    success: true,
    itemId,
    itemNumber,
    confirmationMessage: message,
  }
}

/**
 * Build an error response.
 */
function errorResponse(error: string): WriteToolResponse {
  return {
    requiresConfirmation: false,
    success: false,
    error,
  }
}

// ============================================================================
// create_item handler
// ============================================================================

async function createItemHandlerImpl(
  input: CreateItemInput,
  context: ToolContext,
): Promise<WriteToolResponse> {
  try {
    // Step 1: Resolve design if provided
    const designId = await resolveDesignId(input.designId)

    // Step 2: Check if design requires ECO (post-release)
    if (designId && !input.changeOrderId) {
      const requiresEco = await designRequiresEco(designId)
      if (requiresEco) {
        const designName = await getDesignName(designId)
        return {
          requiresConfirmation: false,
          suggestCreateEco: true,
          suggestEcoMessage: `The design "${designName}" has released items and requires an ECO to add new items. Would you like me to create an ECO first?`,
        }
      }
    }

    // Step 3: If not confirmed, return confirmation request
    if (!input.confirmed) {
      const designName = designId ? await getDesignName(designId) : undefined
      return confirmationRequired(
        `Create ${input.itemType}`,
        {
          action: 'create',
          itemType: input.itemType,
          itemName: input.name,
          designName,
          additionalInfo: [
            input.description
              ? `Description: ${input.description.slice(0, 50)}...`
              : '',
            input.changeOrderId ? `ECO: ${input.changeOrderId}` : '',
          ].filter(Boolean),
        },
        `Create new ${input.itemType} "${input.name}"${designName ? ` in ${designName}` : ''}?`,
      )
    }

    // Step 4: Execute creation
    const itemData: Partial<BaseItem> = {
      name: input.name,
      designId: designId,
    }

    // Add type-specific fields
    if (input.description) {
      ;(itemData as any).description = input.description
    }

    // Part-specific fields
    if (input.itemType === 'Part') {
      if (input.partType) (itemData as any).partType = input.partType
      if (input.material) (itemData as any).material = input.material
    }

    // Task-specific fields
    if (input.itemType === 'Task') {
      if (input.assignee) (itemData as any).assignee = input.assignee
      if (input.priority) (itemData as any).priority = input.priority
      if (input.dueDate) (itemData as any).dueDate = input.dueDate
    }

    // Requirement-specific fields
    if (input.itemType === 'Requirement') {
      if (input.requirementType) (itemData as any).type = input.requirementType
    }

    // If we have an ECO, create via branch checkout
    if (input.changeOrderId && designId) {
      // Get the ECO's branch for this design
      const ecoDesigns = await ChangeOrderService.getEcoDesigns(
        input.changeOrderId,
      )
      const ecoDesign = ecoDesigns.find((ed) => ed.designId === designId)

      if (ecoDesign?.branchId) {
        const { item } = await ItemService.createOnBranch(
          input.itemType,
          itemData as BaseItem,
          ecoDesign.branchId,
          `Created ${input.itemType} ${input.name}`,
          context.userId,
        )
        return successResponse(
          item.id || '',
          item.itemNumber || '',
          `Created ${input.itemType} ${item.itemNumber || 'item'} "${input.name}"`,
        )
      }
    }

    // Otherwise, create directly (pre-release design or no design)
    const item = await ItemService.create(
      input.itemType,
      itemData as BaseItem,
      context.userId,
    )

    return successResponse(
      item.id || '',
      item.itemNumber || '',
      `Created ${input.itemType} ${item.itemNumber || 'item'} "${input.name}"`,
    )
  } catch (e) {
    return errorResponse(
      e instanceof Error ? e.message : 'Failed to create item',
    )
  }
}

export const createItemHandler = (
  input: CreateItemInput,
  context: ToolContext,
) => {
  const meta: WriteOperationMeta = {
    actionType: 'create',
    affectedItemIds: [],
    wasConfirmed: input.confirmed ?? false,
    transactionId: randomUUID(),
  }

  return withWritePermissionAndAudit<CreateItemInput, WriteToolResponse>(
    'create_item',
    { resource: 'parts', action: 'create' },
    createItemHandlerImpl,
  )(input, context, meta)
}

// ============================================================================
// update_item handler
// ============================================================================

async function updateItemHandlerImpl(
  input: UpdateItemInput,
  context: ToolContext,
): Promise<WriteToolResponse> {
  try {
    // Step 1: Get the item
    const item = await ItemService.findById(input.itemId)
    if (!item) {
      return errorResponse(`Item with ID ${input.itemId} not found`)
    }

    // Step 2: Check if item requires ECO for editing
    const isReleased = item.state === 'Released'
    const hasDesign = !!item.designId

    if (isReleased && hasDesign && !input.changeOrderId) {
      // Check if design is protected
      const requiresEco = await designRequiresEco(item.designId!)
      if (requiresEco) {
        const designName = await getDesignName(item.designId!)
        return suggestEco(item.itemNumber || 'item', designName)
      }
    }

    // Step 3: If not confirmed, return confirmation request
    if (!input.confirmed) {
      const changes: Array<string> = []
      if (input.name) changes.push(`Name: "${input.name}"`)
      if (input.description)
        changes.push(`Description: "${input.description.slice(0, 30)}..."`)
      if (input.partType) changes.push(`Type: ${input.partType}`)
      if (input.material) changes.push(`Material: ${input.material}`)
      if (input.weight)
        changes.push(`Weight: ${input.weight} ${input.weightUnit || ''}`)
      if (input.cost)
        changes.push(`Cost: ${input.cost} ${input.costCurrency || ''}`)
      if (input.priority) changes.push(`Priority: ${input.priority}`)
      if (input.assignee) changes.push(`Assignee: ${input.assignee}`)

      return confirmationRequired(
        `Update ${item.itemType}`,
        {
          action: 'update',
          itemType: item.itemType,
          itemName: item.name || item.itemNumber,
          additionalInfo:
            changes.length > 0 ? changes : ['No changes specified'],
        },
        `Update ${item.itemType} ${item.itemNumber}?`,
      )
    }

    // Step 4: Build update data
    const updateData: Partial<BaseItem> = {}
    if (input.name !== undefined) updateData.name = input.name
    if (input.description !== undefined)
      (updateData as any).description = input.description
    if (input.partType !== undefined)
      (updateData as any).partType = input.partType
    if (input.material !== undefined)
      (updateData as any).material = input.material
    if (input.weight !== undefined) (updateData as any).weight = input.weight
    if (input.weightUnit !== undefined)
      (updateData as any).weightUnit = input.weightUnit
    if (input.cost !== undefined) (updateData as any).cost = input.cost
    if (input.costCurrency !== undefined)
      (updateData as any).costCurrency = input.costCurrency
    if (input.assignee !== undefined)
      (updateData as any).assignee = input.assignee
    if (input.priority !== undefined)
      (updateData as any).priority = input.priority
    if (input.dueDate !== undefined) (updateData as any).dueDate = input.dueDate

    // Step 5: Execute update
    // If ECO provided and item is Released, checkout first
    if (input.changeOrderId && isReleased && hasDesign) {
      await ChangeOrderService.checkoutItemToEco(
        input.changeOrderId,
        input.itemId,
        context.userId,
      )
    }

    const updated = await ItemService.update(
      input.itemId,
      updateData,
      context.userId,
    )

    return successResponse(
      updated.id || '',
      updated.itemNumber || '',
      `Updated ${updated.itemType} ${updated.itemNumber || 'item'}`,
    )
  } catch (e) {
    return errorResponse(
      e instanceof Error ? e.message : 'Failed to update item',
    )
  }
}

export const updateItemHandler = (
  input: UpdateItemInput,
  context: ToolContext,
) => {
  const meta: WriteOperationMeta = {
    actionType: 'update',
    affectedItemIds: [input.itemId],
    wasConfirmed: input.confirmed ?? false,
    transactionId: randomUUID(),
  }

  return withWritePermissionAndAudit<UpdateItemInput, WriteToolResponse>(
    'update_item',
    { resource: 'parts', action: 'update' },
    updateItemHandlerImpl,
  )(input, context, meta)
}

// ============================================================================
// create_relationship handler
// ============================================================================

async function createRelationshipHandlerImpl(
  input: CreateRelationshipInput,
  context: ToolContext,
): Promise<WriteToolResponse & { relationshipId?: string }> {
  try {
    // Step 1: Get source and target items
    const [sourceItem, targetItem] = await Promise.all([
      ItemService.findById(input.sourceItemId),
      ItemService.findById(input.targetItemId),
    ])

    if (!sourceItem) {
      return errorResponse(`Source item ${input.sourceItemId} not found`)
    }
    if (!targetItem) {
      return errorResponse(`Target item ${input.targetItemId} not found`)
    }

    // Step 2: Validate relationship type is appropriate
    if (input.relationshipType === 'BOM') {
      if (sourceItem.itemType !== 'Part') {
        return errorResponse('BOM relationships can only be created from Parts')
      }
      if (targetItem.itemType !== 'Part') {
        return errorResponse('BOM relationships can only target Parts')
      }
      // Check for circular reference
      if (sourceItem.id === targetItem.id) {
        return errorResponse('Cannot create BOM relationship to itself')
      }
    }

    // Step 3: If not confirmed, return confirmation request
    if (!input.confirmed) {
      const relationshipInfo = [
        `${sourceItem.itemNumber} → ${targetItem.itemNumber}`,
      ]
      if (input.quantity) relationshipInfo.push(`Quantity: ${input.quantity}`)
      if (input.findNumber) relationshipInfo.push(`Find #: ${input.findNumber}`)
      if (input.referenceDesignator)
        relationshipInfo.push(`Ref Des: ${input.referenceDesignator}`)

      return confirmationRequired(
        `Create ${input.relationshipType} Relationship`,
        {
          action: 'relationship',
          itemType: input.relationshipType,
          itemName: `${sourceItem.itemNumber} → ${targetItem.itemNumber}`,
          additionalInfo: relationshipInfo,
        },
        `Add ${targetItem.itemNumber} to ${sourceItem.itemNumber}'s ${input.relationshipType}?`,
      )
    }

    // Step 4: Create relationship
    const relationship = await ItemService.addRelationship(
      input.sourceItemId,
      input.targetItemId,
      input.relationshipType,
      context.userId,
      {
        quantity: input.quantity?.toString(),
        findNumber: input.findNumber,
        referenceDesignator: input.referenceDesignator,
      },
    )

    return {
      requiresConfirmation: false,
      success: true,
      relationshipId: relationship.id,
      confirmationMessage: `Added ${input.relationshipType} relationship: ${sourceItem.itemNumber} → ${targetItem.itemNumber}`,
    }
  } catch (e) {
    return errorResponse(
      e instanceof Error ? e.message : 'Failed to create relationship',
    )
  }
}

export const createRelationshipHandler = (
  input: CreateRelationshipInput,
  context: ToolContext,
) => {
  const meta: WriteOperationMeta = {
    actionType: 'relationship',
    affectedItemIds: [input.sourceItemId, input.targetItemId],
    wasConfirmed: input.confirmed ?? false,
    transactionId: randomUUID(),
  }

  return withWritePermissionAndAudit<
    CreateRelationshipInput,
    WriteToolResponse & { relationshipId?: string }
  >(
    'create_relationship',
    { resource: 'parts', action: 'update' },
    createRelationshipHandlerImpl,
  )(input, context, meta)
}

// ============================================================================
// transition_item_state handler
// ============================================================================

async function transitionItemStateHandlerImpl(
  input: TransitionItemStateInput,
  context: ToolContext,
): Promise<
  WriteToolResponse & {
    previousState?: string
    newState?: string
    transitionedAt?: string
  }
> {
  try {
    // Step 1: Get the item
    const item = await ItemService.findById(input.itemId)
    if (!item) {
      return errorResponse(`Item with ID ${input.itemId} not found`)
    }

    const currentState = item.state || 'Draft'

    // Step 2: If not confirmed, return confirmation request
    if (!input.confirmed) {
      return confirmationRequired(
        `Transition ${item.itemType}`,
        {
          action: 'transition',
          itemType: item.itemType,
          itemName: item.name || item.itemNumber,
          additionalInfo: [
            `From: ${currentState}`,
            `To: ${input.targetState}`,
            input.comments ? `Comments: ${input.comments}` : '',
          ].filter(Boolean),
        },
        `Transition ${item.itemType} ${item.itemNumber} from ${currentState} to ${input.targetState}?`,
      )
    }

    // Step 3: Handle transition based on item type
    if (item.itemType === 'ChangeOrder') {
      // Use ChangeOrderService for ECO transitions
      const result = await ChangeOrderService.transitionWorkflow(
        input.itemId,
        input.targetState,
        context.userId,
        input.comments,
      )

      if (!result.success) {
        return errorResponse(result.error || 'Transition failed')
      }

      // Get updated state
      const updatedItem = await ItemService.findById(input.itemId)

      return {
        requiresConfirmation: false,
        success: true,
        itemId: input.itemId,
        itemNumber: item.itemNumber,
        previousState: currentState,
        newState: updatedItem?.state || input.targetState,
        transitionedAt: new Date().toISOString(),
        confirmationMessage: `Transitioned ${item.itemNumber} from ${currentState} to ${input.targetState}`,
      }
    } else {
      // For regular items, just update the state directly
      // Note: In a full implementation, you'd check if the transition is valid
      const updated = await ItemService.update(
        input.itemId,
        { state: input.targetState },
        context.userId,
      )

      return {
        requiresConfirmation: false,
        success: true,
        itemId: input.itemId,
        itemNumber: item.itemNumber,
        previousState: currentState,
        newState: updated.state || input.targetState,
        transitionedAt: new Date().toISOString(),
        confirmationMessage: `Transitioned ${item.itemNumber} from ${currentState} to ${input.targetState}`,
      }
    }
  } catch (e) {
    return errorResponse(
      e instanceof Error ? e.message : 'Failed to transition item state',
    )
  }
}

export const transitionItemStateHandler = (
  input: TransitionItemStateInput,
  context: ToolContext,
) => {
  const meta: WriteOperationMeta = {
    actionType: 'transition',
    affectedItemIds: [input.itemId],
    wasConfirmed: input.confirmed ?? false,
    transactionId: randomUUID(),
  }

  return withWritePermissionAndAudit<
    TransitionItemStateInput,
    WriteToolResponse & {
      previousState?: string
      newState?: string
      transitionedAt?: string
    }
  >(
    'transition_item_state',
    { resource: 'change_orders', action: 'update' },
    transitionItemStateHandlerImpl,
  )(input, context, meta)
}

// ============================================================================
// create_change_order handler
// ============================================================================

async function createChangeOrderHandlerImpl(
  input: CreateChangeOrderInput,
  context: ToolContext,
): Promise<
  WriteToolResponse & {
    changeOrderId?: string
    branchIds?: Array<string>
    affectedItemsAdded?: number
  }
> {
  try {
    // Step 1: Resolve design IDs if provided
    const resolvedDesignIds: Array<string> = []
    if (input.designIds) {
      for (const designIdOrCode of input.designIds) {
        const designId = await resolveDesignId(designIdOrCode)
        if (designId) resolvedDesignIds.push(designId)
      }
    }

    // Step 2: If not confirmed, return confirmation request
    if (!input.confirmed) {
      const additionalInfo: Array<string> = [
        `Type: ${input.changeType}`,
        `Priority: ${input.priority || 'medium'}`,
      ]
      if (input.reasonForChange)
        additionalInfo.push(`Reason: ${input.reasonForChange.slice(0, 50)}...`)
      if (input.affectedItemIds?.length)
        additionalInfo.push(`Affected Items: ${input.affectedItemIds.length}`)
      if (resolvedDesignIds.length)
        additionalInfo.push(`Designs: ${resolvedDesignIds.length}`)

      return confirmationRequired(
        'Create Change Order',
        {
          action: 'create',
          itemType: 'ChangeOrder',
          itemName: input.name,
          additionalInfo,
        },
        `Create ${input.changeType} "${input.name}"?`,
      )
    }

    // Step 3: Create the change order
    const changeOrderData: Partial<BaseItem> & {
      changeType: string
      priority: string
      reasonForChange?: string
      impactDescription?: string
    } = {
      name: input.name,
      changeType: input.changeType,
      priority: input.priority || 'medium',
      reasonForChange: input.reasonForChange,
      impactDescription: input.impactDescription,
    }

    const changeOrder = await ItemService.create(
      'ChangeOrder',
      changeOrderData as BaseItem,
      context.userId,
    )

    const changeOrderId = changeOrder.id || ''

    // Step 4: Auto-start workflow
    try {
      if (changeOrderId) {
        await ChangeOrderService.autoStartWorkflow(
          changeOrderId,
          input.changeType,
          context.userId,
        )
      }
    } catch (workflowError) {
      aiLogger.warn(
        { err: workflowError, ecoNumber: changeOrder.itemNumber },
        'Failed to auto-start workflow for ECO',
      )
    }

    // Step 5: Add designs to ECO (creates branches)
    const branchIds: Array<string> = []
    for (const designId of resolvedDesignIds) {
      try {
        if (changeOrderId) {
          const ecoDesign = await ChangeOrderService.addDesignToEco(
            changeOrderId,
            designId,
            context.userId,
          )
          if (ecoDesign.branchId) branchIds.push(ecoDesign.branchId)
        }
      } catch (e) {
        aiLogger.warn({ err: e, designId }, 'Failed to add design to ECO')
      }
    }

    // Step 6: Add affected items if provided
    let affectedItemsAdded = 0
    if (input.affectedItemIds && changeOrderId) {
      for (const itemId of input.affectedItemIds) {
        try {
          const item = await ItemService.findById(itemId)
          if (item) {
            await ChangeOrderService.addAffectedItem(
              changeOrderId,
              {
                affectedItemId: itemId,
                changeAction: item.state === 'Released' ? 'revise' : 'release',
                currentState: item.state,
                currentRevision: item.revision,
              },
              context.userId,
            )
            affectedItemsAdded++
          }
        } catch (e) {
          aiLogger.warn({ err: e, itemId }, 'Failed to add affected item')
        }
      }
    }

    return {
      requiresConfirmation: false,
      success: true,
      itemId: changeOrderId || undefined,
      itemNumber: changeOrder.itemNumber || undefined,
      changeOrderId: changeOrderId || undefined,
      branchIds,
      affectedItemsAdded,
      confirmationMessage: `Created ${input.changeType} ${changeOrder.itemNumber || 'ECO'} "${input.name}"`,
    }
  } catch (e) {
    return errorResponse(
      e instanceof Error ? e.message : 'Failed to create change order',
    )
  }
}

export const createChangeOrderHandler = (
  input: CreateChangeOrderInput,
  context: ToolContext,
) => {
  const meta: WriteOperationMeta = {
    actionType: 'create',
    affectedItemIds: input.affectedItemIds || [],
    wasConfirmed: input.confirmed ?? false,
    transactionId: randomUUID(),
  }

  return withWritePermissionAndAudit<
    CreateChangeOrderInput,
    WriteToolResponse & {
      changeOrderId?: string
      branchIds?: Array<string>
      affectedItemsAdded?: number
    }
  >(
    'create_change_order',
    { resource: 'change_orders', action: 'create' },
    createChangeOrderHandlerImpl,
  )(input, context, meta)
}
