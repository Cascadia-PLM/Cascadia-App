// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * What a chat turn's parts add up to.
 *
 * TanStack AI hands the panel a message as a list of text, tool-call and
 * tool-result parts. Everything the panel draws besides the text — a
 * navigation button, a confirmation card, a dialog button — is a tool result
 * matched back to the call that produced it. This module does that matching
 * once, as data, so `ChatMessage` only renders.
 */

import { dialogDescriptorOf } from '@cascadia/commons/ai/dialogs'
import { isConfirmationResult } from './ConfirmationCard'
import type { ConfirmationDetails } from './ConfirmationCard'
import type { ChatDialogDescriptor } from '@cascadia/commons/ai/dialogs'
import type { UIMessage } from '@tanstack/ai-react'

/**
 * A part of a chat message, as TanStack AI's `useChat` hands it over. Taken
 * from the library's own type rather than restated: the union grows with the
 * library (media, activity, structured output), and a hand-written copy here
 * is what stops a message from type-checking the day it does.
 */
export type MessagePart = UIMessage['parts'][number]

export type TextPart = Extract<MessagePart, { type: 'text' }>
export type ToolCallPart = Extract<MessagePart, { type: 'tool-call' }>
export type ToolResultPart = Extract<MessagePart, { type: 'tool-result' }>

/** From `offer_navigation`. */
export interface NavigationOffer {
  itemNumber: string
  itemName?: string | null
  label?: string
  navigationUrl: string
}

/** From `initiate_collaborative_design`. */
export interface DesignWorkspaceOffer {
  sessionId: string
  workspaceUrl: string
}

/** A write tool's preview, awaiting Confirm or Cancel. */
export interface ConfirmationRequest {
  toolCallId: string
  toolName: string
  toolArgs: string
  message: string
  details?: ConfirmationDetails
  /**
   * The preview's server-issued token. The panel sends it back with the
   * user's answer; until it has, the server will not execute the write.
   */
  confirmationToken?: string
}

/** Any tool result carrying a dialog descriptor. */
export interface DialogOffer {
  toolCallId: string
  toolName: string
  dialog: ChatDialogDescriptor
}

export interface ExtractedMessage {
  textContent: string
  /** Tool calls to list as activity — the ones with their own affordance are left out. */
  toolCalls: Array<ToolCallPart>
  navigationOffers: Array<NavigationOffer>
  designWorkspaceOffers: Array<DesignWorkspaceOffer>
  confirmationRequests: Array<ConfirmationRequest>
  dialogOffers: Array<DialogOffer>
}

/** Tools whose result renders as its own button rather than as an activity line. */
const AFFORDANCE_TOOLS = new Set([
  'offer_navigation',
  'initiate_collaborative_design',
  'request_user_input',
  'suggest_actions',
])

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function extractMessageParts(
  parts: Array<MessagePart>,
): ExtractedMessage {
  const textContent = parts
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.content)
    .join('')

  const toolCallMap = new Map<string, ToolCallPart>()
  for (const part of parts) {
    if (part.type === 'tool-call') toolCallMap.set(part.id, part)
  }

  const toolCalls = parts.filter(
    (part): part is ToolCallPart =>
      part.type === 'tool-call' && !AFFORDANCE_TOOLS.has(part.name),
  )

  const navigationOffers: Array<NavigationOffer> = []
  const designWorkspaceOffers: Array<DesignWorkspaceOffer> = []
  const confirmationRequests: Array<ConfirmationRequest> = []
  const dialogOffers: Array<DialogOffer> = []

  for (const part of parts) {
    if (part.type !== 'tool-result') continue
    const toolCall = toolCallMap.get(part.toolCallId)
    if (!toolCall) continue
    // A server tool's result is its JSON; a multimodal result (content
    // parts) is not one of ours and carries nothing to draw.
    if (typeof part.content !== 'string') continue
    const result = parseJson(part.content)

    if (toolCall.name === 'offer_navigation') {
      const offer = result as
        { navigationUrl?: string; displayed?: boolean } | undefined
      const args = parseJson(toolCall.arguments) as
        | { itemNumber?: string; itemName?: string | null; label?: string }
        | undefined
      if (offer?.navigationUrl && offer.displayed) {
        navigationOffers.push({
          itemNumber: args?.itemNumber || 'Item',
          itemName: args?.itemName ?? null,
          label: args?.label,
          navigationUrl: offer.navigationUrl,
        })
      }
    }

    if (toolCall.name === 'initiate_collaborative_design') {
      const offer = result as
        | { sessionId?: string; workspaceUrl?: string; action?: string }
        | undefined
      if (
        offer?.action === 'open_design_workspace' &&
        offer.sessionId &&
        offer.workspaceUrl
      ) {
        designWorkspaceOffers.push({
          sessionId: offer.sessionId,
          workspaceUrl: offer.workspaceUrl,
        })
      }
    }

    if (isConfirmationResult(result)) {
      confirmationRequests.push({
        toolCallId: part.toolCallId,
        toolName: toolCall.name,
        toolArgs: toolCall.arguments,
        message: result.confirmationMessage || 'Please confirm this operation.',
        details: result.confirmationDetails,
        confirmationToken: result.confirmationToken,
      })
    }

    const dialog = dialogDescriptorOf(result)
    if (dialog) {
      dialogOffers.push({
        toolCallId: part.toolCallId,
        toolName: toolCall.name,
        dialog,
      })
    }
  }

  return {
    textContent,
    toolCalls,
    navigationOffers,
    designWorkspaceOffers,
    confirmationRequests,
    dialogOffers,
  }
}
