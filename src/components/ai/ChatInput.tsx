/**
 * ChatInput - Input component for sending messages
 */

import { useEffect, useRef, useState } from 'react'
import { Search, Send, Square } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

interface ChatInputProps {
  onSend: (message: string) => void
  onSearch?: (message: string) => void
  onStop?: () => void
  isLoading?: boolean
  disabled?: boolean
  placeholder?: string
}

export function ChatInput({
  onSend,
  onSearch,
  onStop,
  isLoading = false,
  disabled = false,
  placeholder = 'Ask a question or request an action...',
}: ChatInputProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`
    }
  }, [value])

  const submitAndClear = (callback: (message: string) => void) => {
    const trimmed = value.trim()
    if (trimmed && !isLoading && !disabled) {
      callback(trimmed)
      setValue('')
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
    }
  }

  const handleSubmit = () => submitAndClear(onSend)
  const handleSearch = () => onSearch && submitAndClear(onSearch)

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
      e.preventDefault()
      handleSubmit()
    } else if (e.key === 'Enter' && e.ctrlKey && onSearch) {
      e.preventDefault()
      handleSearch()
    }
  }

  return (
    <div className="flex gap-2 items-end">
      <div className="flex-1 relative">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled || isLoading}
          rows={1}
          className={cn(
            'w-full resize-none rounded-lg border px-3 py-2 text-sm',
            'bg-white dark:bg-slate-900',
            'border-slate-300 dark:border-slate-700',
            'text-slate-900 dark:text-slate-100',
            'placeholder:text-slate-400 dark:placeholder:text-slate-500',
            'focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            'transition-colors',
            'auto-hide-scroll',
          )}
        />
      </div>

      {isLoading && onStop ? (
        <Button
          type="button"
          onClick={onStop}
          variant="destructive"
          size="icon"
          className="flex-shrink-0"
          aria-label="Stop generation"
        >
          <Square className="h-4 w-4" />
        </Button>
      ) : (
        <div className="flex flex-col gap-1 flex-shrink-0">
          {onSearch && (
            <Button
              type="button"
              onClick={handleSearch}
              disabled={!value.trim() || disabled || isLoading}
              variant="outline"
              size="icon"
              className="h-7 w-7"
              aria-label="Search (Ctrl+Enter)"
              title="Search (Ctrl+Enter)"
            >
              <Search className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!value.trim() || disabled || isLoading}
            size="icon"
            className="h-7 w-7"
            aria-label="Send message"
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  )
}
