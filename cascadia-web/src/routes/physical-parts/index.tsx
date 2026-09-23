// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Package, Plus } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui'
import { PageContainer } from '@/components/layout'
import { physicalPartListQuery, useInvalidateResources } from '@/lib/query'
import { RegisterPhysicalPartDialog } from '@/components/physical-parts/RegisterPhysicalPartDialog'

export const Route = createFileRoute('/physical-parts/')({
  component: PhysicalPartsPage,
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(physicalPartListQuery()),
})

const STATE_COLORS: Record<string, string> = {
  Available:
    'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  Consumed: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  'In Service':
    'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  Scrapped: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
}

const FALLBACK_STATE_COLOR =
  'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300'

function PhysicalPartsPage() {
  const invalidate = useInvalidateResources()
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<'all' | 'unit' | 'lot'>('all')
  const [registerOpen, setRegisterOpen] = useState(false)

  const { data, isLoading } = useQuery(physicalPartListQuery({ q, kind }))

  const rows = data ?? []

  return (
    <PageContainer>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-slate-900 dark:text-white">
          <Package className="h-6 w-6" />
          <h1 className="text-2xl font-semibold">Physical Parts</h1>
        </div>
        <Button onClick={() => setRegisterOpen(true)}>
          <Plus className="mr-1 h-4 w-4" />
          Register
        </Button>
      </div>

      <div className="flex gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search serial, lot, or number…"
          className="max-w-sm"
        />
        <Select
          value={kind}
          onValueChange={(v) => setKind(v as 'all' | 'unit' | 'lot')}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All kinds</SelectItem>
            <SelectItem value="unit">Units</SelectItem>
            <SelectItem value="lot">Lots</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <p className="p-6 text-sm text-slate-500 dark:text-slate-400">
              Loading…
            </p>
          ) : rows.length === 0 ? (
            <p className="p-6 text-sm text-slate-500 dark:text-slate-400">
              No physical parts yet. Register a serialized unit or a lot to
              start tracking real hardware.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Serial / Lot</TableHead>
                  <TableHead>Part</TableHead>
                  <TableHead>State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <Link
                        to="/physical-parts/$id"
                        params={{ id: row.id }}
                        className="font-medium underline-offset-2 hover:underline"
                      >
                        {row.itemNumber}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {row.instanceKind === 'unit' ? 'Unit' : 'Lot'}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono">
                      {row.serialNumber ?? row.lotNumber}
                    </TableCell>
                    <TableCell>
                      <span className="font-medium">{row.partItemNumber}</span>
                      {row.partName && (
                        <span className="ml-2 text-slate-500 dark:text-slate-400">
                          {row.partName}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={
                          STATE_COLORS[row.state] ?? FALLBACK_STATE_COLOR
                        }
                      >
                        {row.state}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <RegisterPhysicalPartDialog
        open={registerOpen}
        onOpenChange={setRegisterOpen}
        onRegistered={() => invalidate('physical-parts')}
      />
    </PageContainer>
  )
}
