import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import type { BreadcrumbLinkProps } from './breadcrumb-types'

/**
 * BreadcrumbLink - A single breadcrumb segment with optional chevron separator.
 */
export function BreadcrumbLink({
  to,
  params,
  label,
  showChevron = false,
}: BreadcrumbLinkProps) {
  return (
    <>
      <Link
        to={to}
        params={params}
        className="text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
      >
        {label}
      </Link>
      {showChevron && <ChevronRight className="h-4 w-4 text-slate-400" />}
    </>
  )
}
