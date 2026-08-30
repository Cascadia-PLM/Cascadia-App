// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * AI Write Tool Definitions
 *
 * This module defines write (mutation) tools for the AI chatbot using
 * TanStack AI's toolDefinition() with Zod schemas.
 *
 * Write operations require user confirmation before execution.
 * The confirmation flow is:
 * 1. Tool is called without a confirmationToken
 * 2. Returns requiresConfirmation: true with a message and a server-issued
 *    single-use confirmationToken bound to these exact parameters
 * 3. AI presents ConfirmationCard to user
 * 4. User clicks Confirm/Cancel
 * 5. AI repeats the same call with the confirmationToken from step 2
 * 6. Tool redeems the token (once, within its short expiry) and executes
 *
 * The legacy `confirmed: true` flag is accepted but ignored — such a call
 * degrades to a fresh preview with a new token, never a hard error.
 *
 * Tools:
 * - create_item: Create a new item of any registered type
 * - update_item: Update an existing item's properties
 * - create_relationship: Create BOM or Document relationships
 * - transition_item_state: Transition items through workflow states
 * - create_change_order: Create a new ECO for managing changes
 * - create_program: Create a new program (top-level container)
 */

import { toolDefinition } from '@tanstack/ai'
import { z } from 'zod'
import { ITEM_TYPE_NAMES } from './definitions'
import {
  changeOrderPrioritySchema,
  changeOrderTypeSchema,
} from '@/lib/items/types/change-order'
import { partTypeSchema } from '@/lib/items/types/part'
import { requirementTypeSchema } from '@/lib/items/types/requirement'
import { taskPrioritySchema } from '@/lib/items/types/task'

/**
 * Item types create_item can produce — every registered type except
 * ChangeOrder, which has its own tool (create_change_order) because ECO
 * creation also sets up branches and affected-item tracking.
 */
export const CREATABLE_ITEM_TYPE_NAMES = ITEM_TYPE_NAMES.filter(
  (name) => name !== 'ChangeOrder',
) as [string, ...Array<string>]

/**
 * Field enums below reuse the Zod enums exported by the item types that
 * validate the write (`partTypeSchema`, `taskPrioritySchema`,
 * `requirementTypeSchema`, `changeOrderTypeSchema`), never a hand-written
 * copy — the same reason `itemType` is derived from ITEM_TYPE_DEFINITIONS.
 *
 * A tool schema is a promise to the model: every value it advertises must be
 * one the server accepts, and every value the server accepts should be
 * requestable. Copies broke that promise in both directions —
 * `requirementType` offered three values the Requirement schema rejects
 * (surfacing as an opaque "Validation failed" from deep inside ItemService)
 * while hiding four it accepts, Task `priority` was lowercased against a
 * capitalized enum, and `changeType` omitted XCO. Reusing the schema node
 * makes that drift impossible rather than merely fixed.
 */

/** Append the accepted values to a field description, for models that read prose. */
function describeEnum(label: string, values: ReadonlyArray<string>): string {
  return `${label}. One of: ${values.join(', ')}`
}

// ============================================================================
// Shared Types
// ============================================================================

/**
 * Base confirmation response schema used by all write tools
 */
const confirmationResponseSchema = z.object({
  // When true, operation requires user confirmation
  requiresConfirmation: z.boolean(),
  // Single-use token to present on the confirmed call (present iff
  // requiresConfirmation is true)
  confirmationToken: z.string().optional(),
  // Human-readable message for the confirmation card
  confirmationMessage: z.string().optional(),
  // Structured data for the confirmation card
  confirmationDetails: z
    .object({
      action: z.string(),
      itemType: z.string().optional(),
      itemName: z.string().optional(),
      designName: z.string().optional(),
      changeOrderNumber: z.string().optional(),
      additionalInfo: z.array(z.string()).optional(),
    })
    .optional(),
  // Operation result (only present after confirmation)
  success: z.boolean().optional(),
  // Created/updated item ID
  itemId: z.string().optional(),
  // Item number for display
  itemNumber: z.string().optional(),
  // Error message if operation failed
  error: z.string().optional(),
  // Suggests creating an ECO when one is required
  suggestCreateEco: z.boolean().optional(),
  suggestEcoMessage: z.string().optional(),
})

// ============================================================================
// create_item - Create a new item in the PLM system
// ============================================================================

export const createItemDef = toolDefinition({
  name: 'create_item',
  description: `Create a new item in the PLM system.
Supports every registered item type except ChangeOrder — use create_change_order for ECOs.
For post-release designs (designs with Released items), requires a changeOrderId.
For pre-release designs, items can be created directly.
If changeOrderId is needed but not provided, the tool will suggest creating an ECO first.
Requires user confirmation before creating.`,
  inputSchema: z.object({
    itemType: z
      .enum(CREATABLE_ITEM_TYPE_NAMES)
      .describe(
        `The type of item to create. One of: ${CREATABLE_ITEM_TYPE_NAMES.join(', ')}`,
      ),
    name: z.string().describe('Name/title of the item'),
    designId: z
      .string()
      .optional()
      .describe(
        'Design ID (UUID) or code (e.g., "PC-PROTO") - required for Part/Document/Requirement',
      ),
    changeOrderId: z
      .string()
      .optional()
      .describe(
        'Change order ID to associate with (required for post-release designs)',
      ),
    // Common optional fields
    description: z.string().optional().describe('Item description'),
    // Part-specific fields
    partType: partTypeSchema
      .optional()
      .describe(
        describeEnum(
          'Part type classification (Parts only)',
          partTypeSchema.options,
        ),
      ),
    material: z
      .string()
      .optional()
      .describe('Material specification (Parts only)'),
    // Task-specific fields
    assignee: z
      .string()
      .optional()
      .describe('User ID of assignee (Tasks only)'),
    priority: taskPrioritySchema
      .optional()
      .describe(
        describeEnum('Priority level (Tasks only)', taskPrioritySchema.options),
      ),
    dueDate: z
      .string()
      .optional()
      .describe('Due date in ISO format (Tasks only)'),
    // Requirement-specific fields
    requirementType: requirementTypeSchema
      .optional()
      .describe(
        describeEnum(
          'Type of requirement (Requirements only)',
          requirementTypeSchema.options,
        ),
      ),
    // Confirmation plumbing
    confirmationToken: z
      .string()
      .optional()
      .describe(
        'Single-use token from the preview response. After the user ' +
          'approves, repeat the exact same call with this token to execute.',
      ),
    confirmed: z
      .boolean()
      .optional()
      .describe(
        'Deprecated — ignored. Confirmation requires the confirmationToken ' +
          'issued by the preview response.',
      ),
  }),
  outputSchema: confirmationResponseSchema,
})

// ============================================================================
// update_item - Update an existing item's properties
// ============================================================================

export const updateItemDef = toolDefinition({
  name: 'update_item',
  description: `Update an existing item's properties.
Items in Released state on main branch require an ECO checkout first.
If the item requires checkout but no changeOrderId is provided, suggests creating an ECO.
Requires user confirmation before updating.`,
  inputSchema: z.object({
    itemId: z.string().describe('ID (UUID) of the item to update'),
    // Properties to update (all optional)
    name: z.string().optional().describe('New name/title'),
    description: z.string().optional().describe('New description'),
    // Part-specific updates
    partType: partTypeSchema
      .optional()
      .describe(
        describeEnum('Part type classification', partTypeSchema.options),
      ),
    material: z.string().optional().describe('Material specification'),
    weight: z.number().optional().describe('Weight value'),
    weightUnit: z.string().optional().describe('Weight unit (kg, lb, etc.)'),
    cost: z.number().optional().describe('Cost value'),
    costCurrency: z
      .string()
      .optional()
      .describe('Currency code (USD, EUR, etc.)'),
    // Task-specific updates
    assignee: z.string().optional().describe('User ID of assignee'),
    priority: taskPrioritySchema
      .optional()
      .describe(describeEnum('Priority level', taskPrioritySchema.options)),
    dueDate: z.string().optional().describe('Due date in ISO format'),
    // ECO for checkout if needed
    changeOrderId: z
      .string()
      .optional()
      .describe('ECO ID for checkout if item is Released'),
    // Confirmation plumbing
    confirmationToken: z
      .string()
      .optional()
      .describe(
        'Single-use token from the preview response. After the user ' +
          'approves, repeat the exact same call with this token to execute.',
      ),
    confirmed: z
      .boolean()
      .optional()
      .describe(
        'Deprecated — ignored. Confirmation requires the confirmationToken ' +
          'issued by the preview response.',
      ),
  }),
  outputSchema: confirmationResponseSchema,
})

// ============================================================================
// create_relationship - Create BOM or Document relationships
// ============================================================================

export const createRelationshipDef = toolDefinition({
  name: 'create_relationship',
  description: `Create a relationship between two items.
Supports BOM (parent-child for parts), Document (attach document to item), and Affects (ECO affects item).
Validates that the relationship type is valid for the item types involved.
Requires user confirmation before creating.`,
  inputSchema: z.object({
    sourceItemId: z.string().describe('ID of the parent/source item'),
    targetItemId: z.string().describe('ID of the child/target item'),
    relationshipType: z
      .enum(['BOM', 'Document', 'Affects'])
      .describe('Type of relationship'),
    // BOM-specific fields
    quantity: z
      .number()
      .optional()
      .describe('Quantity of child items in parent (BOM only)'),
    findNumber: z
      .number()
      .optional()
      .describe('Find number in assembly (BOM only)'),
    referenceDesignator: z
      .string()
      .optional()
      .describe('Reference designator like R1, C2 (BOM only)'),
    // Confirmation plumbing
    confirmationToken: z
      .string()
      .optional()
      .describe(
        'Single-use token from the preview response. After the user ' +
          'approves, repeat the exact same call with this token to execute.',
      ),
    confirmed: z
      .boolean()
      .optional()
      .describe(
        'Deprecated — ignored. Confirmation requires the confirmationToken ' +
          'issued by the preview response.',
      ),
  }),
  outputSchema: confirmationResponseSchema.extend({
    relationshipId: z.string().optional(),
  }),
})

// ============================================================================
// transition_item_state - Transition items through workflow states
// ============================================================================

export const transitionItemStateDef = toolDefinition({
  name: 'transition_item_state',
  description: `Transition an item or ECO through workflow states.
For ECOs: Transitions like Draft -> InReview -> Approved -> Released
For regular items: State changes typically require an ECO context.
Validates that the transition is valid from the current state.
Requires user confirmation before transitioning.`,
  inputSchema: z.object({
    itemId: z.string().describe('ID of the item to transition'),
    targetState: z
      .string()
      .describe(
        'Name of the target state (e.g., "InReview", "Approved", "Released")',
      ),
    comments: z
      .string()
      .optional()
      .describe('Optional transition comments/reason'),
    // Confirmation plumbing
    confirmationToken: z
      .string()
      .optional()
      .describe(
        'Single-use token from the preview response. After the user ' +
          'approves, repeat the exact same call with this token to execute.',
      ),
    confirmed: z
      .boolean()
      .optional()
      .describe(
        'Deprecated — ignored. Confirmation requires the confirmationToken ' +
          'issued by the preview response.',
      ),
  }),
  outputSchema: confirmationResponseSchema.extend({
    previousState: z.string().optional(),
    newState: z.string().optional(),
    transitionedAt: z.string().optional(),
  }),
})

// ============================================================================
// create_change_order - Create a new ECO
// ============================================================================

export const createChangeOrderDef = toolDefinition({
  name: 'create_change_order',
  description: `Create a new Engineering Change Order (ECO) for managing changes to released items.
ECOs create isolated branches for making changes that are merged when approved.
Use this when the user needs to modify released items or wants to manage a set of related changes.
The ECO will be created in Draft state with a workflow for approval.
Requires user confirmation before creating.`,
  inputSchema: z.object({
    name: z.string().describe('ECO title/description'),
    changeType: changeOrderTypeSchema.describe(
      describeEnum('Type of change order', changeOrderTypeSchema.options),
    ),
    priority: changeOrderPrioritySchema
      .default('medium')
      .describe(
        describeEnum('Priority level', changeOrderPrioritySchema.options),
      ),
    reasonForChange: z
      .string()
      .optional()
      .describe('Why this change is needed'),
    impactDescription: z
      .string()
      .optional()
      .describe('Description of expected impact'),
    // Items to initially affect
    affectedItemIds: z
      .array(z.string())
      .optional()
      .describe('Item IDs to add as affected items'),
    // Designs to associate
    designIds: z
      .array(z.string())
      .optional()
      .describe('Design IDs or codes to associate with the ECO'),
    // Confirmation plumbing
    confirmationToken: z
      .string()
      .optional()
      .describe(
        'Single-use token from the preview response. After the user ' +
          'approves, repeat the exact same call with this token to execute.',
      ),
    confirmed: z
      .boolean()
      .optional()
      .describe(
        'Deprecated — ignored. Confirmation requires the confirmationToken ' +
          'issued by the preview response.',
      ),
  }),
  outputSchema: confirmationResponseSchema.extend({
    changeOrderId: z.string().optional(),
    branchIds: z.array(z.string()).optional(),
    affectedItemsAdded: z.number().optional(),
  }),
})

// ============================================================================
// create_program - Create a new program
// ============================================================================

export const createProgramDef = toolDefinition({
  name: 'create_program',
  description: `Create a new program. Programs are the top-level containers and permission boundaries for designs and items.
Use this when the user wants to start work that doesn't fit any existing program — for example, kicking off a collaborative design session when none of their programs are a good match.
The requesting user automatically becomes the program's admin. Requires the 'programs: create' permission — the tool returns a permission error if the user lacks it.
Requires user confirmation before creating.`,
  inputSchema: z.object({
    name: z.string().describe('Program name (e.g., "Drone Platform")'),
    code: z
      .string()
      .optional()
      .describe(
        'Program code — uppercase alphanumeric with hyphens (e.g., "DRONE-X"). Auto-generated from the name if omitted.',
      ),
    description: z.string().optional().describe('Program description'),
    customer: z.string().optional().describe('Customer name, if any'),
    // Confirmation plumbing
    confirmationToken: z
      .string()
      .optional()
      .describe(
        'Single-use token from the preview response. After the user ' +
          'approves, repeat the exact same call with this token to execute.',
      ),
    confirmed: z
      .boolean()
      .optional()
      .describe(
        'Deprecated — ignored. Confirmation requires the confirmationToken ' +
          'issued by the preview response.',
      ),
  }),
  outputSchema: confirmationResponseSchema.extend({
    programId: z.string().optional(),
    programCode: z.string().optional(),
    programName: z.string().optional(),
  }),
})

// ============================================================================
// Export all write definitions
// ============================================================================

export const allWriteToolDefinitions = [
  createItemDef,
  updateItemDef,
  createRelationshipDef,
  transitionItemStateDef,
  createChangeOrderDef,
  createProgramDef,
]

// Export type helpers for handlers
export type CreateItemInput = z.infer<typeof createItemDef.inputSchema>
export type UpdateItemInput = z.infer<typeof updateItemDef.inputSchema>
export type CreateRelationshipInput = z.infer<
  typeof createRelationshipDef.inputSchema
>
export type TransitionItemStateInput = z.infer<
  typeof transitionItemStateDef.inputSchema
>
export type CreateChangeOrderInput = z.infer<
  typeof createChangeOrderDef.inputSchema
>
export type CreateProgramInput = z.infer<typeof createProgramDef.inputSchema>

// Export confirmation response type
export type WriteToolResponse = z.infer<typeof confirmationResponseSchema>
