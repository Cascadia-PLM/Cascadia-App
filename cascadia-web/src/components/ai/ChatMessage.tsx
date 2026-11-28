// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * ChatMessage - Individual message display component
 *
 * Renders one turn: the text as markdown, then whatever the turn's tool
 * results add up to — activity lines, confirmation cards, navigation and
 * dialog buttons. The matching of results back to calls is data work and
 * lives in `./message-parts`; this file only draws.
 */

import { Bot, ExternalLink, Lightbulb, User } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ConfirmationCard } from './ConfirmationCard'
import { DIALOG_KIND_META } from './dialogs/dialog-kinds'
import { extractMessageParts } from './message-parts'
import type { MessagePart } from './message-parts'
import type { UIMessage } from '@tanstack/ai-react'
import type { ChatDialogDescriptor } from '@cascadia/commons/ai/dialogs'
import { Button } from '@/components/ui/Button'
import { toAppRelativeUrl } from '@/markdown/url-transform'
import { cn } from '@/utils'

export type { MessagePart } from './message-parts'

interface ChatMessageProps {
  role: UIMessage['role']
  parts: Array<MessagePart>
  isStreaming?: boolean
  onNavigate?: (url: string) => void
  onConfirm?: (toolCallId: string, toolName: string, toolArgs: string) => void
  onCancel?: (toolCallId: string) => void
  onOpenDialog?: (dialog: ChatDialogDescriptor) => void
  respondedConfirmations?: Map<string, 'confirmed' | 'cancelled'>
}

export function ChatMessage({
  role,
  parts,
  isStreaming,
  onNavigate,
  onConfirm,
  onCancel,
  onOpenDialog,
  respondedConfirmations,
}: ChatMessageProps) {
  const isUser = role === 'user'
  const isAssistant = role === 'assistant'

  const {
    textContent,
    toolCalls,
    navigationOffers,
    designWorkspaceOffers,
    confirmationRequests,
    dialogOffers,
  } = extractMessageParts(parts)

  // System prompts are not shown, and an `activity` message is frontend-only
  // AG-UI state this panel has no renderer for.
  if (role === 'system' || role === 'activity') {
    return null
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
                urlTransform={toAppRelativeUrl}
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
                    // `urlTransform` has already emptied every off-origin
                    // href, so what is left is either an in-app route or
                    // nothing to link to. An unlinkable label still reads.
                    if (!href) {
                      return <span>{children}</span>
                    }
                    return (
                      <a
                        href={href}
                        className="text-cyan-600 dark:text-cyan-400 underline"
                        onClick={(e: React.MouseEvent) => {
                          e.preventDefault()
                          onNavigate?.(href)
                        }}
                      >
                        {children}
                      </a>
                    )
                  },
                  img: ({ src, alt }) =>
                    // Same gate, and React warns that an empty `src` can make
                    // the browser re-request the current page — so an image
                    // with nowhere left to point becomes its alt text.
                    src ? (
                      <img src={src} alt={alt ?? ''} className="max-w-full" />
                    ) : (
                      <span>{alt}</span>
                    ),
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
                {/* Only while the call's arguments are still arriving: every
                    later state (complete, error, the approval pair) is a
                    call that has been made. */}
                {(tool.state === 'awaiting-input' ||
                  tool.state === 'input-streaming') && (
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

        {/* Dialog buttons: the full result set, a graph, a form, actions */}
        {dialogOffers.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {dialogOffers.map((offer) => {
              const meta = DIALOG_KIND_META[offer.dialog.kind]
              return (
                <Button
                  key={offer.toolCallId}
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenDialog?.(offer.dialog)}
                  className="text-xs gap-1.5 bg-white dark:bg-slate-600 hover:bg-cyan-50 dark:hover:bg-cyan-900/30 border-cyan-300 dark:border-cyan-400 text-cyan-700 dark:text-cyan-300"
                >
                  <meta.Icon className="h-3 w-3" />
                  {offer.dialog.label ?? meta.label}
                </Button>
              )
            })}
          </div>
        )}

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
