/**
 * AI Write Tool Definitions
 *
 * This module defines write (mutation) tools for the AI chatbot using
 * TanStack AI's toolDefinition() with Zod schemas.
 *
 * Write operations require user confirmation before execution.
 * The confirmation flow is:
 * 1. Tool is called with confirmed: false (or omitted)
 * 2. Returns requiresConfirmation: true with a message
 * 3. AI presents ConfirmationCard to user
 * 4. User clicks Confirm/Cancel
 * 5. AI calls tool again with confirmed: true
 * 6. Tool executes the operation
 *
 * Tools:
 * - create_item: Create a new item (Part, Document, Requirement, Task)
 * - update_item: Update an existing item's properties
 * - create_relationship: Create BOM or Document relationships
 * - transition_item_state: Transition items through workflow states
 * - create_change_order: Create a new ECO for managing changes
 */

import { toolDefinition } from '@tanstack/ai'
import { z } from 'zod'

// ============================================================================
// Shared Types
// ============================================================================

/**
 * Base confirmation response schema used by all write tools
 */
const confirmationResponseSchema = z.object({
  // When true, operation requires user confirmation
  requiresConfirmation: z.boolean(),
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
For post-release designs (designs with Released items), requires a changeOrderId.
For pre-release designs, items can be created directly.
If changeOrderId is needed but not provided, the tool will suggest creating an ECO first.
Requires user confirmation before creating.`,
  inputSchema: z.object({
    itemType: z
      .enum(['Part', 'Document', 'Requirement', 'Task'])
      .describe('The type of item to create'),
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
    partType: z
      .enum(['Manufacture', 'Purchase', 'Software', 'Phantom'])
      .optional()
      .describe('Part type classification (Parts only)'),
    material: z
      .string()
      .optional()
      .describe('Material specification (Parts only)'),
    // Task-specific fields
    assignee: z
      .string()
      .optional()
      .describe('User ID of assignee (Tasks only)'),
    priority: z
      .enum(['low', 'medium', 'high', 'critical'])
      .optional()
      .describe('Priority level (Tasks only)'),
    dueDate: z
      .string()
      .optional()
      .describe('Due date in ISO format (Tasks only)'),
    // Requirement-specific fields
    requirementType: z
      .enum(['Functional', 'Performance', 'Interface', 'Constraint', 'Other'])
      .optional()
      .describe('Type of requirement (Requirements only)'),
    // Confirmation flag
    confirmed: z
      .boolean()
      .optional()
      .describe('Set to true after user confirms the operation'),
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
    partType: z
      .enum(['Manufacture', 'Purchase', 'Software', 'Phantom'])
      .optional()
      .describe('Part type classification'),
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
    priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    dueDate: z.string().optional().describe('Due date in ISO format'),
    // ECO for checkout if needed
    changeOrderId: z
      .string()
      .optional()
      .describe('ECO ID for checkout if item is Released'),
    // Confirmation flag
    confirmed: z
      .boolean()
      .optional()
      .describe('Set to true after user confirms the operation'),
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
    // Confirmation flag
    confirmed: z
      .boolean()
      .optional()
      .describe('Set to true after user confirms the operation'),
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
    // Confirmation flag
    confirmed: z
      .boolean()
      .optional()
      .describe('Set to true after user confirms the operation'),
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
    changeType: z
      .enum(['ECO', 'ECN', 'Deviation', 'MCO'])
      .describe('Type of change order'),
    priority: z
      .enum(['low', 'medium', 'high', 'critical'])
      .default('medium')
      .describe('Priority level'),
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
    // Confirmation flag
    confirmed: z
      .boolean()
      .optional()
      .describe('Set to true after user confirms the operation'),
  }),
  outputSchema: confirmationResponseSchema.extend({
    changeOrderId: z.string().optional(),
    branchIds: z.array(z.string()).optional(),
    affectedItemsAdded: z.number().optional(),
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

// Export confirmation response type
export type WriteToolResponse = z.infer<typeof confirmationResponseSchema>
