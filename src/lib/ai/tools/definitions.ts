/**
 * AI Tool Definitions
 *
 * This module defines the read-only tools for the AI chatbot using
 * TanStack AI's toolDefinition() with Zod schemas.
 *
 * Tools:
 * - search_items: Search PLM items by type, query, and filters
 * - get_item_details: Get complete item details by ID or item number
 * - get_bom: Get Bill of Materials (children) for a part
 * - get_where_used: Find parent assemblies that use an item
 * - analyze_change_impact: Analyze impact of changing an item
 * - offer_navigation: Offer clickable navigation to item pages
 * - search_programs: Search programs by name, code, or customer
 * - search_designs: Search designs by name, code, or program
 */

import { toolDefinition } from '@tanstack/ai'
import { z } from 'zod'

// ============================================================================
// search_items - Search PLM items by type, query, and filters
// ============================================================================

export const searchItemsDef = toolDefinition({
  name: 'search_items',
  description: `Search for items in the PLM system by type, text query, or property filters.
Use this to find parts, documents, change orders, requirements, or tasks.
Returns a list of matching items with key fields (id, itemNumber, name, revision, state).
If no itemType is specified, searches across all item types.`,
  inputSchema: z.object({
    itemType: z
      .enum(['Part', 'Document', 'ChangeOrder', 'Requirement', 'Task'])
      .optional()
      .describe('Filter by item type. If not specified, searches all types.'),
    query: z
      .string()
      .optional()
      .describe('Text search across item number and name fields'),
    state: z
      .string()
      .optional()
      .describe('Filter by lifecycle state (e.g., Draft, Released, Approved)'),
    designId: z
      .string()
      .optional()
      .describe(
        'Filter by design ID (UUID) or design code (e.g., "PC-PROTO") to scope search to a specific design',
      ),
    limit: z
      .number()
      .min(1)
      .max(50)
      .default(20)
      .describe('Maximum number of results to return (1-50, default 20)'),
  }),
  outputSchema: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        itemNumber: z.string(),
        name: z.string().nullable(),
        revision: z.string(),
        state: z.string(),
        itemType: z.string(),
        designId: z.string().nullable(),
      }),
    ),
    total: z.number().describe('Total count of matching items'),
  }),
})

// ============================================================================
// get_item_details - Get complete details for a specific item
// ============================================================================

export const getItemDetailsDef = toolDefinition({
  name: 'get_item_details',
  description: `Get complete details for a specific item by ID or item number.
Returns all fields including type-specific data (e.g., material, cost for Parts).
Provide either id OR (itemNumber and optionally revision).
If revision is omitted when using itemNumber, returns the current revision.`,
  inputSchema: z.object({
    id: z
      .string()
      .optional()
      .describe('Item ID (UUID). Use this if you have the item ID.'),
    itemNumber: z
      .string()
      .optional()
      .describe(
        'Item number (e.g., P-1001). Requires revision or returns current.',
      ),
    revision: z
      .string()
      .optional()
      .describe(
        'Revision letter (e.g., A, B). If omitted, returns current revision.',
      ),
  }),
  outputSchema: z.object({
    id: z.string(),
    masterId: z.string(),
    itemNumber: z.string(),
    name: z.string().nullable(),
    revision: z.string(),
    state: z.string(),
    itemType: z.string(),
    designId: z.string().nullable(),
    createdAt: z.string(),
    createdBy: z.string(),
    modifiedAt: z.string(),
    modifiedBy: z.string(),
    // Type-specific fields are dynamic
    typeSpecificData: z.record(z.string(), z.unknown()).optional(),
  }),
})

// ============================================================================
// get_bom - Get Bill of Materials (children) for a part
// ============================================================================

export const getBomDef = toolDefinition({
  name: 'get_bom',
  description: `Get the Bill of Materials (BOM) for a part, showing child components.
Returns the immediate children by default. Use depth parameter for multi-level BOM.
Only works for Part items - other types don't have BOM relationships.
Each child includes quantity and find number from the BOM relationship.`,
  inputSchema: z.object({
    itemId: z.string().describe('ID of the parent part to get BOM for'),
    depth: z
      .number()
      .min(1)
      .max(10)
      .default(1)
      .describe(
        'How many levels deep to traverse (1=immediate children, max 10)',
      ),
  }),
  outputSchema: z.object({
    parentItemNumber: z.string(),
    parentName: z.string().nullable(),
    children: z.array(
      z.object({
        itemId: z.string(),
        itemNumber: z.string(),
        name: z.string().nullable(),
        revision: z.string(),
        state: z.string(),
        itemType: z.string(),
        quantity: z.number().optional(),
        findNumber: z.number().optional(),
        referenceDesignator: z.string().optional(),
        depth: z
          .number()
          .describe('Level in BOM hierarchy (1=immediate child)'),
        children: z
          .array(z.unknown())
          .optional()
          .describe('Nested children if depth > 1'),
      }),
    ),
    totalComponents: z.number(),
  }),
})

// ============================================================================
// get_where_used - Find parent assemblies that use an item
// ============================================================================

export const getWhereUsedDef = toolDefinition({
  name: 'get_where_used',
  description: `Find all parent assemblies that use a specific item (reverse BOM query).
This is essential for impact analysis - shows where a part or component is used.
Results are ordered by depth (closest parents first).
Includes cross-design references - shows if the item is used in other designs.`,
  inputSchema: z.object({
    itemId: z.string().describe('ID of the item to find usage for'),
    maxDepth: z
      .number()
      .min(1)
      .max(15)
      .default(15)
      .describe('Maximum depth to traverse up the hierarchy (default 15)'),
  }),
  outputSchema: z.object({
    itemNumber: z.string(),
    itemName: z.string().nullable(),
    whereUsed: z.array(
      z.object({
        itemId: z.string(),
        itemNumber: z.string(),
        name: z.string().nullable(),
        revision: z.string(),
        state: z.string(),
        itemType: z.string(),
        depth: z.number().describe('How many levels up from the target item'),
        quantity: z.string().optional(),
        findNumber: z.number().optional(),
        // Cross-design fields
        designId: z.string().nullable(),
        designCode: z.string().nullable(),
        designName: z.string().nullable(),
      }),
    ),
    totalUsages: z.number(),
  }),
})

// ============================================================================
// analyze_change_impact - Analyze impact of changing an item
// ============================================================================

export const analyzeChangeImpactDef = toolDefinition({
  name: 'analyze_change_impact',
  description: `Analyze the impact of changing a specific item.
Shows all affected assemblies, documents, related change orders, and identifies risks.
Use this before making changes to understand the full scope of impact.
Provides risk assessment with severity levels (low, medium, high, critical).`,
  inputSchema: z.object({
    itemId: z.string().describe('ID of the item being changed'),
    includeDocuments: z
      .boolean()
      .default(true)
      .describe('Include related documents in analysis'),
    includeRelatedChanges: z
      .boolean()
      .default(true)
      .describe('Find other active change orders affecting same items'),
  }),
  outputSchema: z.object({
    item: z.object({
      itemNumber: z.string(),
      name: z.string().nullable(),
      revision: z.string(),
      state: z.string(),
    }),
    whereUsedCount: z.number(),
    maxDepthAffected: z.number(),
    affectedAssemblies: z.array(
      z.object({
        itemId: z.string(),
        itemNumber: z.string(),
        name: z.string().nullable(),
        depth: z.number(),
        state: z.string(),
      }),
    ),
    relatedDocuments: z
      .array(
        z.object({
          id: z.string(),
          itemNumber: z.string(),
          name: z.string().nullable(),
        }),
      )
      .optional(),
    relatedChangeOrders: z
      .array(
        z.object({
          id: z.string(),
          itemNumber: z.string(),
          state: z.string(),
        }),
      )
      .optional(),
    risks: z.array(
      z.object({
        severity: z.enum(['low', 'medium', 'high', 'critical']),
        category: z.string(),
        description: z.string(),
      }),
    ),
    riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
  }),
})

// ============================================================================
// offer_navigation - Offer clickable navigation to an item page
// ============================================================================

export const offerNavigationDef = toolDefinition({
  name: 'offer_navigation',
  description: `Offer to navigate the user to a specific item page.
Use AFTER answering a question about an item to offer helpful navigation.
Only offer when genuinely helpful - don't spam offers.
The user will see a clickable button they can click to navigate.`,
  inputSchema: z.object({
    itemId: z.string().describe('The item ID (UUID) to navigate to'),
    itemNumber: z.string().describe('The item number (e.g., P-1001, ECO-0001)'),
    itemName: z
      .string()
      .nullable()
      .optional()
      .describe('The item name, if available'),
    itemType: z
      .enum([
        'Part',
        'Document',
        'ChangeOrder',
        'Requirement',
        'Task',
        'Design',
        'Program',
      ])
      .describe('The type of item to navigate to'),
    tab: z
      .enum(['details', 'relationships', 'history', 'bom', 'affected-items'])
      .optional()
      .describe('Optional tab to open (e.g., bom for BOM-related questions)'),
    label: z
      .string()
      .optional()
      .describe(
        'Custom button label. Defaults to "View [itemNumber]" if not provided.',
      ),
  }),
  outputSchema: z.object({
    navigationUrl: z.string().describe('The URL the button will navigate to'),
    displayed: z.boolean().describe('Whether the navigation button was shown'),
  }),
})

// ============================================================================
// search_programs - Search programs by name, code, or customer
// ============================================================================

export const searchProgramsDef = toolDefinition({
  name: 'search_programs',
  description: `Search for programs in the PLM system by name, code, or customer.
Use this when the user asks about programs, wants to see what programs they have access to,
or is looking for a specific program. Returns a list of matching programs with key fields.
Results are scoped to programs the user has access to.`,
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Text search across program name, code, description, and customer fields. If omitted, lists all accessible programs.',
      ),
    status: z
      .enum(['Active', 'On Hold', 'Completed', 'Cancelled'])
      .optional()
      .describe('Filter by program status'),
    limit: z
      .number()
      .min(1)
      .max(50)
      .default(20)
      .describe('Maximum number of results to return (1-50, default 20)'),
  }),
  outputSchema: z.object({
    programs: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        code: z.string(),
        status: z.string(),
        customer: z.string().nullable(),
        description: z.string().nullable(),
      }),
    ),
    total: z.number().describe('Total count of matching programs'),
  }),
})

// ============================================================================
// search_designs - Search designs by name, code, or program
// ============================================================================

export const searchDesignsDef = toolDefinition({
  name: 'search_designs',
  description: `Search for designs in the PLM system by name, code, or program.
Use this when the user asks about designs, wants to see designs in a program,
or is looking for a specific design. Returns a list of matching designs with key fields.
Results are scoped to designs the user has access to. Excludes archived designs by default.`,
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Text search across design name, code, and description fields. If omitted, lists all accessible designs.',
      ),
    programId: z
      .string()
      .optional()
      .describe(
        'Filter by program ID (UUID) or program code (e.g., "WIDGET") to scope search to a specific program',
      ),
    designType: z
      .enum(['Engineering', 'Manufacturing', 'Library', 'Family'])
      .optional()
      .describe('Filter by design type'),
    limit: z
      .number()
      .min(1)
      .max(50)
      .default(20)
      .describe('Maximum number of results to return (1-50, default 20)'),
  }),
  outputSchema: z.object({
    designs: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        code: z.string(),
        designType: z.string(),
        programId: z.string().nullable(),
        programName: z.string().nullable(),
        description: z.string().nullable(),
      }),
    ),
    total: z.number().describe('Total count of matching designs'),
  }),
})

// ============================================================================
// Export all definitions
// ============================================================================

export const allToolDefinitions = [
  searchItemsDef,
  getItemDetailsDef,
  getBomDef,
  getWhereUsedDef,
  analyzeChangeImpactDef,
  offerNavigationDef,
  searchProgramsDef,
  searchDesignsDef,
]

// Export type helpers for handlers
export type SearchItemsInput = z.infer<typeof searchItemsDef.inputSchema>
export type GetItemDetailsInput = z.infer<typeof getItemDetailsDef.inputSchema>
export type GetBomInput = z.infer<typeof getBomDef.inputSchema>
export type GetWhereUsedInput = z.infer<typeof getWhereUsedDef.inputSchema>
export type AnalyzeChangeImpactInput = z.infer<
  typeof analyzeChangeImpactDef.inputSchema
>
export type OfferNavigationInput = z.infer<
  typeof offerNavigationDef.inputSchema
>
export type SearchProgramsInput = z.infer<typeof searchProgramsDef.inputSchema>
export type SearchDesignsInput = z.infer<typeof searchDesignsDef.inputSchema>
