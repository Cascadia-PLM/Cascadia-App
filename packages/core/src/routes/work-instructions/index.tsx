// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ClipboardCheck, Plus } from 'lucide-react'
import type { WorkInstruction } from '@/lib/items/types/work-instruction'
import type { GridParams, ItemFilters } from '@/lib/query'
import { PageContainer } from '@/components/layout'
import { WorkInstructionTable } from '@/components/work-instructions/WorkInstructionTable'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import {
  itemCountsQuery,
  itemListQuery,
  useInvalidateResources,
} from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

const WORK_INSTRUCTION_FILTERS: ItemFilters = { itemType: 'WorkInstruction' }

// The table paginates client-side, so one fixed page is fetched. Kept at
// module scope so the loader and the component key on the same params.
const WORK_INSTRUCTION_GRID: GridParams = { page: 1, pageSize: 50 }

// The states behind the stat cards, counted in one request rather than one
// probe request each.
const COUNT_STATES = ['Draft', 'InReview', 'Released']

export const Route = createFileRoute('/work-instructions/')({
  component: WorkInstructionsListPage,
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.ensureQueryData(
        itemListQuery<WorkInstruction>(
          WORK_INSTRUCTION_FILTERS,
          WORK_INSTRUCTION_GRID,
        ),
      ),
      queryClient.ensureQueryData(
        itemCountsQuery(WORK_INSTRUCTION_FILTERS, COUNT_STATES),
      ),
    ])
  },
})

function WorkInstructionsListPage() {
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()

  const { data: page } = useQuery(
    itemListQuery<WorkInstruction>(
      WORK_INSTRUCTION_FILTERS,
      WORK_INSTRUCTION_GRID,
    ),
  )
  const { data: counts } = useQuery(
    itemCountsQuery(WORK_INSTRUCTION_FILTERS, COUNT_STATES),
  )

  const workInstructions = page?.items ?? []
  const total = page?.total ?? 0

  const handleEdit = (workInstruction: WorkInstruction) => {
    if (workInstruction.id) {
      navigate({
        to: '/work-instructions/$id',
        params: { id: workInstruction.id },
      })
    }
  }

  const handlePresent = (workInstruction: WorkInstruction) => {
    if (workInstruction.id) {
      navigate({
        to: '/work-instructions/$id/present',
        params: { id: workInstruction.id },
      })
    }
  }

  const handleDelete = (workInstruction: WorkInstruction) => {
    if (!workInstruction.id) return

    confirm({
      title: 'Delete Work Instruction',
      description: `Are you sure you want to delete ${workInstruction.itemNumber}? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/v1/work-instructions/${workInstruction.id}`, {
            method: 'DELETE',
          })

          showSuccess(
            'Work Instruction deleted',
            `${workInstruction.itemNumber} has been deleted`,
          )
          await invalidate('work-instructions')
        } catch (error) {
          handleError(error, { title: 'Failed to delete work instruction' })
        }
      },
    })
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-sky-100 dark:bg-sky-900 rounded-lg">
            <ClipboardCheck className="h-6 w-6 text-sky-600 dark:text-sky-400" />
          </div>
          <div>
            <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
              Work Instructions
            </h1>
            <p className="text-slate-600 dark:text-slate-400 mt-1">
              Step-by-step manufacturing procedures
            </p>
          </div>
        </div>
        <Link to="/work-instructions/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Create Work Instruction
          </Button>
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Total</CardDescription>
            <CardTitle className="text-3xl">{total}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Draft</CardDescription>
            <CardTitle className="text-3xl">{counts?.Draft ?? 0}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>In Review</CardDescription>
            <CardTitle className="text-3xl">{counts?.InReview ?? 0}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Released</CardDescription>
            <CardTitle className="text-3xl">{counts?.Released ?? 0}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Work Instructions Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Work Instructions</CardTitle>
          <CardDescription>
            {total} {total === 1 ? 'work instruction' : 'work instructions'} in
            the system
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WorkInstructionTable
            items={workInstructions}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onPresent={handlePresent}
          />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
