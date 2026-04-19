/**
 * TestDataBuilder - Fluent API for building complex test scenarios
 *
 * Provides a chainable interface for creating test data with dependencies.
 *
 * @example
 * ```typescript
 * import { TestDataBuilder } from '@test/fixtures/builder'
 *
 * const builder = new TestDataBuilder(db)
 *
 * // Build a complete test scenario
 * const scenario = await builder
 *   .withUser({ email: 'admin@acme.com' }, 'Administrator')
 *   .withDesign({ name: 'Test Design', code: 'PROD-001' })
 *   .withPart({ name: 'Assembly' })
 *   .withPart({ name: 'Component 1' })
 *   .withBOM('Assembly', 'Component 1', { quantity: 2 })
 *   .build()
 *
 * // Access built data
 * console.log(scenario.users['admin@acme.com'].id)
 * console.log(scenario.parts['Assembly'].item.id)
 * ```
 */

import { eq } from 'drizzle-orm'
import {
  insertTestSession,
  insertTestUser,
  insertTestUserWithRole,
} from './users'
import {
  createBOMRelationship,
  createReferenceRelationship,
  insertTestChangeOrder,
  insertTestDocument,
  insertTestPart,
  insertTestRequirement,
  insertTestTask,
} from './items'
import type {
  CreateTestUserInput,
  TestRole,
  TestSession,
  TestUser,
} from './users'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '@/lib/db/schema'
import type { RoleName } from '@/lib/auth/permissions'
import type {
  CreateChangeOrderInput,
  CreateDocumentInput,
  CreatePartInput,
  CreateRequirementInput,
  CreateTaskInput,
  TestBaseItem,
  TestChangeOrder,
  TestDocument,
  TestPart,
  TestRelationship,
  TestRequirement,
  TestTask,
} from './items'
import { branches, commits, designs } from '@/lib/db/schema'

type DbSchema = typeof schema
type TestDbInstance = PostgresJsDatabase<DbSchema>

/**
 * Test design data
 */
export interface TestDesign {
  id: string
  name: string
  code: string
  programId: string | null
  description: string | null
  designType: string
  defaultBranchId: string | null
  createdBy: string
  createdAt: Date
}

/**
 * Built test data structure
 */
export interface BuiltTestData {
  users: Record<string, TestUser>
  roles: Record<string, TestRole>
  sessions: Record<string, TestSession>
  designs: Record<string, TestDesign>
  parts: Record<string, { item: TestBaseItem; part: TestPart }>
  documents: Record<string, { item: TestBaseItem; document: TestDocument }>
  changeOrders: Record<
    string,
    { item: TestBaseItem; changeOrder: TestChangeOrder }
  >
  requirements: Record<
    string,
    { item: TestBaseItem; requirement: TestRequirement }
  >
  tasks: Record<string, { item: TestBaseItem; task: TestTask }>
  relationships: Array<TestRelationship>
}

type PendingAction = () => Promise<void>

/**
 * Input for creating test designs
 */
export interface CreateTestDesignInput {
  id?: string
  name?: string
  code?: string
  programId?: string | null
  description?: string
  designType?: 'Engineering' | 'Library'
}

/**
 * Fluent builder for creating complex test scenarios
 */
export class TestDataBuilder {
  private db: TestDbInstance
  private pendingActions: Array<PendingAction> = []
  private data: BuiltTestData = {
    users: {},
    roles: {},
    sessions: {},
    designs: {},
    parts: {},
    documents: {},
    changeOrders: {},
    requirements: {},
    tasks: {},
    relationships: [],
  }

  private defaultUserId: string | null = null
  private defaultDesignId: string | null = null

  constructor(db: TestDbInstance) {
    this.db = db
  }

  /**
   * Create a user with optional role
   *
   * @param input - User data
   * @param role - Optional role name to assign
   * @param key - Optional key to reference this user (defaults to email)
   */
  withUser(
    input: CreateTestUserInput = {},
    role?: RoleName,
    key?: string,
  ): this {
    this.pendingActions.push(async () => {
      let user: TestUser
      let roleData: TestRole | undefined

      if (role) {
        const result = await insertTestUserWithRole(this.db, role, input)
        user = result.user
        roleData = result.role
        this.data.roles[role] = roleData
      } else {
        user = await insertTestUser(this.db, input)
      }

      const userKey = key ?? user.email
      this.data.users[userKey] = user

      // Set first user as default
      if (!this.defaultUserId) {
        this.defaultUserId = user.id
      }
    })
    return this
  }

  /**
   * Create a session for a user
   *
   * @param userKey - Key of the user (email by default)
   * @param sessionKey - Optional key to reference this session
   */
  withSession(userKey: string, sessionKey?: string): this {
    this.pendingActions.push(async () => {
      const user = this.data.users[userKey] as
        | (typeof this.data.users)[string]
        | undefined
      if (!user) {
        throw new Error(`User "${userKey}" not found. Create user first.`)
      }

      const session = await insertTestSession(this.db, user.id)
      this.data.sessions[sessionKey ?? userKey] = session
    })
    return this
  }

  /**
   * Create a design (version container for items)
   *
   * @param input - Design data
   * @param key - Key to reference this design (defaults to code)
   */
  withDesign(input: CreateTestDesignInput = {}, key?: string): this {
    this.pendingActions.push(async () => {
      this.ensureUser()

      const designId = input.id ?? crypto.randomUUID()
      const code = input.code ?? `PROD-${Date.now()}`

      // Create the design
      const [created] = await this.db
        .insert(designs)
        .values({
          id: designId,
          programId: input.programId ?? null,
          name: input.name ?? 'Test Design',
          code,
          description: input.description ?? null,
          designType: input.designType ?? 'Engineering',
          createdBy: this.defaultUserId!,
        })
        .returning()

      // Create initial commit
      const [initialCommit] = await this.db
        .insert(commits)
        .values({
          designId: created.id,
          branchId: created.id, // Temporary
          message: 'Initial commit',
          createdBy: this.defaultUserId!,
        })
        .returning()

      // Create main branch
      const [mainBranch] = await this.db
        .insert(branches)
        .values({
          designId: created.id,
          name: 'main',
          branchType: 'main',
          headCommitId: initialCommit.id,
          baseCommitId: initialCommit.id,
          createdBy: this.defaultUserId!,
        })
        .returning()

      // Update commit with correct branchId
      await this.db
        .update(commits)
        .set({ branchId: mainBranch.id })
        .where(eq(commits.id, initialCommit.id))

      // Update design with default branch
      const [updated] = await this.db
        .update(designs)
        .set({ defaultBranchId: mainBranch.id })
        .where(eq(designs.id, created.id))
        .returning()

      const designKey = key ?? code
      this.data.designs[designKey] = {
        ...updated,
        createdAt: updated.createdAt,
      }

      // Set first design as default
      if (!this.defaultDesignId) {
        this.defaultDesignId = updated.id
      }
    })
    return this
  }

  /**
   * Create a part
   *
   * @param input - Part data
   * @param key - Key to reference this part (defaults to name)
   * @param designKey - Optional design key to use (defaults to first design)
   */
  withPart(
    input: CreatePartInput = {},
    key?: string,
    designKey?: string,
  ): this {
    this.pendingActions.push(async () => {
      this.ensureUser()

      const designId = designKey
        ? ((
            this.data.designs[designKey] as
              | (typeof this.data.designs)[string]
              | undefined
          )?.id ?? null)
        : this.defaultDesignId

      const result = await insertTestPart(
        this.db,
        designId,
        this.defaultUserId!,
        input,
      )

      const partKey = key ?? result.item.name ?? result.item.itemNumber
      this.data.parts[partKey] = result
    })
    return this
  }

  /**
   * Create a document
   *
   * @param input - Document data
   * @param key - Key to reference this document
   * @param designKey - Optional design key to use (defaults to first design)
   */
  withDocument(
    input: CreateDocumentInput = {},
    key?: string,
    designKey?: string,
  ): this {
    this.pendingActions.push(async () => {
      this.ensureUser()

      const designId = designKey
        ? ((
            this.data.designs[designKey] as
              | (typeof this.data.designs)[string]
              | undefined
          )?.id ?? null)
        : this.defaultDesignId

      const result = await insertTestDocument(
        this.db,
        designId,
        this.defaultUserId!,
        input,
      )

      const docKey = key ?? result.item.name ?? result.item.itemNumber
      this.data.documents[docKey] = result
    })
    return this
  }

  /**
   * Create a change order
   *
   * @param input - Change order data
   * @param key - Key to reference this change order
   * @param designKey - Optional design key to use (defaults to first design)
   */
  withChangeOrder(
    input: CreateChangeOrderInput = {},
    key?: string,
    designKey?: string,
  ): this {
    this.pendingActions.push(async () => {
      this.ensureUser()

      const designId = designKey
        ? ((
            this.data.designs[designKey] as
              | (typeof this.data.designs)[string]
              | undefined
          )?.id ?? null)
        : this.defaultDesignId

      const result = await insertTestChangeOrder(
        this.db,
        designId,
        this.defaultUserId!,
        input,
      )

      const coKey = key ?? result.item.name ?? result.item.itemNumber
      this.data.changeOrders[coKey] = result
    })
    return this
  }

  /**
   * Create a requirement
   *
   * @param input - Requirement data
   * @param key - Key to reference this requirement
   * @param designKey - Optional design key to use (defaults to first design)
   */
  withRequirement(
    input: CreateRequirementInput = {},
    key?: string,
    designKey?: string,
  ): this {
    this.pendingActions.push(async () => {
      this.ensureUser()

      const designId = designKey
        ? ((
            this.data.designs[designKey] as
              | (typeof this.data.designs)[string]
              | undefined
          )?.id ?? null)
        : this.defaultDesignId

      const result = await insertTestRequirement(
        this.db,
        designId,
        this.defaultUserId!,
        input,
      )

      const reqKey = key ?? result.item.name ?? result.item.itemNumber
      this.data.requirements[reqKey] = result
    })
    return this
  }

  /**
   * Create a task
   *
   * @param input - Task data
   * @param key - Key to reference this task
   */
  withTask(input: CreateTaskInput = {}, key?: string): this {
    this.pendingActions.push(async () => {
      this.ensureUser()

      const result = await insertTestTask(this.db, this.defaultUserId!, input)

      const taskKey = key ?? result.item.name ?? result.item.itemNumber
      this.data.tasks[taskKey] = result
    })
    return this
  }

  /**
   * Create a BOM relationship between two parts
   *
   * @param parentKey - Key of the parent part
   * @param childKey - Key of the child part
   * @param options - Relationship options (quantity, findNumber)
   */
  withBOM(
    parentKey: string,
    childKey: string,
    options: { quantity?: number; findNumber?: number } = {},
  ): this {
    this.pendingActions.push(async () => {
      const parent = this.data.parts[parentKey] as
        | (typeof this.data.parts)[string]
        | undefined
      const child = this.data.parts[childKey] as
        | (typeof this.data.parts)[string]
        | undefined

      if (!parent) {
        throw new Error(`Parent part "${parentKey}" not found.`)
      }
      if (!child) {
        throw new Error(`Child part "${childKey}" not found.`)
      }

      const relationship = await createBOMRelationship(
        this.db,
        parent.item.id,
        child.item.id,
        this.defaultUserId!,
        options,
      )

      this.data.relationships.push(relationship)
    })
    return this
  }

  /**
   * Create a reference relationship
   *
   * @param sourceKey - Key of the source item
   * @param targetKey - Key of the target item
   * @param sourceType - Type of source ('part' | 'document' | etc.)
   * @param targetType - Type of target
   */
  withReference(
    sourceKey: string,
    targetKey: string,
    sourceType: 'part' | 'document' = 'document',
    targetType: 'part' | 'document' = 'part',
  ): this {
    this.pendingActions.push(async () => {
      const source =
        sourceType === 'part'
          ? (this.data.parts[sourceKey] as
              | (typeof this.data.parts)[string]
              | undefined)
          : (this.data.documents[sourceKey] as
              | (typeof this.data.documents)[string]
              | undefined)

      const target =
        targetType === 'part'
          ? (this.data.parts[targetKey] as
              | (typeof this.data.parts)[string]
              | undefined)
          : (this.data.documents[targetKey] as
              | (typeof this.data.documents)[string]
              | undefined)

      if (!source) {
        throw new Error(`Source ${sourceType} "${sourceKey}" not found.`)
      }
      if (!target) {
        throw new Error(`Target ${targetType} "${targetKey}" not found.`)
      }

      const relationship = await createReferenceRelationship(
        this.db,
        source.item.id,
        target.item.id,
        this.defaultUserId!,
      )

      this.data.relationships.push(relationship)
    })
    return this
  }

  /**
   * Build all pending test data
   *
   * @returns The built test data structure
   */
  async build(): Promise<BuiltTestData> {
    for (const action of this.pendingActions) {
      await action()
    }
    return this.data
  }

  /**
   * Helper to ensure user exists
   */
  private ensureUser(): void {
    if (!this.defaultUserId) {
      throw new Error('Must create at least one user first. Call withUser().')
    }
  }
}

/**
 * Shorthand function to create a builder
 */
export function testData(db: TestDbInstance): TestDataBuilder {
  return new TestDataBuilder(db)
}

/**
 * Create a minimal test scenario with user and basic items
 * Useful for tests that just need some data to work with
 */
export async function createMinimalTestScenario(
  db: TestDbInstance,
): Promise<BuiltTestData> {
  return testData(db)
    .withUser(
      { name: 'Test User', email: `test-${Date.now()}@example.com` },
      'Administrator',
    )
    .withDesign({ name: 'Test Design', code: `PROD-${Date.now()}` })
    .withPart({ name: 'Test Part' })
    .build()
}
