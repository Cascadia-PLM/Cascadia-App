/**
 * ActivityFeed - Scrolling feed of design engine events
 *
 * Renders StageEvents as a timeline: LLM text as markdown,
 * tool calls/results as compact cards, clarifications as input forms,
 * and user messages as distinct entries.
 *
 * Includes a pinned input bar at the bottom for sending free-form guidance.
 */

import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertCircle,
  ArrowRight,
  Bot,
  CheckCircle,
  Pause,
  Send,
  User,
  Wrench,
} from 'lucide-react'
import { ClarificationPrompt } from './ClarificationPrompt'
import type { DesignSessionStage, StageEvent } from '@/lib/design-engine/types'
import { cn } from '@/lib/utils'

interface ActivityFeedProps {
  events: Array<StageEvent>
  isStreaming: boolean
  onAnswer?: (questionId: string, answer: string) => void
  onSendMessage?: (message: string) => void
  currentStage?: DesignSessionStage
  className?: string
}

export function ActivityFeed({
  events,
  isStreaming,
  onAnswer,
  onSendMessage,
  currentStage,
  className,
}: ActivityFeedProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const [messageInput, setMessageInput] = useState('')

  // Auto-scroll to bottom on new events
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events.length])

  const handleSendMessage = () => {
    const trimmed = messageInput.trim()
    if (!trimmed || !onSendMessage) return
    onSendMessage(trimmed)
    setMessageInput('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  // Show input when in a drafting or review stage and not streaming
  const showInput =
    onSendMessage &&
    currentStage &&
    (currentStage === 'requirements_drafting' ||
      currentStage === 'requirements_review' ||
      currentStage === 'bom_drafting' ||
      currentStage === 'bom_review') &&
    !isStreaming

  // Group consecutive llm_text events for rendering.
  // Non-rendering events like artifact_update shouldn't break text groups.
  const renderedEvents: Array<{
    key: string
    event: StageEvent | { type: 'llm_text_group'; text: string }
  }> = []

  let textBuffer = ''
  let textGroupStart = -1

  // Event types that render visibly and should break text groups
  const breaksTextGroup = (type: string) =>
    type !== 'llm_text' && type !== 'artifact_update'

  for (let i = 0; i < events.length; i++) {
    const event = events[i]

    if (event.type === 'llm_text') {
      if (textGroupStart === -1) textGroupStart = i
      textBuffer += event.text
    } else if (breaksTextGroup(event.type)) {
      // Flush text buffer before visible events
      if (textBuffer) {
        renderedEvents.push({
          key: `text-${textGroupStart}`,
          event: { type: 'llm_text_group', text: textBuffer },
        })
        textBuffer = ''
        textGroupStart = -1
      }
      renderedEvents.push({ key: `event-${i}`, event })
    }
    // artifact_update events are skipped — they don't render
    // and shouldn't split text groups
  }

  // Flush remaining text
  if (textBuffer) {
    renderedEvents.push({
      key: `text-${textGroupStart}`,
      event: { type: 'llm_text_group', text: textBuffer },
    })
  }

  return (
    <div className={cn('flex flex-col overflow-hidden', className)}>
      {/* Scrollable event list */}
      <div className="flex-1 flex flex-col gap-3 overflow-y-auto p-4">
        {renderedEvents.length === 0 && !isStreaming && (
          <div className="text-center text-sm text-slate-400 dark:text-slate-500 py-8">
            Activity will appear here when a stage starts
          </div>
        )}

        {renderedEvents.map(({ key, event }) => {
          if (event.type === 'llm_text_group') {
            return (
              <div key={key} className="flex gap-2">
                <Bot className="h-4 w-4 mt-1 text-slate-400 flex-shrink-0" />
                <div className="text-sm text-slate-700 dark:text-slate-300 prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {event.text.replace(/(?<=[.!?])\s+(?=[A-Z])/g, '  \n')}
                  </ReactMarkdown>
                </div>
              </div>
            )
          }

          if (event.type === 'user_message') {
            return (
              <div key={key} className="flex gap-2 justify-end">
                <div className="text-sm text-slate-700 dark:text-slate-200 bg-cyan-50 dark:bg-cyan-900/30 rounded-lg px-3 py-2 max-w-[80%]">
                  {event.text}
                </div>
                <User className="h-4 w-4 mt-1 text-cyan-500 flex-shrink-0" />
              </div>
            )
          }

          if (event.type === 'stage_change') {
            return (
              <div
                key={key}
                className="flex items-center gap-2 text-xs text-cyan-600 dark:text-cyan-400 font-medium py-1"
              >
                <ArrowRight className="h-3 w-3" />
                Stage: {event.stage.replace(/_/g, ' ')}
              </div>
            )
          }

          if (event.type === 'tool_call') {
            return (
              <div
                key={key}
                className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800 rounded px-2 py-1"
              >
                <Wrench className="h-3 w-3" />
                <span className="font-mono">{event.toolName}</span>
              </div>
            )
          }

          if (event.type === 'tool_result') {
            return (
              <div
                key={key}
                className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800 rounded px-2 py-1"
              >
                <CheckCircle className="h-3 w-3 text-green-500" />
                <span className="font-mono">{event.toolName}</span>
                <span className="text-slate-400">completed</span>
              </div>
            )
          }

          if (event.type === 'clarification_needed') {
            return (
              <ClarificationPrompt
                key={key}
                questionId={event.questionId}
                question={event.question}
                options={event.options}
                onAnswer={onAnswer}
              />
            )
          }

          if (event.type === 'stage_complete') {
            return (
              <div
                key={key}
                className="flex items-center gap-2 text-xs text-green-600 dark:text-green-400 font-medium bg-green-50 dark:bg-green-900/20 rounded px-3 py-2"
              >
                <CheckCircle className="h-4 w-4" />
                {event.summary}
              </div>
            )
          }

          if (event.type === 'error') {
            return (
              <div
                key={key}
                className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded px-3 py-2"
              >
                <AlertCircle className="h-4 w-4" />
                {event.message}
              </div>
            )
          }

          if (event.type === 'paused') {
            return (
              <div
                key={key}
                className="flex items-center gap-2 text-xs text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 rounded px-3 py-2"
              >
                <Pause className="h-4 w-4" />
                {event.reason}
              </div>
            )
          }

          return null
        })}

        {isStreaming && (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="inline-block w-1 h-4 bg-cyan-500 animate-pulse" />
            Processing...
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Pinned input bar */}
      {showInput && (
        <div className="border-t border-slate-200 dark:border-slate-700 p-3 flex gap-2">
          <input
            type="text"
            value={messageInput}
            onChange={(e) => setMessageInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Send guidance to the AI..."
            className="flex-1 text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-1.5 text-slate-700 dark:text-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
          />
          <button
            onClick={handleSendMessage}
            disabled={!messageInput.trim()}
            className="rounded-md bg-cyan-600 hover:bg-cyan-700 disabled:bg-slate-300 dark:disabled:bg-slate-600 p-1.5 text-white transition-colors"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  )
}
