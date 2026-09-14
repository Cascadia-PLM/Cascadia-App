// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { EventTypeSummary, WebhookSubscription } from '@/lib/query'
import {
  Button,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog'
import { programListQuery } from '@/lib/query'

export interface WebhookFormValues {
  name: string
  targetUrl: string
  eventTypes: Array<string>
  /** Null for a subscription that hears every program. */
  programId: string | null
  signed: boolean
  allowInsecure: boolean
}

interface WebhookFormDialogProps {
  open: boolean
  /** Null for a create, the row for an edit. */
  subscription: WebhookSubscription | null
  eventTypes: Array<EventTypeSummary>
  busy?: boolean
  onSubmit: (values: WebhookFormValues) => void
  onClose: () => void
}

/** The select's value for "no program scope". A program id is a UUID, so it cannot collide. */
const EVERY_PROGRAM = 'every-program'

/**
 * Create or edit a subscription.
 *
 * The type filter is a checklist of the catalog rather than free text, because
 * the API refuses an unknown type — a typo there produces a subscription that
 * silently never fires, and nothing later would tell an operator why. An empty
 * selection means every type, which is stated rather than implied.
 *
 * The program scope is a choice among this instance's programs, with "every
 * program" first. It could once be set only through the API.
 */
export function WebhookFormDialog({
  open,
  subscription,
  eventTypes,
  busy = false,
  onSubmit,
  onClose,
}: WebhookFormDialogProps) {
  // Initialised from props once, with no effect syncing them afterwards.
  //
  // An effect would have to depend on `subscription`, which is a new identity on
  // every refetch of the list — so a background refetch while the dialog is open
  // would re-run it and wipe whatever the operator had typed. The call site
  // keys this component on the row and on the open instead, so opening a row —
  // or a second create — remounts it and these initialisers run again. State
  // that is derived from props once is initial state, not synced state.
  const [name, setName] = useState(subscription?.name ?? '')
  const [targetUrl, setTargetUrl] = useState(subscription?.targetUrl ?? '')
  const [selected, setSelected] = useState<Array<string>>(
    subscription?.eventTypes ?? [],
  )
  const [programId, setProgramId] = useState<string | null>(
    subscription?.programId ?? null,
  )
  const [signed, setSigned] = useState(
    subscription ? subscription.secretPrefix !== null : true,
  )
  const [allowInsecure, setAllowInsecure] = useState(
    subscription?.targetUrl.startsWith('http://') ?? false,
  )
  const { data: programs = [] } = useQuery({
    ...programListQuery(),
    enabled: open,
  })

  const toggle = (type: string) =>
    setSelected((current) =>
      current.includes(type)
        ? current.filter((entry) => entry !== type)
        : [...current, type],
    )

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {subscription ? 'Edit subscription' : 'New webhook subscription'}
          </DialogTitle>
          <DialogDescription>
            Deliveries are sent in event order, at least once, and a receiver
            should dedupe on the <code>X-Cascadia-Event-Id</code> header.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="webhook-name">Name</Label>
            <Input
              id="webhook-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="ERP sync"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="webhook-url">Target URL</Label>
            <Input
              id="webhook-url"
              value={targetUrl}
              onChange={(event) => setTargetUrl(event.target.value)}
              placeholder="https://hooks.example.com/cascadia"
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Must be a public address. Private, loopback and link-local targets
              are refused, and redirects are never followed.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="webhook-program">Program</Label>
            <Select
              value={programId ?? EVERY_PROGRAM}
              onValueChange={(value) =>
                setProgramId(value === EVERY_PROGRAM ? null : value)
              }
            >
              <SelectTrigger id="webhook-program">
                <SelectValue placeholder="Every program" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EVERY_PROGRAM}>Every program</SelectItem>
                {programs.map((program) => (
                  <SelectItem key={program.id} value={program.id}>
                    {program.code} - {program.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              A scoped subscription receives only the events it can attribute to
              that program. A change order whose designs span programs is heard
              only by subscriptions for every program.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Event types</Label>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Select none to receive every type, including types added by a
              future release.
            </p>
            <div className="max-h-56 space-y-1 overflow-y-auto rounded border border-slate-300 p-2 dark:border-slate-700">
              {eventTypes.map((type) => (
                <label
                  key={type.type}
                  className="flex items-start gap-2 rounded p-1 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <Checkbox
                    checked={selected.includes(type.type)}
                    onCheckedChange={() => toggle(type.type)}
                  />
                  <span>
                    <span className="font-mono text-xs">{type.type}</span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {type.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          {!subscription && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={signed}
                onCheckedChange={(next) => setSigned(next === true)}
              />
              <span>
                Sign deliveries
                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  Recommended. Creation is refused when the instance has no
                  <code> ENCRYPTION_KEY</code>, rather than storing a signing
                  key in the clear.
                </span>
              </span>
            </label>
          )}

          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={allowInsecure}
              onCheckedChange={(next) => setAllowInsecure(next === true)}
            />
            <span>
              Allow a plaintext <code>http://</code> target
              <span className="block text-xs text-slate-500 dark:text-slate-400">
                Only for a receiver inside your own network. The body and its
                signature are both visible in transit.
              </span>
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy || name.trim() === '' || targetUrl.trim() === ''}
            onClick={() =>
              onSubmit({
                name: name.trim(),
                targetUrl: targetUrl.trim(),
                eventTypes: selected,
                programId,
                signed,
                allowInsecure,
              })
            }
          >
            {subscription ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
