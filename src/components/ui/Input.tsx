import { forwardRef, useEffect, useState } from 'react'
import type { InputHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: boolean
  success?: boolean
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    { className, type, error, success, 'aria-invalid': ariaInvalid, ...props },
    ref,
  ) => {
    const [shouldShake, setShouldShake] = useState(false)
    const [showCheck, setShowCheck] = useState(false)

    // Determine if input has error state (from error prop or aria-invalid attribute)
    const hasError = error || ariaInvalid

    // Trigger shake animation when error changes to true
    useEffect(() => {
      if (hasError) {
        setShouldShake(true)
        const timer = setTimeout(() => setShouldShake(false), 500)
        return () => clearTimeout(timer)
      }
    }, [hasError])

    // Show checkmark animation when success changes to true
    useEffect(() => {
      if (success) {
        setShowCheck(true)
      } else {
        setShowCheck(false)
      }
    }, [success])

    return (
      <div className="relative w-full">
        <input
          type={type}
          aria-invalid={ariaInvalid}
          className={cn(
            'flex h-10 w-full rounded-md border border-slate-400 bg-white px-3 py-2 text-sm text-slate-900 ring-offset-white transition-all',
            'file:border-0 file:bg-transparent file:text-sm file:font-medium',
            'placeholder:text-slate-500',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-600 focus-visible:ring-offset-2',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:ring-offset-slate-950 dark:placeholder:text-slate-400',
            '[&:-webkit-autofill]:shadow-[inset_0_0_0px_1000px_rgb(255,255,255)] [&:-webkit-autofill]:[-webkit-text-fill-color:rgb(15,23,42)]',
            'dark:[&:-webkit-autofill]:shadow-[inset_0_0_0px_1000px_rgb(15,23,42)] dark:[&:-webkit-autofill]:[-webkit-text-fill-color:rgb(241,245,249)]',
            hasError && 'border-red-500 focus-visible:ring-red-500',
            success && 'border-green-500 focus-visible:ring-green-500 pr-10',
            shouldShake && 'animate-shake',
            className,
          )}
          ref={ref}
          {...props}
        />

        {/* Success checkmark icon */}
        {showCheck && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <svg
              className="w-5 h-5 text-green-500"
              viewBox="0 0 20 20"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                className="animate-draw-check"
                d="M5 10l3 3 7-7"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        )}
      </div>
    )
  },
)

Input.displayName = 'Input'

export { Input }
