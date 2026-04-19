import { clsx } from 'clsx'
import type { ClassValue } from 'clsx'

/**
 * Utility function to merge class names
 * Useful for conditional styling and merging Tailwind classes
 */
export function cn(...inputs: Array<ClassValue>) {
  return clsx(inputs)
}
