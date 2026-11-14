// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
/**
 * The two small forms of the block diagram editor: naming a connection
 * (when one is drawn, and again when its line is clicked) and adding a
 * block. Both hold only their own field state; the diagram owns the writes.
 */
import { useState } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import {
  SYSTEM_CONNECTION_KINDS,
  SYSTEM_CONNECTION_KIND_LABELS,
  SYSTEM_ELEMENT_KINDS,
  SYSTEM_ELEMENT_KIND_LABELS,
} from '@cascadia/commons/items/types/system-element'
import { isConnectionKind } from './connection-kinds'
import type {
  SystemConnectionKind,
  SystemElementKind,
} from '@cascadia/commons/items/types/system-element'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'

/** Radix Select has no empty value, so "no kind" needs a stand-in. */
const NO_KIND = 'none'

export interface ConnectionFormValues {
  name: string | null
  kind: SystemConnectionKind | null
}

interface ConnectionDialogProps {
  /** "SE-000001 Power" — the element the connection is stated on. */
  sourceLabel: string
  targetLabel: string
  /** The connection being edited; absent when one is being drawn. */
  existing?: { name: string | null; kind: string | null }
  busy: boolean
  onSubmit: (values: ConnectionFormValues) => void
  onDelete?: () => void
  onClose: () => void
}

export function ConnectionDialog({
  sourceLabel,
  targetLabel,
  existing,
  busy,
  onSubmit,
  onDelete,
  onClose,
}: ConnectionDialogProps) {
  const [name, setName] = useState(existing?.name ?? '')
  const [kind, setKind] = useState<string>(
    isConnectionKind(existing?.kind) ? existing.kind : NO_KIND,
  )
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit({
              name: name.trim() || null,
              kind: isConnectionKind(kind) ? kind : null,
            })
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>
              {existing ? 'Edit connection' : 'New connection'}
            </DialogTitle>
            <DialogDescription>
              {sourceLabel} → {targetLabel}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="connection-name">Name</Label>
            <Input
              id="connection-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="28 V bus, CAN, coolant loop… (optional)"
              maxLength={120}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="connection-kind">Kind</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger id="connection-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_KIND}>Not specified</SelectItem>
                {SYSTEM_CONNECTION_KINDS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {SYSTEM_CONNECTION_KIND_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <div>
              {onDelete && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={onDelete}
                  disabled={busy}
                  className="text-red-600 dark:text-red-400"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete connection
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={onClose}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {existing ? 'Save' : 'Connect'}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export interface BlockFormValues {
  name: string
  elementKind: SystemElementKind
}

interface AddBlockDialogProps {
  /** "SE-000001 Power" when the block is added inside another. */
  parentLabel?: string
  /** The kind offered first: one level below the parent's. */
  defaultKind: SystemElementKind
  busy: boolean
  onSubmit: (values: BlockFormValues) => void
  onClose: () => void
}

export function AddBlockDialog({
  parentLabel,
  defaultKind,
  busy,
  onSubmit,
  onClose,
}: AddBlockDialogProps) {
  const [name, setName] = useState('')
  const [elementKind, setElementKind] = useState<SystemElementKind>(defaultKind)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (name.trim()) onSubmit({ name: name.trim(), elementKind })
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>Add block</DialogTitle>
            <DialogDescription>
              {parentLabel
                ? `A new system element inside ${parentLabel}. Its number is assigned automatically.`
                : 'A new top-level system element. Its number is assigned automatically.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="block-name">Name</Label>
            <Input
              id="block-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Power subsystem"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="block-kind">Kind</Label>
            <Select
              value={elementKind}
              onValueChange={(value) =>
                setElementKind(value as SystemElementKind)
              }
            >
              <SelectTrigger id="block-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SYSTEM_ELEMENT_KINDS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {SYSTEM_ELEMENT_KIND_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add block
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
