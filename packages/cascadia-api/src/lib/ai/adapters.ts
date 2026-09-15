// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * AI Provider Adapters
 *
 * This module provides a unified interface for creating TanStack AI adapters
 * for different LLM providers. It supports runtime provider switching via
 * database settings or environment variables.
 */

import { createAnthropicChat } from '@tanstack/ai-anthropic'
import { createOpenaiChat } from '@tanstack/ai-openai'
import { and, eq, gte, isNull, sql } from 'drizzle-orm'

import type { AIProviderConfig, ProviderType } from '@/lib/db/schema/ai'
import { aiSettings, aiUsageLogs } from '@/lib/db/schema/ai'
import { db } from '@/lib/db'
import { decryptSecret } from '@/lib/crypto/encryption'
import { DEFAULT_MODEL } from '@/lib/ai/model-catalog'
import { RateLimitedError } from '@/lib/errors'

// Re-export types for convenience
export type { AIProviderConfig, ProviderType }

/**
 * Google's OpenAI-compatible Gemini endpoint. Accepts a Google AI Studio key
 * as the bearer token and otherwise speaks the OpenAI chat-completions wire
 * format, so we can reuse `createOpenaiChat` instead of a separate SDK.
 */
const GEMINI_OPENAI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai/'

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1'

/**
 * Default model per provider, used when nothing is configured.
 *
 * Single-sourced from the client-safe catalog so the server default and the
 * value the admin picker pre-selects cannot drift apart.
 */
export const DEFAULT_MODELS: Record<ProviderType, string> = DEFAULT_MODEL

/**
 * Decrypt the API key in a config that was encrypted at rest.
 *
 * Throws SecretDecryptionError if a stored ciphertext will not decrypt, rather
 * than passing it through: a key we cannot read is not a key, and sending the
 * ciphertext upstream as a bearer token only converts one config error into a
 * pile of provider 401s.
 */
function decryptApiKey(config: AIProviderConfig): AIProviderConfig {
  if (!config.apiKey) return config
  return { ...config, apiKey: decryptSecret(config.apiKey) }
}

/**
 * Get the appropriate TanStack AI adapter based on configuration
 */
export function getAdapter(config: AIProviderConfig) {
  const model = config.model || DEFAULT_MODELS[config.provider]

  switch (config.provider) {
    case 'openai': {
      if (!config.apiKey) {
        throw new Error('OpenAI API key is required')
      }
      return createOpenaiChat(model as any, config.apiKey, {
        baseURL: config.baseURL,
      })
    }

    case 'anthropic': {
      if (!config.apiKey) {
        throw new Error('Anthropic API key is required')
      }
      return createAnthropicChat(model as any, config.apiKey)
    }

    case 'gemini': {
      if (!config.apiKey) {
        throw new Error('Gemini API key is required')
      }
      return createOpenaiChat(model as any, config.apiKey, {
        baseURL: GEMINI_OPENAI_BASE_URL,
      })
    }

    case 'ollama': {
      const rawBase = (config.baseURL || DEFAULT_OLLAMA_BASE_URL).replace(
        /\/+$/,
        '',
      )
      const baseURL = rawBase.endsWith('/v1') ? rawBase : `${rawBase}/v1`
      // Ollama ignores the bearer token but the OpenAI SDK requires a non-empty string.
      return createOpenaiChat(model as any, config.apiKey || 'ollama', {
        baseURL,
      })
    }

    default:
      throw new Error(`Unknown provider: ${config.provider}`)
  }
}

/**
 * Enforce the monthly token budget carried by the resolved settings row.
 *
 * A budget on a program's row bounds that program's month-to-date spend; a
 * budget on the global row bounds the whole instance's. No budget (or a
 * non-positive one) means no usage query runs at all — an unconfigured
 * instance pays nothing per request. The check gates *new* calls: an
 * in-flight stream that crosses the line finishes and is recorded, so an
 * overrun of one request is accepted by design.
 *
 * This lives in `loadProviderConfig` because every AI surface — chat, all
 * design-engine stages, enrichment — resolves its provider through it.
 */
async function enforceMonthlyTokenBudget(
  config: AIProviderConfig,
  programId: string | null,
): Promise<AIProviderConfig> {
  const budget = config.monthlyTokenBudget
  if (typeof budget !== 'number' || budget <= 0) return config

  const monthStart = sql`date_trunc('month', now())`
  const spendWhere = programId
    ? and(
        eq(aiUsageLogs.programId, programId),
        gte(aiUsageLogs.timestamp, monthStart),
      )
    : gte(aiUsageLogs.timestamp, monthStart)

  const [row] = await db
    .select({
      spent: sql<number>`COALESCE(SUM(COALESCE(${aiUsageLogs.inputTokens}, 0) + COALESCE(${aiUsageLogs.outputTokens}, 0)), 0)::bigint`,
    })
    .from(aiUsageLogs)
    .where(spendWhere)

  const spent = Number(row?.spent ?? 0)
  if (spent >= budget) {
    throw new RateLimitedError(undefined, {
      operation: 'ai.budget',
      scope: programId ?? 'global',
      monthlyTokenBudget: budget,
      tokensSpentThisMonth: spent,
    })
  }
  return config
}

/**
 * Load provider configuration from database or environment variables
 *
 * Priority:
 * 1. Program-specific settings (if programId provided)
 * 2. Global settings (programId = null)
 * 3. Environment variables
 *
 * Throws `RateLimitedError` (429) when the resolved settings row carries a
 * `monthlyTokenBudget` the month-to-date spend has reached.
 */
export async function loadProviderConfig(
  programId?: string,
): Promise<AIProviderConfig> {
  // Check for program-specific settings first
  if (programId) {
    const programSettings = await db.query.aiSettings.findFirst({
      where: eq(aiSettings.programId, programId),
    })

    if (programSettings?.enabled) {
      return enforceMonthlyTokenBudget(
        decryptApiKey(programSettings.config),
        programId,
      )
    }
  }

  // Fall back to global settings (programId = null)
  const globalSettings = await db.query.aiSettings.findFirst({
    where: isNull(aiSettings.programId),
  })

  if (globalSettings?.enabled) {
    return enforceMonthlyTokenBudget(decryptApiKey(globalSettings.config), null)
  }

  // Fall back to environment variables
  const openaiKey = process.env.OPENAI_API_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
  const ollamaBaseURL = process.env.OLLAMA_BASE_URL

  if (openaiKey) {
    return {
      provider: 'openai',
      apiKey: openaiKey,
      model: process.env.OPENAI_MODEL || DEFAULT_MODELS.openai,
      baseURL: process.env.OPENAI_BASE_URL,
    }
  }

  if (anthropicKey) {
    return {
      provider: 'anthropic',
      apiKey: anthropicKey,
      model: process.env.ANTHROPIC_MODEL || DEFAULT_MODELS.anthropic,
    }
  }

  if (geminiKey) {
    return {
      provider: 'gemini',
      apiKey: geminiKey,
      model: process.env.GEMINI_MODEL || DEFAULT_MODELS.gemini,
    }
  }

  if (ollamaBaseURL) {
    return {
      provider: 'ollama',
      apiKey: '',
      model: process.env.OLLAMA_MODEL || DEFAULT_MODELS.ollama,
      baseURL: ollamaBaseURL,
    }
  }

  throw new Error(
    'No AI provider configured. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, or OLLAMA_BASE_URL environment variable, or configure in AI settings.',
  )
}

/**
 * Check if AI is enabled for a given program (or globally)
 */
export async function isAIEnabled(programId?: string): Promise<boolean> {
  // Check program-specific settings
  if (programId) {
    const programSettings = await db.query.aiSettings.findFirst({
      where: eq(aiSettings.programId, programId),
    })

    if (programSettings) {
      return programSettings.enabled
    }
  }

  // Check global settings
  const globalSettings = await db.query.aiSettings.findFirst({
    where: isNull(aiSettings.programId),
  })

  if (globalSettings) {
    return globalSettings.enabled
  }

  // Fall back to checking env vars
  return !!(
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.OLLAMA_BASE_URL
  )
}

/**
 * Get available providers based on environment and settings
 */
export function getAvailableProviders(): Array<ProviderType> {
  const providers: Array<ProviderType> = []

  if (process.env.OPENAI_API_KEY) {
    providers.push('openai')
  }

  if (process.env.ANTHROPIC_API_KEY) {
    providers.push('anthropic')
  }

  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    providers.push('gemini')
  }

  if (process.env.OLLAMA_BASE_URL) {
    providers.push('ollama')
  }

  return providers
}
