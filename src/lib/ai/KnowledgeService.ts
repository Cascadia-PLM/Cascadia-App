/**
 * KnowledgeService - Schema Intelligence for AI
 *
 * This service provides schema-aware context for the AI chatbot by:
 * - Reflecting on ItemTypeRegistry to get item type definitions
 * - Extracting field definitions from Zod schemas
 * - Building dynamic system prompts with schema context
 * - Including user context (roles, current program/design)
 */

import { zodToJsonSchema } from 'zod-to-json-schema'
import type { z } from 'zod'

import type {
  ItemTypeConfig,
  RelationshipConfig,
  StateConfig,
} from '@/lib/items/types/base'
import { ItemTypeRegistry } from '@/lib/items/registry'
import { aiLogger } from '@/lib/logging/logger'

// Field definition extracted from Zod schema
export interface FieldDefinition {
  name: string
  type: string
  description?: string
  required: boolean
  enum?: Array<string>
}

// Item type description for AI context
export interface ItemTypeDescription {
  name: string
  label: string
  pluralLabel: string
  icon: string
  fields: Array<FieldDefinition>
  relationships: Array<RelationshipConfig>
  states: Array<StateConfig>
  permissions: {
    create: Array<string>
    read: Array<string>
    update: Array<string>
    delete: Array<string>
  }
  searchableFields: Array<string>
  displayField: string
}

// Versioning model description
export interface VersioningDescription {
  model: 'ECO-as-Branch'
  description: string
  concepts: Array<{ term: string; definition: string }>
}

// Program context for AI
export interface ProgramContext {
  id: string
  name: string
  code: string
  status: string
}

// Design context for AI
export interface DesignContext {
  id: string
  name: string
  code: string
}

// Full schema context for AI
export interface SchemaContext {
  itemTypes: Array<ItemTypeDescription>
  globalRelationships: Array<RelationshipConfig>
  versioningModel: VersioningDescription
  programContext: ProgramContext | null
  designContext: DesignContext | null
}

// User context for AI
export interface UserContext {
  id: string
  username: string
  email: string
  roles: Array<string>
}

// Full context for building system prompt
export interface SystemPromptContext {
  schemaContext: SchemaContext
  user: UserContext
  programName?: string
  designName?: string
}

/**
 * KnowledgeService provides schema introspection and context building for AI
 */
export class KnowledgeService {
  /**
   * Generate schema context for LLM system prompt.
   * Returns description of all item types, fields, and relationships.
   */
  async generateSchemaContext(
    programId?: string,
    designId?: string,
  ): Promise<SchemaContext> {
    // Ensure ItemTypeRegistry is initialized
    await ItemTypeRegistry.initialize()

    const itemTypes = ItemTypeRegistry.getAllTypes()

    const itemTypeDescriptions: Array<ItemTypeDescription> = await Promise.all(
      itemTypes.map(async (type) => {
        const fields = this.extractFields(type.schema)
        const states = await ItemTypeRegistry.getStatesForType(type.name)

        return {
          name: type.name,
          label: type.label,
          pluralLabel: type.pluralLabel,
          icon: type.icon,
          fields,
          relationships: type.relationships || [],
          states,
          permissions: type.permissions,
          searchableFields: type.searchableFields,
          displayField: type.displayField,
        }
      }),
    )

    return {
      itemTypes: itemTypeDescriptions,
      globalRelationships: this.getGlobalRelationships(),
      versioningModel: this.getVersioningModel(),
      programContext: programId
        ? await this.getProgramContext(programId)
        : null,
      designContext: designId ? await this.getDesignContext(designId) : null,
    }
  }

  /**
   * Extract field definitions from a Zod schema using JSON Schema conversion
   */
  private extractFields(schema: z.ZodSchema): Array<FieldDefinition> {
    try {
      const jsonSchema = zodToJsonSchema(schema, {
        $refStrategy: 'none',
        target: 'openApi3',
      }) as {
        properties?: Record<string, any>
        required?: Array<string>
      }

      if (!jsonSchema.properties) {
        return []
      }

      const required = jsonSchema.required || []

      return Object.entries(jsonSchema.properties).map(([name, def]) => ({
        name,
        type: this.normalizeType(def.type, def),
        description: def.description,
        required: required.includes(name),
        enum: def.enum,
      }))
    } catch (error) {
      aiLogger.error({ err: error }, 'Error extracting fields')
      return []
    }
  }

  /**
   * Normalize JSON Schema type to a human-readable format
   */
  private normalizeType(type: string | Array<string>, def: any): string {
    if (Array.isArray(type)) {
      // Filter out 'null' and join with |
      return type.filter((t) => t !== 'null').join(' | ')
    }

    // Handle special formats
    if (def.format === 'uuid') return 'uuid'
    if (def.format === 'date-time') return 'datetime'
    if (def.format === 'email') return 'email'

    return type || 'unknown'
  }

  /**
   * Get global relationship types used across the system
   */
  private getGlobalRelationships(): Array<RelationshipConfig> {
    return [
      {
        type: 'bom',
        label: 'Bill of Materials',
        targetTypes: ['Part'],
        allowMultiple: true,
      },
      {
        type: 'affected',
        label: 'Affected Items',
        targetTypes: ['Part', 'Document', 'Requirement'],
        allowMultiple: true,
      },
      {
        type: 'reference',
        label: 'Reference',
        targetTypes: ['Part', 'Document', 'Requirement', 'Task'],
        allowMultiple: true,
      },
    ]
  }

  /**
   * Get versioning model description
   */
  private getVersioningModel(): VersioningDescription {
    return {
      model: 'ECO-as-Branch',
      description:
        'Cascadia uses a Git-style versioning model where each Engineering Change Order (ECO) creates an isolated branch for parallel development. Changes are merged to main when the ECO is released.',
      concepts: [
        {
          term: 'main branch',
          definition:
            'The released baseline containing all approved item revisions',
        },
        {
          term: 'ECO branch',
          definition:
            'An isolated workspace for making changes to items under a specific change order',
        },
        {
          term: 'revision',
          definition:
            'A letter (A, B, C...) assigned when changes are merged to main',
        },
        {
          term: 'checkout',
          definition:
            'Copying an item from main to an ECO branch for modification',
        },
        {
          term: 'commit',
          definition: 'Saving changes within an ECO branch',
        },
        {
          term: 'release',
          definition:
            'Merging ECO branch changes to main, assigning new revision letters',
        },
      ],
    }
  }

  /**
   * Get program context from database
   */
  private async getProgramContext(
    programId: string,
  ): Promise<ProgramContext | null> {
    try {
      // Lazy import to avoid bundling database code in client
      const { db } = await import('@/lib/db')
      const { programs } = await import('@/lib/db/schema')
      const { eq } = await import('drizzle-orm')

      const program = await db.query.programs.findFirst({
        where: eq(programs.id, programId),
      })

      if (!program) return null

      return {
        id: program.id,
        name: program.name,
        code: program.code,
        status: program.status,
      }
    } catch (error) {
      aiLogger.error({ err: error }, 'Error fetching program context')
      return null
    }
  }

  /**
   * Get design context from database
   */
  private async getDesignContext(
    designId: string,
  ): Promise<DesignContext | null> {
    try {
      // Lazy import to avoid bundling database code in client
      const { db } = await import('@/lib/db')
      const { designs } = await import('@/lib/db/schema')
      const { eq } = await import('drizzle-orm')

      const design = await db.query.designs.findFirst({
        where: eq(designs.id, designId),
      })

      if (!design) return null

      return {
        id: design.id,
        name: design.name,
        code: design.code,
      }
    } catch (error) {
      aiLogger.error({ err: error }, 'Error fetching design context')
      return null
    }
  }

  /**
   * Build the system prompt with schema context
   */
  buildSystemPrompt(context: SystemPromptContext): string {
    const { schemaContext, user, programName, designName } = context

    // Build item types summary
    const itemTypesSummary = schemaContext.itemTypes
      .map((type) => {
        const fieldList = type.fields
          .filter((f) => f.required || f.name === type.displayField)
          .slice(0, 5)
          .map((f) => `${f.name} (${f.type})`)
          .join(', ')

        const stateList = type.states.map((s) => s.name).join(', ')

        return `- **${type.label}** (${type.name}): ${fieldList}
  States: ${stateList || 'Draft, In Review, Approved, Released, Obsolete'}`
      })
      .join('\n')

    // Build versioning concepts
    const versioningConcepts = schemaContext.versioningModel.concepts
      .map((c) => `- **${c.term}**: ${c.definition}`)
      .join('\n')

    return `You are an AI assistant for Cascadia PLM, a code-first product lifecycle management system.

## Your Role
You help users navigate, query, and modify their PLM data. You can search for items, view details, analyze impact, and also create items, update properties, manage relationships, transition workflow states, and create change orders. You understand the schema and can take action on behalf of the user.

## Current Context
- **User**: ${user.username} (${user.email})
- **Roles**: ${user.roles.join(', ') || 'No roles assigned'}
- **Program**: ${programName || 'Not selected'}
- **Design**: ${designName || 'Not selected'}

## Available Item Types
${itemTypesSummary}

## Versioning Model: ${schemaContext.versioningModel.model}
${schemaContext.versioningModel.description}

Key concepts:
${versioningConcepts}

## Your Capabilities

### Read Tools (query PLM data)

1. **search_items** - Search for items by type, query text, state, or design
   - Use when the user asks to find items or wants to see a list
   - Supports filtering by itemType (Part, Document, ChangeOrder, Requirement, Task)

2. **get_item_details** - Get complete details for a specific item
   - Use when the user asks about a specific item by ID or item number
   - Returns all fields including type-specific data

3. **get_bom** - Get Bill of Materials (child components) for a part
   - Use when the user asks what components make up an assembly
   - Returns the BOM hierarchy with quantities and find numbers

4. **get_where_used** - Find parent assemblies that use an item
   - Use when the user asks where a part or component is used
   - Essential for understanding impact before making changes

5. **analyze_change_impact** - Analyze impact of changing an item
   - Use before discussing changes to understand the full scope
   - Returns affected assemblies, documents, related change orders, and risks

6. **offer_navigation** - Offer to navigate the user to an item, design, or program page
   - Use AFTER answering a question to offer helpful navigation
   - Works for all entity types: Parts, Documents, ChangeOrders, Requirements, Tasks, Designs, and Programs
   - Creates a clickable button the user can click to navigate
   - For Programs: use itemId=program.id, itemNumber=program.code, itemType="Program"
   - For Designs: use itemId=design.id, itemNumber=design.code, itemType="Design"
   - Use the tab parameter for context (e.g., "bom" tab for BOM questions, "affected-items" for ECO questions)
   - Keep labels concise (e.g., "View Widget Prototype", "Open Program")
   - Only offer when genuinely helpful - don't spam multiple navigation offers

7. **search_programs** - Search for programs by name, code, customer, or status
   - Use when the user asks about programs or wants to see what programs they have access to
   - Results are automatically scoped to programs the user can access
   - Supports filtering by status (Active, On Hold, Completed, Cancelled)
   - IMPORTANT: After finding a program, always call offer_navigation with itemType="Program" to provide a clickable button

8. **search_designs** - Search for designs by name, code, type, or program
   - Use when the user asks about designs or wants to see designs in a specific program
   - Accepts program ID or program code (e.g., "WIDGET") to filter by program
   - Supports filtering by design type (Engineering, Manufacturing, library, family)
   - Excludes archived designs by default
   - IMPORTANT: After finding a design, always call offer_navigation with itemType="Design" to provide a clickable button

### Write Tools (modify PLM data - require user confirmation)

All write tools use a two-step confirmation flow. When called, they first return a confirmation message for the user to approve before executing. Use these proactively when users ask you to create, update, or manage items.

9. **create_item** - Create a new Part, Document, Requirement, or Task
   - Use when the user asks to create a new item
   - For post-release designs (designs with Released items), requires a changeOrderId
   - If an ECO is needed, the tool will suggest creating one first

10. **update_item** - Update an existing item's properties
   - Use when the user asks to change an item's name, description, material, cost, etc.
   - Released items on main branch require an ECO checkout first

11. **create_relationship** - Create BOM, Document, or Affects relationships between items
   - Use when the user asks to add a component to a BOM, attach a document, or link items

12. **transition_item_state** - Transition items or ECOs through workflow states
    - Use when the user asks to submit, approve, release, or change the state of an item or ECO
    - Validates that the transition is valid from the current state

13. **create_change_order** - Create a new Engineering Change Order (ECO)
    - Use when the user needs to modify released items or manage a set of related changes
    - Creates the ECO with branches for isolated changes that merge when approved

### Design Engine

14. **initiate_collaborative_design** - Start an interactive design workspace
    - Use when the user wants to design something new (a product, assembly, or system) and needs help breaking it down into requirements and a BOM
    - The workspace guides through: requirements gathering → BOM structure → materialization into real PLM items
    - IMPORTANT: You MUST pass the programId (UUID from search_programs) so the session is created in the correct program
    - If the user mentions a program by name or code, call search_programs first to get its UUID, then pass that UUID as programId
    - No confirmation step needed — just call it directly with the description and programId
    - On success, returns a workspace URL — the UI renders an "Open Design Workspace" button automatically

## Guidelines
- Use tools to answer questions and perform actions - don't make up information or claim you can't do things you have tools for
- When the user asks you to create, modify, or manage items, use the appropriate write tool
- When referencing items, use the format: [ItemType ItemNumber-Revision] (e.g., [Part P-1001-A])
- Present tool results clearly, summarizing key findings
- If a tool returns many results, highlight the most relevant ones
- Respect the user's permission context - tools will deny access if unauthorized
- If unsure what tool to use, ask clarifying questions first
- After answering questions about specific items, programs, or designs, ALWAYS call offer_navigation to provide a clickable navigation button. Never describe a button in text without actually calling the tool.
- Match the tab parameter to the context (e.g., use "bom" tab when discussing BOM, "affected-items" for ECO items)
- For write operations, always let the confirmation flow handle user approval - don't ask for confirmation separately in your text response`
  }

  /**
   * Build a concise search-focused system prompt.
   * Used for search mode — instructs the AI to search immediately and return
   * brief structured results with navigation links.
   */
  buildSearchPrompt(context: SystemPromptContext): string {
    const { schemaContext, user, programName, designName } = context

    const typeNames = schemaContext.itemTypes
      .map((t) => `${t.label} (${t.name})`)
      .join(', ')

    return `You are a fast search assistant for Cascadia PLM. Search immediately — never ask clarifying questions.

## Context
- User: ${user.username} | Roles: ${user.roles.join(', ') || 'None'}
- Program: ${programName || 'Not selected'} | Design: ${designName || 'Not selected'}

## Item Types
${typeNames}

## Response Rules
- **Single match**: One-line summary, then call offer_navigation to provide an "Open" button.
- **2–10 matches**: Markdown table with columns: Number (as link), Name, Type, Rev, State. Format number links as [P-1001](/parts/{id}).
- **>10 matches**: Table capped at 10 rows + "Showing 10 of N results" note.
- **No matches**: "No items found matching '…'"
- Keep responses concise. No explanations, no follow-up questions.

## Available Tools
1. search_items — search across item types
2. get_item_details — fetch details for a single match
3. offer_navigation — provide "Open" button for single match
4. search_programs — search programs
5. search_designs — search designs`
  }

  /**
   * Get a concise summary of available item types for quick reference
   */
  async getItemTypesSummary(): Promise<string> {
    await ItemTypeRegistry.initialize()

    const itemTypes = ItemTypeRegistry.getAllTypes()

    return itemTypes
      .map((type) => `${type.label} (${type.name}): ${type.pluralLabel}`)
      .join('\n')
  }
}

// Export singleton instance
export const knowledgeService = new KnowledgeService()
