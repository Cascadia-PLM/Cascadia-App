import { Link } from '@tanstack/react-router'
import { Box } from 'lucide-react'
import type { ProgramGraphDesign } from '@/lib/versioning/graph-types'

interface DesignColumnHeaderProps {
  design: ProgramGraphDesign
  /** Left position in pixels */
  x: number
  /** Width of the column in pixels */
  width: number
}

/**
 * Header component displayed above each design column in the program history graph.
 * Shows the design code (linked to design page), name, and a badge.
 */
export function DesignColumnHeader({
  design,
  x,
  width,
}: DesignColumnHeaderProps) {
  return (
    <div
      className="absolute top-0 flex flex-col items-center justify-center p-2 bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm border-b border-slate-300 dark:border-slate-700 z-10"
      style={{
        left: x,
        width,
        height: 60,
      }}
    >
      <Link
        to="/designs/$id"
        params={{ id: design.id }}
        className="flex items-center gap-2 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
      >
        <Box className="h-4 w-4 text-slate-400" />
        <span className="font-semibold text-sm text-slate-900 dark:text-white">
          {design.code}
        </span>
      </Link>
      <span className="text-xs text-slate-500 dark:text-slate-400 truncate max-w-full">
        {design.name}
      </span>
    </div>
  )
}

interface DesignColumnHeadersProps {
  designs: Array<ProgramGraphDesign>
  columnWidth: number
  columnGap: number
}

/**
 * Renders headers for all design columns in the program history graph.
 */
export function DesignColumnHeaders({
  designs,
  columnWidth,
  columnGap,
}: DesignColumnHeadersProps) {
  return (
    <>
      {designs.map((design, index) => (
        <DesignColumnHeader
          key={design.id}
          design={design}
          x={index * (columnWidth + columnGap)}
          width={columnWidth}
        />
      ))}
    </>
  )
}
