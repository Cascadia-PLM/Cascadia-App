import { Moon, Sun } from 'lucide-react'
import type { ThemeToggleProps } from './types'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'

export function ThemeToggle({ className }: ThemeToggleProps) {
  const { theme, toggleTheme } = useTheme()

  return (
    <button
      onClick={toggleTheme}
      className={cn(
        'p-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors',
        className,
      )}
      aria-label="Toggle theme"
      title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
    >
      {theme === 'light' ? (
        <Moon size={18} className="text-gray-600 dark:text-gray-300" />
      ) : (
        <Sun size={18} className="text-yellow-500 dark:text-yellow-400" />
      )}
    </button>
  )
}
