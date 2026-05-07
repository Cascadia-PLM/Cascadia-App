import { Hono } from 'hono'
import { z } from 'zod'
import { eq, isNull } from 'drizzle-orm'
import { streamToText } from '@tanstack/ai'
import { tagged } from '../adapter'
import type { AIProviderConfig as AIProviderDBConfig } from '@/lib/db/schema/ai'
import type { AIProviderConfig, ProviderType } from '@/lib/ai/adapters'
import { apiHandler, parseQuery } from '@/lib/api/handler'
import { db } from '@/lib/db'
import { aiSettings } from '@/lib/db/schema/ai'
import {
  decrypt,
  encrypt,
  isEncryptionConfigured,
} from '@/lib/crypto/encryption'
import { getAdapter } from '@/lib/ai/adapters'
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
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Admin')

const app = new Hono()

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
            const decrypted =
              isEncryptionConfigured() &&
              !settings.config.apiKey.startsWith('sk-') &&
              !settings.config.apiKey.startsWith('key-')
                ? decrypt(settings.config.apiKey)
                : settings.config.apiKey
            maskedKey = `${decrypted.slice(0, 8)}...${decrypted.slice(-4)}`
          } catch {
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
    apiHandler({ permission: ['system', 'manage'] }, async ({ request }) => {
      const body = await request.json()
      const { enabled, provider, config } = body as {
        enabled: boolean
        provider: string
        config: AIProviderDBConfig
      }

      // Validate required fields
      if (typeof enabled !== 'boolean') {
        return new Response(
          JSON.stringify({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'enabled must be a boolean',
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (!provider || typeof provider !== 'string') {
        return new Response(
          JSON.stringify({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'provider is required',
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }

      const validProviders = ['openai', 'anthropic', 'gemini', 'ollama']
      if (!validProviders.includes(provider)) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'VALIDATION_ERROR',
              message: `Invalid provider. Must be one of: ${validProviders.join(', ')}`,
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }

      // Encrypt API key before storing if encryption is configured
      const configToStore: AIProviderDBConfig = { ...config }
      if (configToStore.apiKey && isEncryptionConfigured()) {
        configToStore.apiKey = encrypt(configToStore.apiKey)
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
        result = updated
      } else {
        // Create new
        const [created] = await db
          .insert(aiSettings)
          .values({
            enabled,
            provider,
            config: configToStore,
            programId: null, // Global settings
          })
          .returning()
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
    }),
  ),
)

// POST /api/admin/ai-settings/test
app.post(
  '/ai-settings/test',
  adapt(
    apiHandler({ permission: ['system', 'manage'] }, async ({ request }) => {
      const body = await request.json()
      const { provider, apiKey, model, baseURL } = body as {
        provider: string
        apiKey?: string
        model: string
        baseURL?: string
      }

      // Validate provider
      const validProviders = ['openai', 'anthropic', 'gemini', 'ollama']
      if (!validProviders.includes(provider)) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'VALIDATION_ERROR',
              message: `Invalid provider. Must be one of: ${validProviders.join(', ')}`,
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }

      // Get API key from env if not provided
      let effectiveApiKey = apiKey
      if (!effectiveApiKey && provider === 'openai') {
        effectiveApiKey = process.env.OPENAI_API_KEY
      }
      if (!effectiveApiKey && provider === 'anthropic') {
        effectiveApiKey = process.env.ANTHROPIC_API_KEY
      }
      if (!effectiveApiKey && provider === 'gemini') {
        effectiveApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
      }

      // Ollama doesn't need an API key
      if (provider !== 'ollama' && !effectiveApiKey) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'VALIDATION_ERROR',
              message: `API key is required for ${provider}`,
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
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
        provider: provider as ProviderType,
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
          messages: [testMessage],
          modelOptions: { maxOutputTokens: 5 },
        })
        const response = await streamToText(stream)

        // If we got here, the connection works
        const providerName =
          provider === 'openai'
            ? 'OpenAI'
            : provider === 'anthropic'
              ? 'Anthropic'
              : provider === 'gemini'
                ? 'Gemini'
                : provider === 'ollama'
                  ? 'Ollama'
                  : provider

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
    }),
  ),
)

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
    apiHandler({ permission: ['system', 'manage'] }, async ({ request }) => {
      const body = await request.json()
      const data = catalogCategoryCreateSchema.parse(body)
      const category = await CatalogService.createCategory(data)
      return new Response(JSON.stringify({ data: category }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  ),
)

// PUT /api/admin/component-catalog/categories/:id
app.put(
  '/component-catalog/categories/:id',
  adapt(
    apiHandler(
      { permission: ['system', 'manage'] },
      async ({ params, request }) => {
        const body = await request.json()
        const data = catalogCategoryUpdateSchema.parse(body)
        return CatalogService.updateCategory(params.id, data)
      },
    ),
  ),
)

// DELETE /api/admin/component-catalog/categories/:id
app.delete(
  '/component-catalog/categories/:id',
  adapt(
    apiHandler({ permission: ['system', 'manage'] }, async ({ params }) => {
      await CatalogService.deleteCategory(params.id)
      return { deleted: true }
    }),
  ),
)

const importBodySchema = z.object({
  rows: z.array(catalogBulkImportRowSchema).min(1).max(500),
})

// POST /api/admin/component-catalog/import
app.post(
  '/component-catalog/import',
  adapt(
    apiHandler({ permission: ['system', 'manage'] }, async ({ request }) => {
      const body = await request.json()
      const { rows } = importBodySchema.parse(body)
      const result = await CatalogService.bulkImport(rows)

      const status =
        result.errorCount === 0 ? 201 : result.successCount === 0 ? 400 : 207

      return new Response(JSON.stringify({ data: result }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
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
    apiHandler({ permission: ['system', 'manage'] }, async ({ request }) => {
      const body = await request.json()
      const data = catalogEntryCreateSchema.parse(body)
      const entry = await CatalogService.createEntry(data)
      return new Response(JSON.stringify({ data: entry }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  ),
)

// GET /api/admin/component-catalog/:id
app.get(
  '/component-catalog/:id',
  adapt(
    apiHandler({ permission: ['system', 'manage'] }, async ({ params }) => {
      return CatalogService.getById(params.id)
    }),
  ),
)

// PUT /api/admin/component-catalog/:id
app.put(
  '/component-catalog/:id',
  adapt(
    apiHandler(
      { permission: ['system', 'manage'] },
      async ({ params, request }) => {
        const body = await request.json()
        const data = catalogEntryUpdateSchema.parse(body)
        return CatalogService.updateEntry(params.id, data)
      },
    ),
  ),
)

// DELETE /api/admin/component-catalog/:id
app.delete(
  '/component-catalog/:id',
  adapt(
    apiHandler({ permission: ['system', 'manage'] }, async ({ params }) => {
      await CatalogService.deleteEntry(params.id)
      return { deleted: true }
    }),
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
      { permission: ['system', 'manage'] },
      async ({ request, user }) => {
        const body = await request.json()
        const { itemType, config } = body

        if (!itemType || typeof itemType !== 'string') {
          return new Response(
            JSON.stringify({
              error: {
                code: 'VALIDATION_ERROR',
                message: 'itemType is required',
              },
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        if (!ItemTypeRegistry.hasType(itemType)) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'NOT_FOUND',
                message: `Item type "${itemType}" is not registered in code`,
              },
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        if (!config || typeof config !== 'object') {
          return new Response(
            JSON.stringify({
              error: {
                code: 'VALIDATION_ERROR',
                message: 'config object is required',
              },
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
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
    apiHandler({ permission: ['system', 'manage'] }, async ({ params }) => {
      const { itemType } = params

      const codeDefinition = ItemTypeRegistry.getCodeDefinition(itemType)

      if (!codeDefinition) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'NOT_FOUND',
              message: `Item type "${itemType}" not found`,
            },
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        )
      }

      const runtimeConfig = await ConfigService.getConfig(itemType)
      const mergedConfig = ItemTypeRegistry.getType(itemType)

      return {
        itemType,
        codeConfig: {
          label: codeDefinition.label,
          pluralLabel: codeDefinition.pluralLabel,
          icon: codeDefinition.icon,
          defaultState: codeDefinition.defaultState,
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
              defaultState: mergedConfig.defaultState,
              states: mergedConfig.states,
              permissions: mergedConfig.permissions,
              relationships: mergedConfig.relationships,
            }
          : null,
      }
    }),
  ),
)

// DELETE /api/admin/item-type-configs/:itemType
app.delete(
  '/item-type-configs/:itemType',
  adapt(
    apiHandler({ permission: ['system', 'manage'] }, async ({ params }) => {
      const { itemType } = params

      if (!ItemTypeRegistry.hasType(itemType)) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'NOT_FOUND',
              message: `Item type "${itemType}" not found`,
            },
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        )
      }

      await ConfigService.deleteConfig(itemType)

      // Reload registry to clear the runtime config
      await ItemTypeRegistry.reload()

      return {
        success: true,
        message: `Runtime configuration for "${itemType}" deleted. Reverted to code defaults.`,
      }
    }),
  ),
)

// ============================================
// Jobs
// ============================================

const jobListQuerySchema = z.object({
  status: z.string().optional(),
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
    apiHandler({ permission: ['system', 'manage'] }, async ({ params }) => {
      const job = await JobService.getOrThrow(params.id)
      const logs = await JobService.getLogs(params.id)

      return { job, logs }
    }),
  ),
)

// POST /api/admin/jobs/:id/cancel
app.post(
  '/jobs/:id/cancel',
  adapt(
    apiHandler({ permission: ['system', 'manage'] }, async ({ params }) => {
      await JobService.cancel(params.id)

      return { success: true }
    }),
  ),
)

// POST /api/admin/jobs/:id/retry
app.post(
  '/jobs/:id/retry',
  adapt(
    apiHandler(
      { permission: ['system', 'manage'] },
      async ({ params, user }) => {
        const job = await JobService.retry(params.id, user.id)

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
      { permission: ['system', 'manage'] },
      async ({ request, user }) => {
        const body = await request.json()
        const { key, value, jsonValue, description } = body

        if (!key || typeof key !== 'string') {
          return new Response(
            JSON.stringify({
              error: {
                code: 'VALIDATION_ERROR',
                message: 'key is required and must be a string',
              },
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        if (value === undefined && jsonValue === undefined) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'VALIDATION_ERROR',
                message: 'Either value or jsonValue is required',
              },
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        let result
        if (jsonValue !== undefined) {
          result = await SettingsService.setJsonValue(
            key,
            jsonValue,
            user.id,
            description,
          )
        } else {
          result = await SettingsService.setValue(
            key,
            value,
            user.id,
            description,
          )
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
        return new Response(
          JSON.stringify({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'key query parameter is required',
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }

      const deleted = await SettingsService.delete(key)

      if (!deleted) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'NOT_FOUND',
              message: `Setting "${key}" not found`,
            },
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        )
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
    apiHandler({ permission: ['system', 'manage'] }, async ({ request }) => {
      let maxAgeMs = 7 * 24 * 60 * 60 * 1000 // 7 days default
      let maxInvalidatedAgeMs = 60 * 60 * 1000 // 1 hour default

      try {
        const body = await request.json()
        if (body.maxAgeDays !== undefined) {
          maxAgeMs = body.maxAgeDays * 24 * 60 * 60 * 1000
        }
        if (body.maxInvalidatedAgeHours !== undefined) {
          maxInvalidatedAgeMs = body.maxInvalidatedAgeHours * 60 * 60 * 1000
        }
      } catch {
        // No body or invalid JSON, use defaults
      }

      const removed = await ThreadCacheService.cleanup(
        maxAgeMs,
        maxInvalidatedAgeMs,
      )

      return {
        removed,
        message: `Cleaned up ${removed} cache entries`,
      }
    }),
  ),
)

// POST /api/admin/thread-cache/clear
app.post(
  '/thread-cache/clear',
  adapt(
    apiHandler({ permission: ['system', 'manage'] }, async ({ request }) => {
      const body = await request.json()

      if (body.confirm !== true) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'VALIDATION_ERROR',
              message:
                'Confirmation required. Set confirm: true to clear all cache entries.',
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }

      const removed = await ThreadCacheService.clearAll()

      return {
        removed,
        message: `Cleared ${removed} cache entries`,
      }
    }),
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
    apiHandler({ permission: ['system', 'manage'] }, async ({ request }) => {
      const body = await request.json()

      if (!body.itemIds || !Array.isArray(body.itemIds)) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'itemIds array is required',
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (body.itemIds.length === 0) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'itemIds array must not be empty',
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (body.itemIds.length > 100) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'itemIds array must not exceed 100 items',
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }

      const result = await ThreadCacheService.warmCache(
        body.itemIds,
        body.request,
      )

      return {
        ...result,
        message: `Warmed cache for ${result.warmed} items (${result.errors} errors)`,
      }
    }),
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

export default app
