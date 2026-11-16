// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
/**
 * The small forms of the block diagram editor: drawing a line (a new
 * interface, with any ports it needs), editing an interface, adding or
 * editing a port, and adding a block. Each holds only its own field state;
 * the diagram owns the writes.
 */
import { useState } from 'react'
import { ExternalLink, Loader2, Trash2, Unlink, Waypoints } from 'lucide-react'
import {
  INTERFACE_KINDS,
  INTERFACE_KIND_LABELS,
} from '@cascadia/commons/items/types/interface'
import {
  SYSTEM_ELEMENT_KINDS,
  SYSTEM_ELEMENT_KIND_LABELS,
  SYSTEM_PORT_DIRECTIONS,
  SYSTEM_PORT_DIRECTION_LABELS,
} from '@cascadia/commons/items/types/system-element'
import { isInterfaceKind } from './interface-kinds'
import type { ReactNode } from 'react'
import type { InterfaceKind } from '@cascadia/commons/items/types/interface'
import type {
  SystemElementKind,
  SystemPortDirection,
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
import { ItemLink } from '@/components/items/ItemLink'

/** Radix Select has no empty value, so "no kind" needs a stand-in. */
const NO_KIND = 'none'

function FormDialog({
  title,
  description,
  onSubmit,
  onClose,
  children,
}: {
  title: string
  description?: ReactNode
  onSubmit: () => void
  onClose: () => void
  children: ReactNode
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit()
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && (
              <DialogDescription>{description}</DialogDescription>
            )}
          </DialogHeader>
          {children}
        </form>
      </DialogContent>
    </Dialog>
  )
}

function SubmitButton({
  busy,
  disabled,
  children,
}: {
  busy: boolean
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <Button type="submit" disabled={busy || disabled}>
      {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
      {children}
    </Button>
  )
}

function KindSelect({
  id,
  value,
  onChange,
}: {
  id: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_KIND}>Not specified</SelectItem>
        {INTERFACE_KINDS.map((option) => (
          <SelectItem key={option} value={option}>
            {INTERFACE_KIND_LABELS[option]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function DirectionSelect({
  id,
  value,
  onChange,
}: {
  id: string
  value: SystemPortDirection
  onChange: (value: SystemPortDirection) => void
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as SystemPortDirection)}
    >
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SYSTEM_PORT_DIRECTIONS.map((option) => (
          <SelectItem key={option} value={option}>
            {SYSTEM_PORT_DIRECTION_LABELS[option]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ---- Drawing a line -----------------------------------------------------

export interface NewPortValues {
  name: string
  direction: SystemPortDirection
}

/** One end of the line being drawn, as the dialog shows it. */
export interface ConnectEnd {
  elementItemId: string
  /** "SE-000001 Power". */
  elementLabel: string
  /** The existing port the line was dropped on; absent for a new port. */
  port?: { id: string; name: string }
  /** The direction offered for a new port at this end. */
  defaultDirection: SystemPortDirection
}

export interface ConnectFormValues {
  name: string | null
  kind: InterfaceKind | null
  /** One entry per end, in order: the new port's values, or null. */
  newPorts: Array<NewPortValues | null>
}

interface ConnectDialogProps {
  ends: Array<ConnectEnd>
  busy: boolean
  onSubmit: (values: ConnectFormValues) => void
  onClose: () => void
}

/**
 * A new interface between two blocks. An end dropped on an existing port
 * uses it; an end dropped on a block's "new port" point asks for the port's
 * name, and the port is created with the interface.
 */
export function ConnectDialog({
  ends,
  busy,
  onSubmit,
  onClose,
}: ConnectDialogProps) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<string>(NO_KIND)
  const [ports, setPorts] = useState<Array<NewPortValues>>(
    ends.map((end) => ({ name: '', direction: end.defaultDirection })),
  )
  const setPort = (index: number, patch: Partial<NewPortValues>) =>
    setPorts((previous) =>
      previous.map((port, i) => (i === index ? { ...port, ...patch } : port)),
    )
  const missingPortName = ends.some(
    (end, index) => !end.port && !ports[index]?.name.trim(),
  )

  return (
    <FormDialog
      title="New interface"
      description={ends.map((end) => end.elementLabel).join(' ↔ ')}
      onClose={onClose}
      onSubmit={() =>
        onSubmit({
          name: name.trim() || null,
          kind: isInterfaceKind(kind) ? kind : null,
          newPorts: ends.map((end, index) => {
            const port = ports[index]
            return end.port || !port
              ? null
              : { name: port.name.trim(), direction: port.direction }
          }),
        })
      }
    >
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-2">
          <Label htmlFor="interface-name">Interface name</Label>
          <Input
            id="interface-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="28 V bus, CAN, coolant loop…"
            maxLength={200}
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="interface-kind">Kind</Label>
          <KindSelect id="interface-kind" value={kind} onChange={setKind} />
        </div>
      </div>

      {ends.map((end, index) => (
        <div
          key={end.elementItemId}
          className="space-y-2 rounded-md border p-3 dark:border-slate-700"
        >
          <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
            {end.elementLabel}
          </p>
          {end.port ? (
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Port <span className="font-mono">{end.port.name}</span>
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 space-y-1">
                <Label htmlFor={`new-port-name-${index}`}>New port</Label>
                <Input
                  id={`new-port-name-${index}`}
                  value={ports[index]?.name ?? ''}
                  onChange={(event) =>
                    setPort(index, { name: event.target.value })
                  }
                  placeholder="J1, PWR IN…"
                  maxLength={60}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`new-port-direction-${index}`}>Direction</Label>
                <DirectionSelect
                  id={`new-port-direction-${index}`}
                  value={ports[index]?.direction ?? end.defaultDirection}
                  onChange={(direction) => setPort(index, { direction })}
                />
              </div>
            </div>
          )}
        </div>
      ))}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <SubmitButton busy={busy} disabled={missingPortName}>
          Connect
        </SubmitButton>
      </DialogFooter>
    </FormDialog>
  )
}

// ---- Editing an interface -------------------------------------------------

export interface InterfaceFormValues {
  name: string
  kind: InterfaceKind | null
}

interface InterfaceDialogProps {
  item: {
    itemId: string
    itemNumber: string
    name: string | null
    kind: string | null
  }
  /** The interface's ends, each as "SE-000001 Power · J1". */
  ends: Array<{ relationshipId: string; label: string; portMissing: boolean }>
  busy: boolean
  onSubmit: (values: InterfaceFormValues) => void
  onDetach: (relationshipId: string) => void
  onDelete: () => void
  /** Offered for a two-ended line: draw it as a bus so a third end can be attached. */
  onShowAsBus?: () => void
  onClose: () => void
}

export function InterfaceDialog({
  item,
  ends,
  busy,
  onSubmit,
  onDetach,
  onDelete,
  onShowAsBus,
  onClose,
}: InterfaceDialogProps) {
  const [name, setName] = useState(item.name ?? '')
  const [kind, setKind] = useState<string>(
    isInterfaceKind(item.kind) ? item.kind : NO_KIND,
  )
  return (
    <FormDialog
      title={`Interface ${item.itemNumber}`}
      description={
        <ItemLink
          itemType="Interface"
          itemId={item.itemId}
          className="inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400"
        >
          Open the interface's page
          <ExternalLink className="h-3 w-3" />
        </ItemLink>
      }
      onClose={onClose}
      onSubmit={() =>
        onSubmit({
          name: name.trim(),
          kind: isInterfaceKind(kind) ? kind : null,
        })
      }
    >
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-2">
          <Label htmlFor="interface-name">Name</Label>
          <Input
            id="interface-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={200}
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="interface-kind">Kind</Label>
          <KindSelect id="interface-kind" value={kind} onChange={setKind} />
        </div>
      </div>

      <div className="space-y-1">
        <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
          Attached to
        </p>
        {ends.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing yet.</p>
        ) : (
          <ul className="divide-y rounded-md border dark:divide-slate-700 dark:border-slate-700">
            {ends.map((end) => (
              <li
                key={end.relationshipId}
                className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm"
              >
                <span className="truncate">
                  {end.label}
                  {end.portMissing && (
                    <span className="ml-2 text-amber-600 dark:text-amber-400">
                      port no longer exists
                    </span>
                  )}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => onDetach(end.relationshipId)}
                  title="Detach the interface from this port"
                >
                  <Unlink className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {onShowAsBus && (
          <Button
            type="button"
            size="sm"
            variant="link"
            className="px-0"
            onClick={onShowAsBus}
          >
            <Waypoints className="mr-1 h-4 w-4" />
            Show as a bus, to attach another block
          </Button>
        )}
      </div>

      <DialogFooter className="gap-2 sm:justify-between">
        <Button
          type="button"
          variant="outline"
          onClick={onDelete}
          disabled={busy}
          className="text-red-600 dark:text-red-400"
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Delete interface
        </Button>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <SubmitButton busy={busy} disabled={!name.trim()}>
            Save
          </SubmitButton>
        </div>
      </DialogFooter>
    </FormDialog>
  )
}

// ---- Ports ----------------------------------------------------------------

interface PortDialogProps {
  title: string
  /** "SE-000001 Power" — the element the port is on. */
  elementLabel: string
  existing?: { name: string; direction: SystemPortDirection }
  defaultDirection?: SystemPortDirection
  submitLabel: string
  busy: boolean
  onSubmit: (values: NewPortValues) => void
  onDelete?: () => void
  onClose: () => void
}

export function PortDialog({
  title,
  elementLabel,
  existing,
  defaultDirection = 'inout',
  submitLabel,
  busy,
  onSubmit,
  onDelete,
  onClose,
}: PortDialogProps) {
  const [name, setName] = useState(existing?.name ?? '')
  const [direction, setDirection] = useState<SystemPortDirection>(
    existing?.direction ?? defaultDirection,
  )
  return (
    <FormDialog
      title={title}
      description={`On ${elementLabel}`}
      onClose={onClose}
      onSubmit={() => {
        if (name.trim()) onSubmit({ name: name.trim(), direction })
      }}
    >
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-2">
          <Label htmlFor="port-name">Port name</Label>
          <Input
            id="port-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="J1, PWR IN…"
            maxLength={60}
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="port-direction">Direction</Label>
          <DirectionSelect
            id="port-direction"
            value={direction}
            onChange={setDirection}
          />
        </div>
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
              Delete port
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
          <SubmitButton busy={busy} disabled={!name.trim()}>
            {submitLabel}
          </SubmitButton>
        </div>
      </DialogFooter>
    </FormDialog>
  )
}

// ---- Blocks ---------------------------------------------------------------

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
    <FormDialog
      title="Add block"
      description={
        parentLabel
          ? `A new system element inside ${parentLabel}. Its number is assigned automatically.`
          : 'A new top-level system element. Its number is assigned automatically.'
      }
      onClose={onClose}
      onSubmit={() => {
        if (name.trim()) onSubmit({ name: name.trim(), elementKind })
      }}
    >
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
          onValueChange={(value) => setElementKind(value as SystemElementKind)}
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
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <SubmitButton busy={busy} disabled={!name.trim()}>
          Add block
        </SubmitButton>
      </DialogFooter>
    </FormDialog>
  )
}
