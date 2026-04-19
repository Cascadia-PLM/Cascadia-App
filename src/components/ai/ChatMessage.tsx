/**
 * ChatMessage - Individual message display component
 */

import { Bot, ExternalLink, Lightbulb, User } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ConfirmationCard, isConfirmationResult } from './ConfirmationCard'
import type { ConfirmationDetails } from './ConfirmationCard'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

// UI Message part types from TanStack AI
interface TextPart {
  type: 'text'
  content: string
}

interface ToolCallPart {
  type: 'tool-call'
  id: string
  name: string
  arguments: string
  state?: string
}

interface ToolResultPart {
  type: 'tool-result'
  toolCallId: string
  content: string
  state?: string
}

interface ThinkingPart {
  type: 'thinking'
  content: string
}

type MessagePart = TextPart | ToolCallPart | ToolResultPart | ThinkingPart

// Navigation offer from offer_navigation tool
interface NavigationOffer {
  itemNumber: string
  itemName?: string | null
  label?: string
  navigationUrl: string
}

// Design workspace offer from initiate_collaborative_design tool
interface DesignWorkspaceOffer {
  sessionId: string
  workspaceUrl: string
}

interface ChatMessageProps {
  role: 'user' | 'assistant' | 'system'
  parts: Array<MessagePart>
  isStreaming?: boolean
  onNavigate?: (url: string) => void
  onConfirm?: (toolCallId: string, toolName: string, toolArgs: string) => void
  onCancel?: (toolCallId: string) => void
  respondedConfirmations?: Map<string, 'confirmed' | 'cancelled'>
}

export function ChatMessage({
  role,
  parts,
  isStreaming,
  onNavigate,
  onConfirm,
  onCancel,
  respondedConfirmations,
}: ChatMessageProps) {
  const isUser = role === 'user'
  const isAssistant = role === 'assistant'

  // Extract text content from parts
  const textContent = parts
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.content)
    .join('')

  // Build a map of tool call ID → tool call part for cross-referencing
  const toolCallMap = new Map<string, ToolCallPart>()
  for (const part of parts) {
    if (part.type === 'tool-call') {
      toolCallMap.set(part.id, part)
    }
  }

  // Extract tool calls (excluding specially handled tools)
  const toolCalls = parts.filter(
    (part): part is ToolCallPart =>
      part.type === 'tool-call' &&
      part.name !== 'offer_navigation' &&
      part.name !== 'initiate_collaborative_design',
  )

  // Extract navigation offers by matching tool-result parts back to their tool-call
  const navigationOffers: Array<NavigationOffer> = []
  for (const part of parts) {
    if (part.type === 'tool-result') {
      const toolCall = toolCallMap.get(part.toolCallId)
      if (toolCall?.name === 'offer_navigation') {
        // Parse the result from the content string
        let result: { navigationUrl?: string; displayed?: boolean } | undefined
        try {
          result = JSON.parse(part.content)
        } catch {
          // content might not be valid JSON
        }

        // Parse the args from the tool call's arguments string
        let args:
          | {
              itemNumber?: string
              itemName?: string | null
              label?: string
            }
          | undefined
        try {
          args = JSON.parse(toolCall.arguments)
        } catch {
          // arguments might not be valid JSON
        }

        if (result?.navigationUrl && result.displayed) {
          navigationOffers.push({
            itemNumber: args?.itemNumber || 'Item',
            itemName: args?.itemName ?? null,
            label: args?.label,
            navigationUrl: result.navigationUrl,
          })
        }
      }
    }
  }

  // Extract design workspace offers from initiate_collaborative_design tool results
  const designWorkspaceOffers: Array<DesignWorkspaceOffer> = []
  for (const part of parts) {
    if (part.type === 'tool-result') {
      const toolCall = toolCallMap.get(part.toolCallId)
      if (toolCall?.name === 'initiate_collaborative_design') {
        let result:
          | {
              sessionId?: string
              workspaceUrl?: string
              action?: string
            }
          | undefined
        try {
          result = JSON.parse(part.content)
        } catch {
          // content might not be valid JSON
        }

        if (
          result?.action === 'open_design_workspace' &&
          result.sessionId &&
          result.workspaceUrl
        ) {
          designWorkspaceOffers.push({
            sessionId: result.sessionId,
            workspaceUrl: result.workspaceUrl,
          })
        }
      }
    }
  }

  // Extract confirmation requests from tool results
  const confirmationRequests: Array<{
    toolCallId: string
    toolName: string
    toolArgs: string
    message: string
    details?: ConfirmationDetails
  }> = []
  for (const part of parts) {
    if (part.type === 'tool-result') {
      const toolCall = toolCallMap.get(part.toolCallId)
      if (toolCall) {
        let result: unknown
        try {
          result = JSON.parse(part.content)
        } catch {
          // content might not be valid JSON
        }
        if (isConfirmationResult(result)) {
          confirmationRequests.push({
            toolCallId: part.toolCallId,
            toolName: toolCall.name,
            toolArgs: toolCall.arguments,
            message:
              result.confirmationMessage || 'Please confirm this operation.',
            details: result.confirmationDetails,
          })
        }
      }
    }
  }

  if (role === 'system') {
    return null // Don't display system messages
  }

  return (
    <div className={cn('flex gap-3', isUser ? 'flex-row-reverse' : 'flex-row')}>
      {/* Avatar */}
      <div
        className={cn(
          'flex-shrink-0 flex h-8 w-8 items-center justify-center rounded-full',
          isUser
            ? 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300'
            : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
        )}
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>

      {/* Message content */}
      <div
        className={cn(
          'max-w-[80%] rounded-lg px-4 py-2',
          isUser
            ? 'bg-cyan-600 text-white dark:bg-cyan-700'
            : 'bg-slate-100 text-slate-900 dark:bg-slate-700 dark:text-slate-100',
        )}
      >
        {/* Text content */}
        {textContent && (
          <div className="text-sm leading-relaxed">
            {isUser ? (
              // User messages: plain text
              <div className="whitespace-pre-wrap">{textContent}</div>
            ) : (
              // Assistant messages: render markdown
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  // Style markdown elements
                  p: ({ children }) => (
                    <p className="mb-2 last:mb-0">{children}</p>
                  ),
                  ul: ({ children }) => (
                    <ul className="list-disc ml-4 mb-2">{children}</ul>
                  ),
                  ol: ({ children }) => (
                    <ol className="list-decimal ml-4 mb-2">{children}</ol>
                  ),
                  li: ({ children }) => <li className="mb-1">{children}</li>,
                  h1: ({ children }) => (
                    <h1 className="text-lg font-bold mb-2">{children}</h1>
                  ),
                  h2: ({ children }) => (
                    <h2 className="text-base font-bold mb-2">{children}</h2>
                  ),
                  h3: ({ children }) => (
                    <h3 className="text-sm font-bold mb-1">{children}</h3>
                  ),
                  code: ({ className, children, ...props }) => {
                    const isInline = !className
                    return isInline ? (
                      <code
                        className="bg-slate-200 dark:bg-slate-700 px-1 py-0.5 rounded text-xs font-mono"
                        {...props}
                      >
                        {children}
                      </code>
                    ) : (
                      <code
                        className={cn(
                          'block bg-slate-200 dark:bg-slate-700 p-2 rounded text-xs font-mono overflow-x-auto my-2',
                          className,
                        )}
                        {...props}
                      >
                        {children}
                      </code>
                    )
                  },
                  pre: ({ children }) => <pre className="my-2">{children}</pre>,
                  a: ({ href, children }) => {
                    const isInternal = href?.startsWith('/')
                    return (
                      <a
                        href={href}
                        className="text-cyan-600 dark:text-cyan-400 underline"
                        {...(isInternal
                          ? {
                              onClick: (e: React.MouseEvent) => {
                                e.preventDefault()
                                if (href) onNavigate?.(href)
                              },
                            }
                          : {
                              target: '_blank',
                              rel: 'noopener noreferrer',
                            })}
                      >
                        {children}
                      </a>
                    )
                  },
                  strong: ({ children }) => (
                    <strong className="font-semibold">{children}</strong>
                  ),
                  em: ({ children }) => <em className="italic">{children}</em>,
                  blockquote: ({ children }) => (
                    <blockquote className="border-l-2 border-slate-300 dark:border-slate-600 pl-3 my-2 italic">
                      {children}
                    </blockquote>
                  ),
                  table: ({ children }) => (
                    <div className="overflow-x-auto my-2">
                      <table className="min-w-full border-collapse border border-slate-300 dark:border-slate-600 text-xs">
                        {children}
                      </table>
                    </div>
                  ),
                  thead: ({ children }) => (
                    <thead className="bg-slate-200 dark:bg-slate-700">
                      {children}
                    </thead>
                  ),
                  tbody: ({ children }) => <tbody>{children}</tbody>,
                  tr: ({ children }) => (
                    <tr className="border-b border-slate-300 dark:border-slate-600">
                      {children}
                    </tr>
                  ),
                  th: ({ children }) => (
                    <th className="px-2 py-1 text-left font-semibold border border-slate-300 dark:border-slate-600">
                      {children}
                    </th>
                  ),
                  td: ({ children }) => (
                    <td className="px-2 py-1 border border-slate-300 dark:border-slate-600">
                      {children}
                    </td>
                  ),
                }}
              >
                {textContent}
              </ReactMarkdown>
            )}
            {isStreaming && isAssistant && (
              <span className="inline-block w-1 h-4 ml-0.5 bg-current animate-pulse" />
            )}
          </div>
        )}

        {/* Tool calls */}
        {toolCalls.length > 0 && (
          <div className="mt-2 space-y-1">
            {toolCalls.map((tool, index) => (
              <div
                key={index}
                className={cn(
                  'text-xs px-2 py-1 rounded',
                  isUser
                    ? 'bg-cyan-700 text-cyan-100'
                    : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
                )}
              >
                <span className="font-mono">{tool.name}</span>
                {tool.state && tool.state !== 'input-complete' && (
                  <span className="ml-2 text-yellow-500">Running...</span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Confirmation requests */}
        {confirmationRequests.length > 0 &&
          confirmationRequests.map((conf) => {
            const response = respondedConfirmations?.get(conf.toolCallId)
            return (
              <ConfirmationCard
                key={conf.toolCallId}
                message={conf.message}
                details={conf.details}
                onConfirm={() =>
                  onConfirm?.(conf.toolCallId, conf.toolName, conf.toolArgs)
                }
                onCancel={() => onCancel?.(conf.toolCallId)}
                responded={!!response}
                response={response}
              />
            )
          })}

        {/* Navigation offers */}
        {navigationOffers.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {navigationOffers.map((offer, index) => (
              <Button
                key={index}
                variant="outline"
                size="sm"
                onClick={() => onNavigate?.(offer.navigationUrl)}
                className="text-xs gap-1.5 bg-white dark:bg-slate-600 hover:bg-cyan-50 dark:hover:bg-cyan-900/30 border-cyan-300 dark:border-cyan-400 text-cyan-700 dark:text-cyan-300"
              >
                <ExternalLink className="h-3 w-3" />
                {offer.label || `View ${offer.itemNumber}`}
              </Button>
            ))}
          </div>
        )}

        {/* Design workspace offers */}
        {designWorkspaceOffers.length > 0 && (
          <div className="mt-3">
            {designWorkspaceOffers.map((offer) => (
              <Button
                key={offer.sessionId}
                variant="default"
                size="sm"
                onClick={() => onNavigate?.(offer.workspaceUrl)}
                className="gap-2 bg-cyan-600 hover:bg-cyan-700 text-white"
              >
                <Lightbulb className="h-4 w-4" />
                Open Design Workspace
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
