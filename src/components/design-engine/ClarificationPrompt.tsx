/**
 * ClarificationPrompt - Renders a clarification question in the ActivityFeed
 */

import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { HelpCircle, Send } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

interface ClarificationPromptProps {
  questionId: string
  question: string
  options?: Array<string>
  multiSelect?: boolean
  onAnswer?: (questionId: string, answer: string) => void
}

export function ClarificationPrompt({
  questionId,
  question,
  options,
  multiSelect,
  onAnswer,
}: ClarificationPromptProps) {
  const [freeText, setFreeText] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [answered, setAnswered] = useState(false)

  const hasOptions = !!options && options.length > 0
  const useChecklist = hasOptions && multiSelect === true

  const handleAnswer = (answer: string) => {
    if (!answer.trim()) return
    setAnswered(true)
    onAnswer?.(questionId, answer.trim())
  }

  const toggle = (option: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(option)) next.delete(option)
      else next.add(option)
      return next
    })
  }

  const submitChecklist = () => {
    if (selected.size === 0 && !freeText.trim()) return
    const parts: Array<string> = []
    if (selected.size > 0 && options) {
      for (const opt of options) {
        if (selected.has(opt)) parts.push(opt)
      }
    }
    if (freeText.trim()) parts.push(freeText.trim())
    handleAnswer(parts.join(', '))
  }

  return (
    <div className="border border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-3 space-y-3">
      <div className="flex items-start gap-2">
        <HelpCircle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 mt-1 flex-shrink-0" />
        <div className="text-sm text-slate-700 dark:text-slate-200 prose prose-sm dark:prose-invert max-w-none [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{question}</ReactMarkdown>
        </div>
      </div>

      {!answered && useChecklist && (
        <div className="pl-6 space-y-2">
          <div className="flex flex-col gap-1.5">
            {options.map((option) => {
              const isOn = selected.has(option)
              return (
                <label
                  key={option}
                  className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200 cursor-pointer select-none"
                >
                  <input
                    type="checkbox"
                    checked={isOn}
                    onChange={() => toggle(option)}
                    className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-cyan-600 focus:ring-cyan-500"
                  />
                  <span>{option}</span>
                </label>
              )
            })}
          </div>

          <div className="flex gap-2 items-center">
            <Input
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              placeholder="Add a note (optional)…"
              className="text-sm h-8 flex-1"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submitChecklist()
                }
              }}
            />
            <Button
              variant="default"
              size="sm"
              onClick={submitChecklist}
              disabled={selected.size === 0 && !freeText.trim()}
              className="h-8"
            >
              Submit
              <Send className="h-3 w-3 ml-1.5" />
            </Button>
          </div>
        </div>
      )}

      {!answered && !useChecklist && (
        <>
          {hasOptions && (
            <div className="flex flex-wrap gap-2 pl-6">
              {options.map((option) => (
                <Button
                  key={option}
                  variant="outline"
                  size="sm"
                  onClick={() => handleAnswer(option)}
                  className="text-xs"
                >
                  {option}
                </Button>
              ))}
            </div>
          )}

          <div className="flex gap-2 pl-6">
            <Input
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              placeholder="Type your answer..."
              className="text-sm h-8"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && freeText.trim()) {
                  handleAnswer(freeText)
                }
              }}
            />
            <Button
              variant="default"
              size="sm"
              onClick={() => handleAnswer(freeText)}
              disabled={!freeText.trim()}
              className="h-8 px-2"
            >
              <Send className="h-3 w-3" />
            </Button>
          </div>
        </>
      )}

      {answered && (
        <p className="text-xs text-slate-400 pl-6">Answer submitted</p>
      )}
    </div>
  )
}
