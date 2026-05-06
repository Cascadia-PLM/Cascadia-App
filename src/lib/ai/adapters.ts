// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

/**
 * AI Provider Adapters
 *
 * This module provides a unified interface for creating TanStack AI adapters
 * for different LLM providers. It supports runtime provider switching via
 * database settings or environment variables.
 */

import { createAnthropicChat } from '@tanstack/ai-anthropic'
import { createOpenaiChat } from '@tanstack/ai-openai'
import { eq, isNull } from 'drizzle-orm'

import type { AIProviderConfig, ProviderType } from '@/lib/db/schema/ai'
import { aiSettings } from '@/lib/db/schema/ai'
import { db } from '@/lib/db'
import { decrypt, isEncryptionConfigured } from '@/lib/crypto/encryption'

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
 * Default models for each provider
 */
export const DEFAULT_MODELS: Record<ProviderType, string> = {
  openai: 'gpt-4.1',
  anthropic: 'claude-sonnet-4-6',
  gemini: 'gemini-2.5-flash',
  ollama: 'llama3.3',
}

/**
 * Decrypt API key in config if it was encrypted at rest.
 * Encrypted keys are base64 and don't start with known prefixes like "sk-".
 */
function decryptApiKey(config: AIProviderConfig): AIProviderConfig {
  if (!config.apiKey || !isEncryptionConfigured()) return config
  // Known plaintext prefixes from providers — skip decryption
  if (config.apiKey.startsWith('sk-') || config.apiKey.startsWith('key-')) {
    return config
  }
  try {
    return { ...config, apiKey: decrypt(config.apiKey) }
  } catch {
    // If decryption fails, return as-is (may be plaintext from before encryption was enabled)
    return config
  }
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
 * Load provider configuration from database or environment variables
 *
 * Priority:
 * 1. Program-specific settings (if programId provided)
 * 2. Global settings (programId = null)
 * 3. Environment variables
 */
export async function loadProviderConfig(
  programId?: string,
): Promise<AIProviderConfig> {
  // Check for program-specific settings first
  if (programId) {
    const programSettings = await db.query.aiSettings.findFirst({
      where: eq(aiSettings.programId, programId),
    })

    if (programSettings?.enabled && programSettings.config) {
      return decryptApiKey(programSettings.config)
    }
  }

  // Fall back to global settings (programId = null)
  const globalSettings = await db.query.aiSettings.findFirst({
    where: isNull(aiSettings.programId),
  })

  if (globalSettings?.enabled && globalSettings.config) {
    return decryptApiKey(globalSettings.config)
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
