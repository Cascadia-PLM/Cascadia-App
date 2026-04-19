import { ChevronDown, ChevronRight, Link2 } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { getStateBadgeVariant } from './helpers'
import type { ReactNode } from 'react'

import type { BOMTreeNode } from './types'
import type { FilterType } from '@/components/ui/ColumnFilter'
import { Badge, Checkbox } from '@/components/ui'
import { ColumnFilterPopover } from '@/components/ui/ColumnFilter'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@/components/ui/ContextMenu'
import { cn } from '@/lib/utils'

export interface BomTreeViewProps<T extends BOMTreeNode> {
  nodes: Array<T>
  expandedNodes: Set<string>
  onToggle: (itemId: string) => void

  // Layout configuration
  layout?: 'grid' | 'flow'
  columns?: Array<ColumnDefinition>

  // Customization render props
  renderNodeDecorations?: (node: T) => ReactNode
  renderActions?: (node: T) => ReactNode
  renderContextMenu?: (node: T) => ReactNode

  // Display options
  readOnly?: boolean
  showExternalBadge?: boolean
  showQuantity?: boolean
  indentPx?: number

  // Selection props (optional, grid layout only)
  showCheckboxes?: boolean
  selectedIds?: Set<string>
  onSelectionClick?: (
    itemId: string,
    event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ) => void
  onCheckboxChange?: (itemId: string) => void
  isItemSelectable?: (node: T) => boolean
  onSelectAll?: () => void
  isAllSelected?: boolean
  isIndeterminate?: boolean

  // Column filter props (optional, grid layout only)
  columnFilters?: Record<string, unknown>
  onColumnFilterChange?: (columnId: string, value: unknown) => void

  // Styling
  className?: string
}

export interface ColumnDefinition<T extends BOMTreeNode = BOMTreeNode> {
  id: string
  label: string
  width: string
  minWidth?: number // Minimum width in px during resize (default: 40)
  align?: 'left' | 'center' | 'right'
  renderCell?: (node: T) => ReactNode
  showOnHover?: boolean
  // Column filter configuration
  filterType?: FilterType
  filterOptions?: Array<{ label: string; value: string }>
  filterPlaceholder?: string
}

export function BomTreeView<T extends BOMTreeNode>({
  nodes,
  expandedNodes,
  onToggle,
  layout = 'flow',
  columns,
  renderNodeDecorations,
  renderActions,
  renderContextMenu,
  readOnly = false,
  showExternalBadge = true,
  showQuantity = true,
  indentPx = 16,
  showCheckboxes = false,
  selectedIds,
  onSelectionClick,
  onCheckboxChange,
  isItemSelectable,
  onSelectAll,
  isAllSelected = false,
  isIndeterminate = false,
  columnFilters,
  onColumnFilterChange,
  className,
}: BomTreeViewProps<T>) {
  // Column resize state — empty until first resize, then pixel widths
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({})
  const [openFilters, setOpenFilters] = useState<Record<string, boolean>>({})
  const headerRef = useRef<HTMLDivElement>(null)
  const hasResized = Object.keys(columnWidths).length > 0

  // Measure all columns from the DOM, returns current pixel widths
  const measureColumns = useCallback(() => {
    if (!headerRef.current || !columns) return {}
    const widths: Record<string, number> = {}
    // Skip the checkbox column when measuring — it's outside the columns array
    const offset = showCheckboxes ? 1 : 0
    const cells = headerRef.current.children
    columns.forEach((col, i) => {
      const cell = cells[i + offset] as HTMLElement | undefined
      if (cell) widths[col.id] = cell.getBoundingClientRect().width
    })
    return widths
  }, [columns, showCheckboxes])

  // Start column resize drag
  const handleResizeStart = useCallback(
    (colId: string, e: React.MouseEvent) => {
      e.preventDefault()

      // Snapshot current widths from DOM if this is the first resize
      let widths = columnWidths
      if (!hasResized) {
        widths = measureColumns()
        setColumnWidths(widths)
      }

      const minW = columns?.find((c) => c.id === colId)?.minWidth ?? 40
      const startX = e.clientX
      const startWidth = widths[colId] ?? 100

      const onMouseMove = (moveE: MouseEvent) => {
        const delta = moveE.clientX - startX
        const newWidth = Math.max(minW, startWidth + delta)
        setColumnWidths((prev) => ({ ...prev, [colId]: newWidth }))
      }

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [columnWidths, hasResized, measureColumns, columns],
  )

  if (layout === 'grid' && columns) {
    return (
      <div
        className={cn(
          'border rounded-lg dark:border-slate-700 overflow-hidden',
          className,
        )}
      >
        {/* Header row */}
        <div
          ref={headerRef}
          className="flex items-center h-7 bg-slate-50 dark:bg-slate-800 border-b dark:border-slate-700 px-2 text-xs font-medium text-slate-600 dark:text-slate-400"
        >
          {showCheckboxes && (
            <div className="w-7 flex-shrink-0 flex items-center justify-center">
              <Checkbox
                checked={isIndeterminate ? 'indeterminate' : isAllSelected}
                onCheckedChange={() => onSelectAll?.()}
                aria-label="Select all"
                className="h-3.5 w-3.5"
              />
            </div>
          )}
          {columns.map((col) => (
            <div
              key={col.id}
              className={cn(
                'relative select-none overflow-hidden',
                !hasResized && col.width,
                col.align === 'center' && 'text-center',
                col.align === 'right' && 'text-right',
              )}
              style={
                hasResized
                  ? {
                      width: columnWidths[col.id],
                      flexShrink: 0,
                      flexGrow: 0,
                    }
                  : undefined
              }
            >
              <div className="flex items-center gap-1">
                <span>{col.label}</span>
                {col.filterType && onColumnFilterChange && (
                  <ColumnFilterPopover
                    filterType={col.filterType}
                    value={columnFilters?.[col.id]}
                    onChange={(v) => onColumnFilterChange(col.id, v)}
                    options={col.filterOptions}
                    placeholder={col.filterPlaceholder}
                    columnHeader={col.label}
                    open={openFilters[col.id] || false}
                    onOpenChange={(isOpen) =>
                      setOpenFilters((prev) => ({ ...prev, [col.id]: isOpen }))
                    }
                  />
                )}
              </div>
              {/* Resize handle */}
              <div
                className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-blue-400/50 active:bg-blue-500/50 z-10"
                onMouseDown={(e) => handleResizeStart(col.id, e)}
              />
            </div>
          ))}
        </div>

        {/* Tree rows */}
        <div>
          {nodes.map((node) => (
            <BomTreeNodeGrid
              key={node.itemId}
              node={node}
              depth={0}
              expandedNodes={expandedNodes}
              onToggle={onToggle}
              columns={columns}
              columnWidths={hasResized ? columnWidths : undefined}
              renderNodeDecorations={renderNodeDecorations}
              renderActions={renderActions}
              renderContextMenu={renderContextMenu}
              showExternalBadge={showExternalBadge}
              showQuantity={showQuantity}
              indentPx={indentPx}
              readOnly={readOnly}
              showCheckboxes={showCheckboxes}
              selectedIds={selectedIds}
              onSelectionClick={onSelectionClick}
              onCheckboxChange={onCheckboxChange}
              isItemSelectable={isItemSelectable}
            />
          ))}
        </div>
      </div>
    )
  }

  // Flow layout
  return (
    <div className={cn('border rounded-lg dark:border-slate-700', className)}>
      {nodes.map((node) => (
        <BomTreeNodeFlow
          key={node.itemId}
          node={node}
          depth={0}
          expandedNodes={expandedNodes}
          onToggle={onToggle}
          renderNodeDecorations={renderNodeDecorations}
          renderActions={renderActions}
          showExternalBadge={showExternalBadge}
          showQuantity={showQuantity}
          indentPx={indentPx}
          readOnly={readOnly}
        />
      ))}
    </div>
  )
}

// Grid layout node
interface BomTreeNodeGridProps<T extends BOMTreeNode> {
  node: T
  depth: number
  expandedNodes: Set<string>
  onToggle: (itemId: string) => void
  columns: Array<ColumnDefinition>
  columnWidths?: Record<string, number>
  renderNodeDecorations?: (node: T) => ReactNode
  renderActions?: (node: T) => ReactNode
  renderContextMenu?: (node: T) => ReactNode
  showExternalBadge: boolean
  showQuantity: boolean
  indentPx: number
  readOnly: boolean
  showCheckboxes?: boolean
  selectedIds?: Set<string>
  onSelectionClick?: (
    itemId: string,
    event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ) => void
  onCheckboxChange?: (itemId: string) => void
  isItemSelectable?: (node: T) => boolean
}

function BomTreeNodeGrid<T extends BOMTreeNode>({
  node,
  depth,
  expandedNodes,
  onToggle,
  columns,
  columnWidths,
  renderNodeDecorations,
  renderActions,
  renderContextMenu,
  showExternalBadge,
  showQuantity,
  indentPx,
  readOnly,
  showCheckboxes,
  selectedIds,
  onSelectionClick,
  onCheckboxChange,
  isItemSelectable,
}: BomTreeNodeGridProps<T>) {
  const hasChildren = node.children && node.children.length > 0
  const isExpanded = expandedNodes.has(node.itemId)
  const indentSize = depth * indentPx

  const isSelected = selectedIds?.has(node.itemId) ?? false
  const isSelectable = isItemSelectable ? isItemSelectable(node) : true

  const colStyle = (col: ColumnDefinition): React.CSSProperties =>
    columnWidths?.[col.id] !== undefined
      ? {
          width: columnWidths[col.id],
          flexShrink: 0,
          flexGrow: 0,
          overflow: 'hidden',
        }
      : { overflow: 'hidden' }

  const handleRowClick = (e: React.MouseEvent) => {
    if (!showCheckboxes || !onSelectionClick) return
    // Only handle selection on shift/ctrl clicks on the row itself
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      e.preventDefault()
      onSelectionClick(node.itemId, {
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
      })
    }
  }

  const rowContent = (
    <div
      className={cn(
        'flex items-center h-7 px-2 border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 group text-sm',
        isSelected &&
          'bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/30',
      )}
      onClick={handleRowClick}
    >
      {showCheckboxes && (
        <div className="w-7 flex-shrink-0 flex items-center justify-center">
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => onCheckboxChange?.(node.itemId)}
            disabled={!isSelectable}
            aria-label={`Select ${node.itemNumber}`}
            className="h-3.5 w-3.5"
          />
        </div>
      )}
      {columns.map((col, colIndex) => {
        // First column: tree indent + chevron + renderCell content
        if (colIndex === 0) {
          return (
            <div
              key={col.id}
              className={cn(
                !columnWidths && col.width,
                'flex items-center gap-1.5 min-w-0',
              )}
              style={colStyle(col)}
            >
              <div style={{ width: indentSize, flexShrink: 0 }} />

              <button
                onClick={() => onToggle(node.itemId)}
                className={cn(
                  'p-0.5 hover:bg-slate-200 dark:hover:bg-slate-700 rounded flex-shrink-0',
                  !hasChildren && 'invisible',
                )}
                disabled={!hasChildren}
              >
                {isExpanded ? (
                  <ChevronDown className="h-3 w-3 text-slate-500" />
                ) : (
                  <ChevronRight className="h-3 w-3 text-slate-500" />
                )}
              </button>

              {col.renderCell ? (
                col.renderCell(node)
              ) : (
                <>
                  <span className="font-medium text-slate-900 dark:text-white truncate">
                    {node.itemNumber}
                  </span>
                  {showExternalBadge && node.isExternal && node.designCode && (
                    <Badge
                      variant="outline"
                      className="text-xs text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-600 flex-shrink-0"
                      title={`From ${node.designName || node.designCode}`}
                    >
                      <Link2 className="h-3 w-3 mr-1" />
                      {node.designCode}
                    </Badge>
                  )}
                  {showQuantity && node.quantity && node.quantity > 1 && (
                    <span className="text-xs text-slate-400 flex-shrink-0">
                      x{node.quantity}
                    </span>
                  )}
                </>
              )}
            </div>
          )
        }

        // Other columns: renderCell with alignment and hover support
        return (
          <div
            key={col.id}
            className={cn(
              !columnWidths && col.width,
              col.align === 'center' && 'flex justify-center',
              col.align === 'right' && 'flex justify-end',
              col.showOnHover &&
                'opacity-0 group-hover:opacity-100 flex items-center justify-end gap-1',
            )}
            style={colStyle(col)}
          >
            {col.renderCell?.(node)}
          </div>
        )
      })}
    </div>
  )

  return (
    <>
      {renderContextMenu ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>{rowContent}</ContextMenuTrigger>
          <ContextMenuContent>{renderContextMenu(node)}</ContextMenuContent>
        </ContextMenu>
      ) : (
        rowContent
      )}

      {/* Children rows */}
      {hasChildren && isExpanded && (
        <>
          {node.children!.map((child) => (
            <BomTreeNodeGrid
              key={child.itemId}
              node={child as T}
              depth={depth + 1}
              expandedNodes={expandedNodes}
              onToggle={onToggle}
              columns={columns}
              columnWidths={columnWidths}
              renderNodeDecorations={renderNodeDecorations}
              renderActions={renderActions}
              renderContextMenu={renderContextMenu}
              showExternalBadge={showExternalBadge}
              showQuantity={showQuantity}
              indentPx={indentPx}
              readOnly={readOnly}
              showCheckboxes={showCheckboxes}
              selectedIds={selectedIds}
              onSelectionClick={onSelectionClick}
              onCheckboxChange={onCheckboxChange}
              isItemSelectable={isItemSelectable}
            />
          ))}
        </>
      )}
    </>
  )
}

// Flow layout node
interface BomTreeNodeFlowProps<T extends BOMTreeNode> {
  node: T
  depth: number
  expandedNodes: Set<string>
  onToggle: (itemId: string) => void
  renderNodeDecorations?: (node: T) => ReactNode
  renderActions?: (node: T) => ReactNode
  showExternalBadge: boolean
  showQuantity: boolean
  indentPx: number
  readOnly: boolean
}

function BomTreeNodeFlow<T extends BOMTreeNode>({
  node,
  depth,
  expandedNodes,
  onToggle,
  renderNodeDecorations,
  renderActions,
  showExternalBadge,
  showQuantity,
  indentPx,
  readOnly,
}: BomTreeNodeFlowProps<T>) {
  const hasChildren = node.children && node.children.length > 0
  const isExpanded = expandedNodes.has(node.itemId)
  const paddingLeft = depth * indentPx + 8

  return (
    <div>
      <div
        className="flex items-center h-8 gap-1.5 px-2 border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 group text-sm"
        style={{ paddingLeft }}
      >
        {/* Expand/collapse button */}
        <button
          onClick={() => onToggle(node.itemId)}
          className={`p-0.5 hover:bg-slate-200 dark:hover:bg-slate-700 rounded ${!hasChildren ? 'invisible' : ''}`}
          disabled={!hasChildren}
        >
          {isExpanded ? (
            <ChevronDown className="h-3 w-3 text-slate-500" />
          ) : (
            <ChevronRight className="h-3 w-3 text-slate-500" />
          )}
        </button>

        {/* Item info */}
        <div className="flex-1 flex items-center gap-2 min-w-0">
          <span className="font-medium text-slate-900 dark:text-white">
            {node.itemNumber}
          </span>

          {/* External design badge */}
          {showExternalBadge && node.isExternal && node.designCode && (
            <Badge
              variant="outline"
              className="text-xs text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-600"
              title={`From ${node.designName || node.designCode}`}
            >
              <Link2 className="h-3 w-3 mr-1" />
              {node.designCode}
            </Badge>
          )}

          <span className="text-slate-600 dark:text-slate-400 truncate">
            {node.name}
          </span>

          <span className="text-xs text-slate-500">Rev {node.revision}</span>

          <Badge variant={getStateBadgeVariant(node.state)} className="text-xs">
            {node.state}
          </Badge>

          {/* Custom decorations */}
          {renderNodeDecorations?.(node)}

          {/* Quantity indicator */}
          {showQuantity && node.quantity && node.quantity > 1 && (
            <span className="text-xs text-slate-400">x{node.quantity}</span>
          )}
        </div>

        {/* Actions - visible on hover */}
        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1">
          {renderActions?.(node)}
          {hasChildren && (
            <span className="text-xs text-slate-400">
              {node.children!.length}
            </span>
          )}
        </div>
      </div>

      {/* Children */}
      {hasChildren && isExpanded && (
        <div>
          {node.children!.map((child) => (
            <BomTreeNodeFlow
              key={child.itemId}
              node={child as T}
              depth={depth + 1}
              expandedNodes={expandedNodes}
              onToggle={onToggle}
              renderNodeDecorations={renderNodeDecorations}
              renderActions={renderActions}
              showExternalBadge={showExternalBadge}
              showQuantity={showQuantity}
              indentPx={indentPx}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}
    </div>
  )
}
