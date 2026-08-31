// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { eq, isNull } from 'drizzle-orm'
import { streamToText } from '@tanstack/ai'
import { tagged } from '../adapter'
import type { ApiKeyPolicy } from '@/lib/auth/api-key-policy-types'
import type { UpdateApiKeyInput } from '@/lib/auth/ApiKeyService'
import type { AIProviderConfig as AIProviderDBConfig } from '@/lib/db/schema/ai'
import type { AIProviderConfig, ProviderType } from '@/lib/ai/adapters'
import { apiHandler, parseQuery } from '@/lib/api/handler'
import { aiProviderTypeSchema, aiSettingsUpdateSchema } from '@/lib/api/schemas'
import { mountRoutes } from '@/lib/api/route-registry'
import { db } from '@/lib/db'
import { aiSettings } from '@/lib/db/schema/ai'
import { ApiKeyService } from '@/lib/auth/ApiKeyService'
import { loadApiKeyPolicy, saveApiKeyPolicy } from '@/lib/auth/api-key-policy'
import {
  DEFAULT_API_KEY_POLICY,
  validateApiKeyPolicy,
} from '@/lib/auth/api-key-policy-types'
import {
  decryptSecret,
  encrypt,
  isEncryptionConfigured,
} from '@/lib/crypto/encryption'
import { getAdapter } from '@/lib/ai/adapters'
import { aiLogger } from '@/lib/logging/logger'
import { AI_PROVIDERS } from '@/lib/ai/model-catalog'
import { listProviderModels } from '@/lib/ai/model-discovery'
import {
  CatalogService,
  catalogBulkImportRowSchema,
  catalogCategoryCreateSchema,
  catalogCategoryUpdateSchema,
  catalogEntryCreateSchema,
  catalogEntryUpdateSchema,
} from '@/lib/services/CatalogService'
import { ConfigService } from '@/lib/config'
import { ItemTypeRegistry } from '@/lib/items/registry'
import { JobService } from '@/lib/jobs/JobService'
import { SettingsService } from '@/lib/config/SettingsService'
import { ThreadCacheService } from '@/lib/services/ThreadCacheService'
import { StorageFactory } from '@/lib/vault/storage/storage-factory'
import { takeFirst } from '@/lib/db/take-first'
import { NotFoundError, ValidationError } from '@/lib/errors'
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Admin')

const app = new Hono()

// =============================================================================
// Request-body schemas. One schema per settings write, superseding the
// interim hand-rolled checks ENV-1 left behind — the same object now
// validates the request and documents it in the OpenAPI spec.
// =============================================================================

/** Body of POST /admin/ai-settings/test. */
const aiSettingsTestSchema = z.object({
  provider: aiProviderTypeSchema,
  apiKey: z.string().optional(),
  model: z.string(),
  baseURL: z.string().optional(),
})

/** Body of POST /admin/item-type-configs. */
const itemTypeConfigBodySchema = z.object({
  itemType: z.string().min(1),
  // Validated structurally by ConfigService against the registered type.
  config: z.record(z.string(), z.unknown()),
})

/** Body of POST /admin/settings. Exactly one of value/jsonValue is required. */
const settingsWriteSchema = z.object({
  key: z.string().min(1),
  value: z.string().optional(),
  jsonValue: z.unknown().optional(),
  description: z.string().max(2000).optional(),
})

/** Body of POST /admin/thread-cache/cleanup. Absent body keeps the defaults. */
const threadCacheCleanupSchema = z
  .object({
    maxAgeDays: z.number().positive().optional(),
    maxInvalidatedAgeHours: z.number().positive().optional(),
  })
  .optional()

/** Body of POST /admin/thread-cache/clear — requires an explicit confirm. */
const threadCacheClearSchema = z
  .object({
    confirm: z.boolean().optional(),
  })
  .optional()

/** Body of POST /admin/thread-cache/warm. */
const threadCacheWarmSchema = z.object({
  itemIds: z.array(z.string()).min(1, 'itemIds array must not be empty'),
  // Optional thread projection options, passed through to the cache warmer.
  request: z.record(z.string(), z.unknown()).optional(),
})

/** Body of PUT /admin/api-key-policy. Semantics via validateApiKeyPolicy. */
const apiKeyPolicySchema = z.object({
  defaultExpirationDays: z.number().nullable().optional(),
  maxExpirationDays: z.number().nullable().optional(),
  requireExpiration: z.boolean().optional(),
})

/** Body of PATCH /admin/api-keys/:keyId — mirrors UpdateApiKeyInput. */
const apiKeyUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  permissions: z.record(z.string(), z.array(z.string())).nullable().optional(),
  roles: z.array(z.string()).nullable().optional(),
})

// ============================================
// AI Settings
// ============================================

// GET /api/admin/ai-settings
app.get(
  '/ai-settings',
  adapt(
    apiHandler({ permission: ['system', 'manage'] }, async () => {
      // Get global settings (programId = null)
      const settings = await db.query.aiSettings.findFirst({
        where: isNull(aiSettings.programId),
      })

      // Check for environment variables
      const envVars = {
        openai: !!process.env.OPENAI_API_KEY,
        anthropic: !!process.env.ANTHROPIC_API_KEY,
      }

      // Decrypt and mask API key in response
      let maskedSettings = null
      if (settings) {
        let maskedKey: string | undefined
        if (settings.config.apiKey) {
          try {
            const decrypted = decryptSecret(settings.config.apiKey)
            maskedKey = `${decrypted.slice(0, 8)}...${decrypted.slice(-4)}`
          } catch {
            // Display only: a key we cannot read still gets a mask, so the
            // settings page renders and the admin can re-save it.
            maskedKey = `${settings.config.apiKey.slice(0, 8)}...`
          }
        }
        maskedSettings = {
          ...settings,
          config: {
            ...settings.config,
            apiKey: maskedKey,
          },
        }
      }

      return {
        settings: maskedSettings,
        envVars,
      }
    }),
  ),
)

// POST /api/admin/ai-settings
app.post(
  '/ai-settings',
  adapt(
    apiHandler(
      { permission: ['system', 'manage'], body: aiSettingsUpdateSchema },
      async ({ body }) => {
        const { enabled, provider, config } = body

        // Encrypt API key before storing if encryption is configured
        const configToStore: AIProviderDBConfig = { ...config }
        if (configToStore.apiKey && isEncryptionConfigured()) {
          configToStore.apiKey = encrypt(configToStore.apiKey)
        } else if (configToStore.apiKey) {
          aiLogger.warn(
            { provider },
            'ENCRYPTION_KEY is not configured — storing AI provider API key in plaintext at rest. Set ENCRYPTION_KEY (see SECURITY.md) and re-save the key to encrypt it.',
          )
        }

        // Check if global settings exist
        const existing = await db.query.aiSettings.findFirst({
          where: isNull(aiSettings.programId),
        })

        let result
        if (existing) {
          // Update existing
          const [updated] = await db
            .update(aiSettings)
            .set({
              enabled,
              provider,
              config: configToStore,
              updatedAt: new Date(),
            })
            .where(eq(aiSettings.id, existing.id))
            .returning()
          // Zero rows here means the row was deleted between the read above and
          // this update — surface it rather than dereferencing undefined below.
          if (!updated) throw new NotFoundError('AI settings', existing.id)
          result = updated
        } else {
          // Create new
          const created = takeFirst(
            await db
              .insert(aiSettings)
              .values({
                enabled,
                provider,
                config: configToStore,
                programId: null, // Global settings
              })
              .returning(),
          )
          result = created
        }

        return {
          settings: {
            ...result,
            config: {
              ...result.config,
              apiKey: result.config.apiKey
                ? `${result.config.apiKey.slice(0, 8)}...${result.config.apiKey.slice(-4)}`
                : undefined,
            },
          },
        }
      },
    ),
  ),
)

// POST /api/admin/ai-settings/test
app.post(
  '/ai-settings/test',
  adapt(
    apiHandler(
      { permission: ['system', 'manage'], body: aiSettingsTestSchema },
      async ({ body }) => {
        const { provider, apiKey, model, baseURL } = body

        // Get API key from env if not provided
        let effectiveApiKey = apiKey
        if (!effectiveApiKey && provider === 'openai') {
          effectiveApiKey = process.env.OPENAI_API_KEY
        }
        if (!effectiveApiKey && provider === 'anthropic') {
          effectiveApiKey = process.env.ANTHROPIC_API_KEY
        }
        if (!effectiveApiKey && provider === 'gemini') {
          effectiveApiKey =
            process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
        }

        // Ollama doesn't need an API key
        if (provider !== 'ollama' && !effectiveApiKey) {
          throw new ValidationError(`API key is required for ${provider}`)
        }

        if (provider === 'ollama') {
          // For Ollama, do a fast reachability check against /api/tags before
          // running an actual chat round-trip. The user-facing baseURL may or
          // may not include /v1 — strip it for the native tags endpoint.
          const rawBase = (baseURL || 'http://localhost:11434').replace(
            /\/+$/,
            '',
          )
          const ollamaNativeUrl = rawBase.endsWith('/v1')
            ? rawBase.slice(0, -3)
            : rawBase
          try {
            const response = await fetch(`${ollamaNativeUrl}/api/tags`, {
              method: 'GET',
              signal: AbortSignal.timeout(5000),
            })
            if (!response.ok) {
              throw new Error(`Ollama returned status ${response.status}`)
            }
          } catch (ollamaError) {
            const err = ollamaError as Error
            return new Response(
              JSON.stringify({
                error: {
                  code: 'CONNECTION_ERROR',
                  message: `Failed to connect to Ollama at ${ollamaNativeUrl}: ${err.message}`,
                },
              }),
              {
                status: 503,
                headers: { 'Content-Type': 'application/json' },
              },
            )
          }
        }

        // Create config and adapter
        const config: AIProviderConfig = {
          provider: provider,
          apiKey: effectiveApiKey,
          model,
          baseURL,
        }

        try {
          // Get the adapter - this validates the config
          const adapter = getAdapter(config)

          // Make a simple test request with minimal tokens using chatStream
          const testMessage = { role: 'user' as const, content: 'Hi' }
          const stream = adapter.chatStream({
            model,
            messages: [testMessage],
            // `maxTokens` is TanStack AI's portable option; it maps to each
            // provider's native field. `maxOutputTokens` is Gemini's native name
            // and, passed via modelOptions, every other adapter ignored it - so
            // this probe was requesting a full-length response.
            maxTokens: 5,
          })
          const response = await streamToText(stream)

          // If we got here, the connection works
          // The schema closed the provider union, so the last arm is total.
          const providerName =
            provider === 'openai'
              ? 'OpenAI'
              : provider === 'anthropic'
                ? 'Anthropic'
                : provider === 'gemini'
                  ? 'Gemini'
                  : 'Ollama'

          return {
            success: true,
            message: `Connected to ${providerName} successfully!`,
            model: model,
            responsePreview: response.slice(0, 50) || '(empty)',
          }
        } catch (adapterError) {
          const err = adapterError as Error
          return new Response(
            JSON.stringify({
              error: {
                code: 'CONNECTION_ERROR',
                message: err.message || 'Failed to connect to AI provider',
              },
            }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          )
        }
      },
    ),
  ),
)

/**
 * Body of `POST /ai-settings/models`. Named rather than inlined in the
 * annotation, because the same object now runs.
 */
const listModelsSchema = z.object({
  provider: z.enum(AI_PROVIDERS),
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
})

// POST /api/admin/ai-settings/models
//
// Lists the models the given credentials can actually reach. POST rather than
// GET because the admin may be probing a key they have typed but not saved.
app.post(
  '/ai-settings/models',
  adapt(
    apiHandler(
      {
        body: listModelsSchema,
        permission: ['system', 'manage'],
        openapi: {
          summary: 'List models available from an AI provider',
          description:
            'Queries the provider’s own list-models endpoint. Falls back to the ' +
            'stored settings key, then the environment key, when no plaintext key is ' +
            'supplied. Returns 503 if the provider is unreachable or rejects the key.',
          responses: {
            200: {
              schema: z.object({
                models: z.array(
                  z.object({ id: z.string(), label: z.string() }),
                ),
                source: z.string(),
              }),
            },
          },
        },
      },
      async ({ body }) => {
        const { provider } = body

        // An empty string is not a base URL; the schema keeps the field
        // optional and this keeps "sent, but blank" meaning the same thing.
        const baseURL = body.baseURL ? body.baseURL : undefined

        const apiKey =
          provider === 'ollama'
            ? undefined
            : await resolveDiscoveryApiKey(provider, body.apiKey)

        if (provider !== 'ollama' && !apiKey) {
          throw new ValidationError(`API key is required for ${provider}`)
        }

        try {
          return await listProviderModels({ provider, apiKey, baseURL })
        } catch (discoveryError) {
          const err = discoveryError as Error
          return new Response(
            JSON.stringify({
              error: {
                code: 'CONNECTION_ERROR',
                message: err.message || 'Failed to list models',
              },
            }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          )
        }
      },
    ),
  ),
)

/**
 * Resolve a usable plaintext key for discovery: the one supplied on the
 * request, else the stored (decrypted) settings key, else the environment.
 *
 * The supplied key is ignored when it looks like the `first8...last4` mask
 * that `GET /ai-settings` returns — the admin form hydrates its API-key field
 * from that masked value, so on page load it would otherwise post the mask
 * straight back and every discovery call would 401. A real key never contains
 * an ellipsis.
 */
async function resolveDiscoveryApiKey(
  provider: ProviderType,
  supplied: unknown,
): Promise<string | undefined> {
  if (typeof supplied === 'string' && supplied && !supplied.includes('...')) {
    return supplied
  }

  const stored = await db.query.aiSettings.findFirst({
    where: isNull(aiSettings.programId),
  })
  const storedKey = stored?.config.apiKey
  if (storedKey && stored.provider === provider) {
    try {
      return decryptSecret(storedKey)
    } catch {
      // Fall through to the environment: a key we cannot decrypt (rotated
      // ENCRYPTION_KEY, say) is no better than no key at all.
    }
  }

  switch (provider) {
    case 'openai':
      return process.env.OPENAI_API_KEY
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY
    case 'gemini':
      return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
    case 'ollama':
      return undefined
  }
}

// ============================================
// Module-contributed admin routes
// ============================================

// Settings surfaces belonging to optional packages mount here — CAD generation
// provider settings, for one. Nothing is registered on a core-only build, so
// this is a no-op there. Mounted before the sections below purely for
// readability; admin has no parameterized top-level routes to shadow.
mountRoutes(app, 'admin')

// ============================================
// Component Catalog
// ============================================

const listQuerySchema = z.object({
  categoryId: z.string().uuid().optional(),
  entryType: z.enum(['component', 'raw_stock']).optional(),
  verified: z
    .string()
    .optional()
    .transform((v) =>
      v === 'true' ? true : v === 'false' ? false : undefined,
    ),
  q: z.string().optional(),
  offset: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 0)),
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 50)),
  sortBy: z.enum(['name', 'createdAt', 'updatedAt']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
})

// Static catalog routes (MUST come before /:id)

// GET /api/admin/component-catalog/categories
app.get(
  '/component-catalog/categories',
  adapt(
    apiHandler({ permission: ['system', 'manage'] }, async () => {
      const categories = await CatalogService.getCategories()
      return { categories }
    }),
  ),
)

// POST /api/admin/component-catalog/categories
app.post(
  '/component-catalog/categories',
  adapt(
    apiHandler(
      { permission: ['system', 'manage'], body: catalogCategoryCreateSchema },
      async ({ body: data }) => {
        const category = await CatalogService.createCategory(data)
        return new Response(JSON.stringify({ data: category }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    ),
  ),
)

// PUT /api/admin/component-catalog/categories/:id
app.put(
  '/component-catalog/categories/:id',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof catalogCategoryUpdateSchema>>(
      { permission: ['system', 'manage'], body: catalogCategoryUpdateSchema },
      async ({ params, body: data }) => {
        const { id } = params
        return CatalogService.updateCategory(id, data)
      },
    ),
  ),
)

// DELETE /api/admin/component-catalog/categories/:id
app.delete(
  '/component-catalog/categories/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['system', 'manage'] },
      async ({ params }) => {
        const { id } = params
        await CatalogService.deleteCategory(id)
        return { deleted: true }
      },
    ),
  ),
)

const importBodySchema = z.object({
  rows: z.array(catalogBulkImportRowSchema).min(1).max(500),
})

// POST /api/admin/component-catalog/import
app.post(
  '/component-catalog/import',
  adapt(
    apiHandler(
      { permission: ['system', 'manage'], body: importBodySchema },
      async ({ body }) => {
        const { rows } = body
        const result = await CatalogService.bulkImport(rows)

        const status =
          result.errorCount === 0 ? 201 : result.successCount === 0 ? 400 : 207

        return new Response(JSON.stringify({ data: result }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    ),
  ),
)

// GET /api/admin/component-catalog
app.get(
  '/component-catalog',
  adapt(
    apiHandler({ permission: ['system', 'manage'] }, async ({ request }) => {
      const query = parseQuery(request, listQuerySchema)
      return CatalogService.list({
        categoryId: query.categoryId,
        entryType: query.entryType,
        verified: query.verified,
        query: query.q,
        offset: query.offset,
        limit: query.limit,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
      })
    }),
  ),
)

// POST /api/admin/component-catalog
app.post(
  '/component-catalog',
  adapt(
    apiHandler(
      { permission: ['system', 'manage'], body: catalogEntryCreateSchema },
      async ({ body: data }) => {
        const entry = await CatalogService.createEntry(data)
        return new Response(JSON.stringify({ data: entry }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    ),
  ),
)

// GET /api/admin/component-catalog/:id
app.get(
  '/component-catalog/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['system', 'manage'] },
      async ({ params }) => {
        const { id } = params
        return CatalogService.getById(id)
      },
    ),
  ),
)

// PUT /api/admin/component-catalog/:id
app.put(
  '/component-catalog/:id',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof catalogEntryUpdateSchema>>(
      { permission: ['system', 'manage'], body: catalogEntryUpdateSchema },
      async ({ params, body: data }) => {
        const { id } = params
        return CatalogService.updateEntry(id, data)
      },
    ),
  ),
)

// DELETE /api/admin/component-catalog/:id
app.delete(
  '/component-catalog/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['system', 'manage'] },
      async ({ params }) => {
        const { id } = params
        await CatalogService.deleteEntry(id)
        return { deleted: true }
      },
    ),
  ),
)

// ============================================
// Item Type Configs
// ============================================

// GET /api/admin/item-type-configs
app.get(
  '/item-type-configs',
  adapt(
    apiHandler({ permission: ['system', 'manage'] }, async () => {
      const runtimeConfigs = await ConfigService.getAllConfigs()
      const configMap = new Map(runtimeConfigs.map((c) => [c.itemType, c]))

      const allTypes = ItemTypeRegistry.getAllTypes()

      const result = allTypes.map((type) => {
        const runtimeConfig = configMap.get(type.name)
        const codeDefinition = ItemTypeRegistry.getCodeDefinition(type.name)

        return {
          itemType: type.name,
          hasCodeDefinition: true,
          hasRuntimeConfig: !!runtimeConfig,
          codeConfig: codeDefinition
            ? {
                label: codeDefinition.label,
                pluralLabel: codeDefinition.pluralLabel,
                icon: codeDefinition.icon,
                states: codeDefinition.states,
                permissions: codeDefinition.permissions,
                relationships: codeDefinition.relationships,
              }
            : null,
          runtimeConfig: runtimeConfig
            ? {
                id: runtimeConfig.id,
                version: runtimeConfig.version,
                isActive: runtimeConfig.isActive,
                config: runtimeConfig.config,
                modifiedAt: runtimeConfig.modifiedAt,
                modifiedBy: runtimeConfig.modifiedBy,
              }
            : null,
          mergedConfig: {
            label: type.label,
            pluralLabel: type.pluralLabel,
            icon: type.icon,
            states: type.states,
            permissions: type.permissions,
            relationships: type.relationships,
          },
        }
      })

      return { configs: result }
    }),
  ),
)

// POST /api/admin/item-type-configs
app.post(
  '/item-type-configs',
  adapt(
    apiHandler(
      { permission: ['system', 'manage'], body: itemTypeConfigBodySchema },
      async ({ user, body }) => {
        const { itemType, config } = body

        if (!ItemTypeRegistry.hasType(itemType)) {
          // Was a 400 carrying code NOT_FOUND. The status is the honest one —
          // the caller named a type that does not exist — so it stays, and the
          // code becomes the one a 400 carries.
          throw new ValidationError(
            `Item type "${itemType}" is not registered in code`,
          )
        }

        const existingConfig = await ConfigService.getConfig(itemType)
        const result = await ConfigService.saveConfig(itemType, config, user.id)

        // Reload registry to pick up new config
        await ItemTypeRegistry.reload()

        return new Response(
          JSON.stringify({
            data: {
              config: result,
              merged: ItemTypeRegistry.getType(itemType),
            },
          }),
          {
            status: existingConfig ? 200 : 201,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      },
    ),
  ),
)

// GET /api/admin/item-type-configs/:itemType
app.get(
  '/item-type-configs/:itemType',
  adapt(
    apiHandler<{ itemType: string }>(
      { permission: ['system', 'manage'] },
      async ({ params }) => {
        const { itemType } = params

        const codeDefinition = ItemTypeRegistry.getCodeDefinition(itemType)

        if (!codeDefinition) {
          throw new NotFoundError('Item type', itemType)
        }

        const runtimeConfig = await ConfigService.getConfig(itemType)
        const mergedConfig = ItemTypeRegistry.getType(itemType)

        return {
          itemType,
          codeConfig: {
            label: codeDefinition.label,
            pluralLabel: codeDefinition.pluralLabel,
            icon: codeDefinition.icon,
            states: codeDefinition.states,
            permissions: codeDefinition.permissions,
            relationships: codeDefinition.relationships,
            searchableFields: codeDefinition.searchableFields,
            displayField: codeDefinition.displayField,
          },
          runtimeConfig: runtimeConfig
            ? {
                id: runtimeConfig.id,
                version: runtimeConfig.version,
                isActive: runtimeConfig.isActive,
                config: runtimeConfig.config,
                modifiedAt: runtimeConfig.modifiedAt,
                modifiedBy: runtimeConfig.modifiedBy,
                createdAt: runtimeConfig.createdAt,
              }
            : null,
          mergedConfig: mergedConfig
            ? {
                label: mergedConfig.label,
                pluralLabel: mergedConfig.pluralLabel,
                icon: mergedConfig.icon,
                states: mergedConfig.states,
                permissions: mergedConfig.permissions,
                relationships: mergedConfig.relationships,
              }
            : null,
        }
      },
    ),
  ),
)

// DELETE /api/admin/item-type-configs/:itemType
app.delete(
  '/item-type-configs/:itemType',
  adapt(
    apiHandler<{ itemType: string }>(
      { permission: ['system', 'manage'] },
      async ({ params }) => {
        const { itemType } = params

        if (!ItemTypeRegistry.hasType(itemType)) {
          throw new NotFoundError('Item type', itemType)
        }

        await ConfigService.deleteConfig(itemType)

        // Reload registry to clear the runtime config
        await ItemTypeRegistry.reload()

        return {
          success: true,
          message: `Runtime configuration for "${itemType}" deleted. Reverted to code defaults.`,
        }
      },
    ),
  ),
)

// ============================================
// Jobs
// ============================================

const jobListQuerySchema = z.object({
  status: z
    .enum(['pending', 'queued', 'running', 'completed', 'failed', 'cancelled'])
    .optional(),
  type: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
})

// GET /api/admin/jobs
app.get(
  '/jobs',
  adapt(
    apiHandler({ permission: ['system', 'manage'] }, async ({ request }) => {
      const query = parseQuery(request, jobListQuerySchema)

      const result = await JobService.list({
        status: query.status || undefined,
        type: query.type || undefined,
        limit: query.limit,
        offset: query.offset,
      })

      return {
        jobs: result.jobs,
        total: result.total,
      }
    }),
  ),
)

// GET /api/admin/jobs/:id
app.get(
  '/jobs/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['system', 'manage'] },
      async ({ params }) => {
        const { id } = params
        const job = await JobService.getOrThrow(id)
        const logs = await JobService.getLogs(id)

        return { job, logs }
      },
    ),
  ),
)

// POST /api/admin/jobs/:id/cancel
app.post(
  '/jobs/:id/cancel',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['system', 'manage'] },
      async ({ params }) => {
        const { id } = params
        await JobService.cancel(id)

        return { success: true }
      },
    ),
  ),
)

// POST /api/admin/jobs/:id/retry
app.post(
  '/jobs/:id/retry',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['system', 'manage'] },
      async ({ params, user }) => {
        const { id } = params
        const job = await JobService.retry(id, user.id)

        return { job }
      },
    ),
  ),
)

// ============================================
// Reload Config
// ============================================

// POST /api/admin/reload-config
app.post(
  '/reload-config',
  adapt(
    apiHandler({ permission: ['system', 'manage'] }, async () => {
      await ItemTypeRegistry.reload()
      const afterCount = ItemTypeRegistry.getAllTypes().length

      return {
        success: true,
        message: 'Runtime configurations reloaded successfully',
        itemTypesCount: afterCount,
        timestamp: new Date().toISOString(),
      }
    }),
  ),
)

// ============================================
// Settings
// ============================================

// GET /api/admin/settings
app.get(
  '/settings',
  adapt(
    apiHandler({ permission: ['system', 'manage'] }, async ({ request }) => {
      const url = new URL(request.url)
      const key = url.searchParams.get('key')

      if (key) {
        // Get single setting
        const setting = await SettingsService.get(key)
        return { setting }
      }

      // Get all settings
      const settings = await SettingsService.getAll()
      return { settings }
    }),
  ),
)

// POST /api/admin/settings
app.post(
  '/settings',
  adapt(
    apiHandler(
      { permission: ['system', 'manage'], body: settingsWriteSchema },
      async ({ user, body }) => {
        const { key, value, jsonValue, description } = body

        let result
        if (jsonValue !== undefined) {
          result = await SettingsService.setJsonValue(
            key,
            jsonValue,
            user.id,
            description,
          )
        } else if (value !== undefined) {
          result = await SettingsService.setValue(
            key,
            value,
            user.id,
            description,
          )
        } else {
          throw new ValidationError('Either value or jsonValue is required')
        }

        return { setting: result }
      },
    ),
  ),
)

// DELETE /api/admin/settings
app.delete(
  '/settings',
  adapt(
    apiHandler({ permission: ['system', 'manage'] }, async ({ request }) => {
      const url = new URL(request.url)
      const key = url.searchParams.get('key')

      if (!key) {
        throw new ValidationError('key query parameter is required')
      }

      const deleted = await SettingsService.delete(key)

      if (!deleted) {
        throw new NotFoundError('Setting', key)
      }

      return { deleted: true, key }
    }),
  ),
)

// ============================================
// Thread Cache
// ============================================

// POST /api/admin/thread-cache/cleanup
app.post(
  '/thread-cache/cleanup',
  adapt(
    apiHandler(
      { permission: ['system', 'manage'], body: threadCacheCleanupSchema },
      async ({ body }) => {
        let maxAgeMs = 7 * 24 * 60 * 60 * 1000 // 7 days default
        let maxInvalidatedAgeMs = 60 * 60 * 1000 // 1 hour default

        if (body?.maxAgeDays !== undefined) {
          maxAgeMs = body.maxAgeDays * 24 * 60 * 60 * 1000
        }
        if (body?.maxInvalidatedAgeHours !== undefined) {
          maxInvalidatedAgeMs = body.maxInvalidatedAgeHours * 60 * 60 * 1000
        }

        const removed = await ThreadCacheService.cleanup(
          maxAgeMs,
          maxInvalidatedAgeMs,
        )

        return {
          removed,
          message: `Cleaned up ${removed} cache entries`,
        }
      },
    ),
  ),
)

// POST /api/admin/thread-cache/clear
app.post(
  '/thread-cache/clear',
  adapt(
    apiHandler(
      { permission: ['system', 'manage'], body: threadCacheClearSchema },
      async ({ body }) => {
        if (body?.confirm !== true) {
          throw new ValidationError(
            'Confirmation required. Set confirm: true to clear all cache entries.',
          )
        }

        const removed = await ThreadCacheService.clearAll()

        return {
          removed,
          message: `Cleared ${removed} cache entries`,
        }
      },
    ),
  ),
)

// GET /api/admin/thread-cache/stats
app.get(
  '/thread-cache/stats',
  adapt(
    apiHandler({ permission: ['system', 'manage'] }, async () => {
      const stats = await ThreadCacheService.getStats()

      return stats
    }),
  ),
)

// POST /api/admin/thread-cache/warm
app.post(
  '/thread-cache/warm',
  adapt(
    apiHandler(
      { permission: ['system', 'manage'], body: threadCacheWarmSchema },
      async ({ body }) => {
        if (body.itemIds.length > 100) {
          throw new ValidationError('itemIds array must not exceed 100 items')
        }

        const result = await ThreadCacheService.warmCache(
          body.itemIds,
          body.request,
        )

        return {
          ...result,
          message: `Warmed cache for ${result.warmed} items (${result.errors} errors)`,
        }
      },
    ),
  ),
)

// ============================================
// Vault Config
// ============================================

// GET /api/admin/vault-config
app.get(
  '/vault-config',
  adapt(
    apiHandler({ permission: ['system', 'manage'] }, async () => {
      const configInfo = await StorageFactory.getConfigInfo()

      return configInfo
    }),
  ),
)

// ============================================
// API Keys
// ============================================

// GET /api/admin/api-key-policy
app.get(
  '/api-key-policy',
  adapt(
    apiHandler(
      { authMethod: 'session', permission: ['system', 'manage'] },
      async () => {
        const policy = await loadApiKeyPolicy()
        return { policy, defaults: DEFAULT_API_KEY_POLICY }
      },
    ),
  ),
)

// PUT /api/admin/api-key-policy
app.put(
  '/api-key-policy',
  adapt(
    apiHandler(
      {
        authMethod: 'session',
        permission: ['system', 'manage'],
        body: apiKeyPolicySchema,
      },
      async ({ user, body }) => {
        const policy: ApiKeyPolicy = {
          defaultExpirationDays: body.defaultExpirationDays ?? null,
          maxExpirationDays: body.maxExpirationDays ?? null,
          requireExpiration: body.requireExpiration ?? false,
        }

        const invalid = validateApiKeyPolicy(policy)
        if (invalid) throw new ValidationError(invalid)

        await saveApiKeyPolicy(policy, user.id)

        // Existing keys keep the expiry they were issued with — a policy
        // change governs issuance, it does not retroactively shorten keys
        // already in the field.
        return { policy }
      },
    ),
  ),
)

// GET /api/admin/api-keys — every key on the instance, with its owner.
// Key material is never selected; keyPrefix is the only fragment returned.
app.get(
  '/api-keys',
  adapt(
    apiHandler(
      { authMethod: 'session', permission: ['system', 'manage'] },
      async () => {
        const keys = await ApiKeyService.listAll()
        return { apiKeys: keys }
      },
    ),
  ),
)

// GET /api/admin/api-keys/:keyId/activity — activity for any user's key
app.get(
  '/api-keys/:keyId/activity',
  adapt(
    apiHandler<{ keyId: string }>(
      { authMethod: 'session', permission: ['system', 'manage'] },
      async ({ params }) => {
        const events = await ApiKeyService.activity(params.keyId, null)
        return { events }
      },
    ),
  ),
)

// PATCH /api/admin/api-keys/:keyId — rename or re-scope any user's key.
// Role scope is still validated against the key *owner's* roles, not the
// admin's — the key acts as its owner, so that is the real ceiling.
app.patch(
  '/api-keys/:keyId',
  adapt(
    apiHandler<{ keyId: string }, UpdateApiKeyInput>(
      {
        authMethod: 'session',
        permission: ['system', 'manage'],
        body: apiKeyUpdateSchema,
      },
      async ({ params, body }) => {
        const key = await ApiKeyService.update(params.keyId, null, body)
        return { apiKey: key }
      },
    ),
  ),
)

// POST /api/admin/api-keys/:keyId/disable — reversible pause
app.post(
  '/api-keys/:keyId/disable',
  adapt(
    apiHandler<{ keyId: string }>(
      { authMethod: 'session', permission: ['system', 'manage'] },
      async ({ params }) => {
        const key = await ApiKeyService.setDisabled(params.keyId, null, true)
        return { apiKey: key }
      },
    ),
  ),
)

// POST /api/admin/api-keys/:keyId/enable — undo a disable
app.post(
  '/api-keys/:keyId/enable',
  adapt(
    apiHandler<{ keyId: string }>(
      { authMethod: 'session', permission: ['system', 'manage'] },
      async ({ params }) => {
        const key = await ApiKeyService.setDisabled(params.keyId, null, false)
        return { apiKey: key }
      },
    ),
  ),
)

// DELETE /api/admin/api-keys/:keyId — permanently revoke any user's key
app.delete(
  '/api-keys/:keyId',
  adapt(
    apiHandler<{ keyId: string }>(
      { authMethod: 'session', permission: ['system', 'manage'] },
      async ({ params }) => {
        const key = await ApiKeyService.revoke(params.keyId, null)
        return { success: true, apiKey: key }
      },
    ),
  ),
)

export default app
