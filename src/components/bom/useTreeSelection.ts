import { useCallback, useRef, useState } from 'react'
import type { BOMTreeNode } from './types'

interface UseTreeSelectionOptions {
  /** Filter function to determine if a node can be selected */
  isEligible?: (node: BOMTreeNode) => boolean
}

interface UseTreeSelectionReturn {
  selectedIds: Set<string>
  selectedCount: number
  isAllSelected: boolean
  isIndeterminate: boolean
  handleClick: (
    itemId: string,
    event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ) => void
  handleCheckboxChange: (itemId: string) => void
  selectAll: () => void
  clearSelection: () => void
  isItemSelected: (itemId: string) => boolean
  /** Update the flattened list when nodes or expansion changes */
  setVisibleNodes: (
    nodes: Array<BOMTreeNode>,
    expandedNodes: Set<string>,
  ) => void
}

/**
 * Flatten a tree of BOMTreeNodes into a list respecting expansion state.
 * Only includes nodes that are currently visible (ancestors are expanded).
 */
function flattenVisibleNodes(
  nodes: Array<BOMTreeNode>,
  expandedNodes: Set<string>,
): Array<BOMTreeNode> {
  const result: Array<BOMTreeNode> = []
  const walk = (items: Array<BOMTreeNode>) => {
    for (const node of items) {
      result.push(node)
      if (node.children?.length && expandedNodes.has(node.itemId)) {
        walk(node.children)
      }
    }
  }
  walk(nodes)
  return result
}

/**
 * Hook for multi-select in a BOM tree view.
 *
 * Supports:
 * - Plain click: toggle single item
 * - Ctrl/Cmd+click: toggle single item (same as plain for checkboxes)
 * - Shift+click: select range from last clicked to current
 * - Select all / clear all
 */
export function useTreeSelection(
  options: UseTreeSelectionOptions = {},
): UseTreeSelectionReturn {
  const { isEligible = () => true } = options

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const lastClickedIdRef = useRef<string | null>(null)
  const flatNodesRef = useRef<Array<BOMTreeNode>>([])
  const eligibleCountRef = useRef(0)

  const setVisibleNodes = useCallback(
    (nodes: Array<BOMTreeNode>, expandedNodes: Set<string>) => {
      const flat = flattenVisibleNodes(nodes, expandedNodes)
      flatNodesRef.current = flat
      eligibleCountRef.current = flat.filter(isEligible).length
    },
    [isEligible],
  )

  const handleClick = useCallback(
    (
      itemId: string,
      event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
    ) => {
      // Find the node to check eligibility
      const node = flatNodesRef.current.find((n) => n.itemId === itemId)
      if (!node || !isEligible(node)) return

      if (event.shiftKey && lastClickedIdRef.current) {
        // Range select
        const flat = flatNodesRef.current
        const lastIdx = flat.findIndex(
          (n) => n.itemId === lastClickedIdRef.current,
        )
        const currIdx = flat.findIndex((n) => n.itemId === itemId)

        if (lastIdx !== -1 && currIdx !== -1) {
          const start = Math.min(lastIdx, currIdx)
          const end = Math.max(lastIdx, currIdx)

          setSelectedIds((prev) => {
            const next = new Set(prev)
            for (let i = start; i <= end; i++) {
              const n = flat[i]
              if (isEligible(n)) {
                next.add(n.itemId)
              }
            }
            return next
          })
        }
      } else if (event.ctrlKey || event.metaKey) {
        // Toggle single
        setSelectedIds((prev) => {
          const next = new Set(prev)
          if (next.has(itemId)) {
            next.delete(itemId)
          } else {
            next.add(itemId)
          }
          return next
        })
        lastClickedIdRef.current = itemId
      } else {
        // Plain click: toggle
        setSelectedIds((prev) => {
          const next = new Set(prev)
          if (next.has(itemId)) {
            next.delete(itemId)
          } else {
            next.add(itemId)
          }
          return next
        })
        lastClickedIdRef.current = itemId
      }
    },
    [isEligible],
  )

  const handleCheckboxChange = useCallback(
    (itemId: string) => {
      const node = flatNodesRef.current.find((n) => n.itemId === itemId)
      if (!node || !isEligible(node)) return

      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(itemId)) {
          next.delete(itemId)
        } else {
          next.add(itemId)
        }
        return next
      })
      lastClickedIdRef.current = itemId
    },
    [isEligible],
  )

  const selectAll = useCallback(() => {
    const eligible = flatNodesRef.current.filter(isEligible)
    setSelectedIds(new Set(eligible.map((n) => n.itemId)))
  }, [isEligible])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    lastClickedIdRef.current = null
  }, [])

  const isItemSelected = useCallback(
    (itemId: string) => selectedIds.has(itemId),
    [selectedIds],
  )

  const selectedCount = selectedIds.size
  const eligibleCount = eligibleCountRef.current
  const isAllSelected = eligibleCount > 0 && selectedCount >= eligibleCount
  const isIndeterminate = selectedCount > 0 && selectedCount < eligibleCount

  return {
    selectedIds,
    selectedCount,
    isAllSelected,
    isIndeterminate,
    handleClick,
    handleCheckboxChange,
    selectAll,
    clearSelection,
    isItemSelected,
    setVisibleNodes,
  }
}
