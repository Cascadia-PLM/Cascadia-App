// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

/**
 * Zoo Text-to-CAD API Client
 *
 * Wraps Zoo's Text-to-CAD API for generating STEP files from text prompts.
 * Handles submission, polling with exponential backoff, and result extraction.
 */

import type { ZooTextToCadResponse } from './types'

const ZOO_API_BASE = 'https://api.zoo.dev'

export class ZooClient {
  private apiKey: string

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.ZOO_API_KEY ?? ''
    if (!this.apiKey) {
      throw new Error(
        'ZOO_API_KEY is required. Set it in environment variables.',
      )
    }
  }

  /**
   * Submit a text-to-CAD generation request.
   */
  async submitGeneration(
    prompt: string,
    outputFormat: 'step' | 'stl' = 'step',
  ): Promise<string> {
    const response = await fetch(
      `${ZOO_API_BASE}/ai/text-to-cad/${outputFormat}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prompt }),
      },
    )

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '')
      throw new Error(
        `Zoo API submission failed (${response.status}): ${errorBody}`,
      )
    }

    const data = (await response.json()) as ZooTextToCadResponse
    return data.id
  }

  /**
   * Check the status of a generation request.
   */
  async getGenerationStatus(requestId: string): Promise<ZooTextToCadResponse> {
    const response = await fetch(
      `${ZOO_API_BASE}/async/operations/${requestId}`,
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      },
    )

    if (!response.ok) {
      throw new Error(`Zoo API status check failed (${response.status})`)
    }

    return (await response.json()) as ZooTextToCadResponse
  }

  /**
   * Submit a generation request and poll until completion.
   * Uses exponential backoff: 5s, 10s, 20s, 40s, ...
   */
  async generateAndWait(
    prompt: string,
    outputFormat: 'step' | 'stl' = 'step',
    maxWaitMs?: number,
  ): Promise<{ requestId: string; stepContent: Buffer }> {
    const envTimeout = process.env.ZOO_TEXT_TO_CAD_TIMEOUT_MS
      ? Number(process.env.ZOO_TEXT_TO_CAD_TIMEOUT_MS)
      : undefined
    const timeout = maxWaitMs ?? envTimeout ?? 600_000

    const requestId = await this.submitGeneration(prompt, outputFormat)
    const startTime = Date.now()
    let delay = 5_000 // Start at 5 seconds

    while (Date.now() - startTime < timeout) {
      await sleep(delay)

      const result = await this.getGenerationStatus(requestId)

      if (result.status === 'completed') {
        const stepContent = this.extractFileContent(result)
        return { requestId, stepContent }
      }

      if (result.status === 'failed') {
        throw new Error(
          `Zoo CAD generation failed: ${result.error ?? 'Unknown error'}`,
        )
      }

      // Exponential backoff, cap at 60 seconds
      delay = Math.min(delay * 2, 60_000)
    }

    throw new Error(
      `Zoo CAD generation timed out after ${timeout}ms (requestId: ${requestId})`,
    )
  }

  /**
   * Extract the STEP file content from a completed response.
   */
  private extractFileContent(response: ZooTextToCadResponse): Buffer {
    if (!response.outputs) {
      throw new Error('No outputs in completed Zoo response')
    }

    // The outputs map contains filename -> base64-encoded content
    const entries = Object.entries(response.outputs)
    if (entries.length === 0) {
      throw new Error('Empty outputs in Zoo response')
    }

    // Take the first output file (base64 string)
    const [, base64Content] = entries[0]
    return Buffer.from(base64Content, 'base64')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
