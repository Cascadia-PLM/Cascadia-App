import { Hono } from 'hono'
import { adapt } from '../adapter'
import type { SysMLElement } from '@/lib/sysml'
import type { VersionContext } from '@/lib/services/VersionResolver'
import { DesignService } from '@/lib/services/DesignService'
import { BranchService } from '@/lib/services/BranchService'
import { CommitService } from '@/lib/services/CommitService'
import { ItemService } from '@/lib/items/services/ItemService'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import { NotFoundError, PermissionDeniedError } from '@/lib/errors'
import { SysMLSerializer } from '@/lib/sysml'
import { requireDesignAccess } from '@/lib/auth/access'
import { apiHandler, created } from '@/lib/api/handler'
// Register item types
import '@/lib/items/registerItemTypes.server'

const app = new Hono()

// GET /api/sysml/projects
app.get(
  '/projects',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const url = new URL(request.url)
      // Accept both limit/offset (standard) and pageSize/pageStart (SysML) for backwards compatibility
      const pageSize = parseInt(
        url.searchParams.get('limit') ||
          url.searchParams.get('pageSize') ||
          '100',
        10,
      )
      const pageStart = parseInt(
        url.searchParams.get('offset') ||
          url.searchParams.get('pageStart') ||
          '0',
        10,
      )

      // Get designs accessible to this user
      const allDesigns = await AccessControlService.getAccessibleDesigns(
        user.id,
      )

      // Apply pagination
      const designs = allDesigns.slice(pageStart, pageStart + pageSize)

      // Convert to SysML Project format
      const projectPromises = designs.map(async (design) => {
        const defaultBranch = await DesignService.getDefaultBranch(design.id)
        return SysMLSerializer.designToProject(design, defaultBranch)
      })

      const projects = await Promise.all(projectPromises)

      // Return raw Response to preserve SysML-specific envelope format
       
      return new Response(
        JSON.stringify({
          data: projects,
          '@type': 'ProjectCollection',
          pageSize,
          pageStart,
          totalResults: allDesigns.length,
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }),
  ),
)

// GET /api/sysml/projects/:id
app.get(
  '/projects/:id',
  adapt(
    apiHandler({}, async ({ params, user }) => {
      const design = await DesignService.getById(params.id)
      if (!design) {
        throw new NotFoundError('Project', params.id)
      }

      // Check access via design access control
      await requireDesignAccess(user.id, design.id)

      // Get default branch for the project
      const defaultBranch = await DesignService.getDefaultBranch(design.id)

      // Convert to SysML Project format
      const project = SysMLSerializer.designToProject(design, defaultBranch)

      return project
    }),
  ),
)

// POST /api/sysml/projects/:id/branches/:bid/elements
app.post(
  '/projects/:id/branches/:bid/elements',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      // Validate project exists
      const design = await DesignService.getById(params.id)
      if (!design) {
        throw new NotFoundError('Project', params.id)
      }

      // Check access to this design
      await requireDesignAccess(user.id, design.id)

      // Validate branch exists and belongs to design
      const branch = await BranchService.getById(params.bid)
      if (!branch || branch.designId !== params.id) {
        throw new NotFoundError('Branch', params.bid)
      }

      // Check if branch is locked
      if (branch.isLocked) {
        throw new PermissionDeniedError('branch', 'create')
      }

      // Parse SysML Element from request body
      const element: SysMLElement = await request.json()

      // Convert SysML Element to Cascadia item
      const itemData = SysMLSerializer.elementToItem(element, params.id)

      // Create item on branch
      // Cast to BaseItem to allow SysML-specific fields (sysmlType, metamodel, attributes)
      // which are stored in the items table but not in the BaseItem interface
      const result = await ItemService.createOnBranch(
        itemData.itemType,
        {
          itemNumber: itemData.itemNumber,
          name: itemData.name,
          itemType: itemData.itemType,
          state: 'Draft',
          revision: '-',
          sysmlType: itemData.sysmlType,
          metamodel: itemData.metamodel,
          attributes: itemData.attributes,
        } as Parameters<typeof ItemService.createOnBranch>[1],
        params.bid,
        `Created ${itemData.name || itemData.itemNumber} via SysML API`,
        user.id,
      )

      // Convert back to SysML Element format
      // result.item has id assigned after creation, so safe to cast
      const createdElement = SysMLSerializer.itemToElement(
        result.item as Parameters<typeof SysMLSerializer.itemToElement>[0],
        [],
        design.code,
      )

      return created(createdElement)
    }),
  ),
)

// GET /api/sysml/projects/:id/commits
app.get(
  '/projects/:id/commits',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const url = new URL(request.url)
      const branchId = url.searchParams.get('branchId')
      const pageSize = parseInt(url.searchParams.get('pageSize') || '100', 10)
      const pageStart = parseInt(url.searchParams.get('pageStart') || '0', 10)

      // Validate project exists
      const design = await DesignService.getById(params.id)
      if (!design) {
        throw new NotFoundError('Project', params.id)
      }

      // Check access via design access control
      await requireDesignAccess(user.id, design.id)

      // Get branch - either specified or default
      const branch = branchId
        ? await BranchService.getById(branchId)
        : await DesignService.getDefaultBranch(params.id)

      if (!branch) {
        throw new NotFoundError('Branch', branchId || 'default')
      }

      // Get commits for the branch
      const commits = await CommitService.getByBranch(branch.id, {
        limit: pageSize,
        offset: pageStart,
      })

      // Get changes for each commit and convert to SysML format
      const sysmlCommits = await Promise.all(
        commits.map(async (commit) => {
          const diff = await CommitService.getDiff(commit.id)
          const changes = diff?.items.map((item) => ({
            itemId: item.itemId,
            changeType: item.changeType,
          }))
          return SysMLSerializer.commitToSysML(commit, changes)
        }),
      )

      // Return raw Response to preserve SysML-specific envelope format
       
      return new Response(
        JSON.stringify({
          data: sysmlCommits,
          '@type': 'CommitCollection',
          pageSize,
          pageStart,
          totalResults: sysmlCommits.length,
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }),
  ),
)

// GET /api/sysml/projects/:id/commits/:cid/elements
app.get(
  '/projects/:id/commits/:cid/elements',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const url = new URL(request.url)
      const pageSize = parseInt(url.searchParams.get('pageSize') || '100', 10)
      const pageStart = parseInt(url.searchParams.get('pageStart') || '0', 10)

      // Validate project exists
      const design = await DesignService.getById(params.id)
      if (!design) {
        throw new NotFoundError('Project', params.id)
      }

      // Check access via design access control
      await requireDesignAccess(user.id, design.id)

      // Validate commit exists and belongs to design
      const commit = await CommitService.getById(params.cid)
      if (!commit || commit.designId !== params.id) {
        throw new NotFoundError('Commit', params.cid)
      }

      // Define version context for this commit
      const context: VersionContext = {
        type: 'commit',
        commitId: params.cid,
      }

      // Get items at this commit
      const result = await ItemService.listAtContext(params.id, context, {
        limit: pageSize,
        offset: pageStart,
      })

      // Convert to SysML Element format with relationships
      const elements = await Promise.all(
        result.items.map(async (item) => {
          const relationships = await ItemService.getRelationshipsWithDetails(
            item.id!,
          )
          // Map relationships to Cascadia format for serializer
          const mappedRels = relationships.map((rel) => ({
            id: rel.id,
            sourceId: rel.sourceId,
            targetId: rel.targetId,
            relationshipType: rel.relationshipType,
            quantity: rel.quantity ?? undefined,
            isComposite: rel.isComposite ?? undefined,
            isDirected: rel.isDirected ?? undefined,
            multiplicityLower: rel.multiplicityLower ?? undefined,
            multiplicityUpper: rel.multiplicityUpper ?? undefined,
            metadata: rel.metadata as Record<string, unknown> | undefined,
          }))
          // item has id assigned when retrieved from context, so safe to cast
          return SysMLSerializer.itemToElement(
            item as Parameters<typeof SysMLSerializer.itemToElement>[0],
            mappedRels,
            design.code,
          )
        }),
      )

      // Return raw Response to preserve SysML-specific envelope format
       
      return new Response(
        JSON.stringify({
          data: elements,
          '@type': 'ElementCollection',
          pageSize,
          pageStart,
          totalResults: result.total,
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }),
  ),
)

export default app
