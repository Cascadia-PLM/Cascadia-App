/**
 * ClarificationPrompt - Renders a clarification question in the ActivityFeed
 */

import { useState } from 'react'
import { HelpCircle, Send } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

interface ClarificationPromptProps {
  questionId: string
  question: string
  options?: Array<string>
  onAnswer?: (questionId: string, answer: string) => void
}

export function ClarificationPrompt({
  questionId,
  question,
  options,
  onAnswer,
}: ClarificationPromptProps) {
  const [freeText, setFreeText] = useState('')
  const [answered, setAnswered] = useState(false)

  const handleAnswer = (answer: string) => {
    setAnswered(true)
    onAnswer?.(questionId, answer)
  }

  return (
    <div className="border border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-3 space-y-2">
      <div className="flex items-start gap-2">
        <HelpCircle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 mt-0.5 flex-shrink-0" />
        <p className="text-sm text-slate-700 dark:text-slate-300">{question}</p>
      </div>

      {!answered && (
        <>
          {options && options.length > 0 && (
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
                  handleAnswer(freeText.trim())
                }
              }}
            />
            <Button
              variant="default"
              size="sm"
              onClick={() => freeText.trim() && handleAnswer(freeText.trim())}
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
