// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  Box,
  CheckCircle2,
  GitBranch,
  Package,
  Plus,
} from 'lucide-react'
import { AddDesignToEcoDialog } from './AddDesignToEcoDialog'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { changeOrderSummaryQuery, useInvalidateResources } from '@/lib/query'
import { useLifecyclePhases } from '@/lib/hooks/useLifecyclePhases'

interface EcoSummaryDashboardProps {
  changeOrderId: string
}

export function EcoSummaryDashboard({
  changeOrderId,
}: EcoSummaryDashboardProps) {
  const invalidate = useInvalidateResources()
  const {
    data: summary,
    isLoading,
    isError,
  } = useQuery(changeOrderSummaryQuery(changeOrderId))
  const [addDesignDialogOpen, setAddDesignDialogOpen] = useState(false)

  const handleDesignAdded = async () => {
    await invalidate('change-orders')
  }

  // Editable while the change order's flow has not ended (non-final state
  // of its Driving workflow)
  const { data: coLifecycle } = useLifecyclePhases('ChangeOrder')
  const coState = summary?.changeOrder.state
  const isEditable =
    Boolean(coState) &&
    !(coLifecycle?.states.find((st) => st.id === coState)?.isFinal ?? false)

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>ECO Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="animate-pulse space-y-4">
            <div className="grid grid-cols-3 gap-4">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-20 bg-slate-100 dark:bg-slate-800 rounded-lg"
                />
              ))}
            </div>
            <div className="h-32 bg-slate-100 dark:bg-slate-800 rounded-lg" />
          </div>
        </CardContent>
      </Card>
    )
  }

  if (isError || !summary) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>ECO Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-slate-500">
            <AlertCircle className="h-5 w-5" />
            <span>
              {isError
                ? 'Unable to load change order summary'
                : 'No summary available'}
            </span>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription className="flex items-center gap-2">
              <Box className="h-4 w-4" />
              Designs Affected
            </CardDescription>
            <CardTitle className="text-3xl">{summary.designs.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription className="flex items-center gap-2">
              <Package className="h-4 w-4" />
              Total Items
            </CardDescription>
            <CardTitle className="text-3xl">
              {summary.totalItemsAffected}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription className="flex items-center gap-2">
              {summary.canSubmit || summary.canRelease ? (
                <CheckCircle2 className="h-4 w-4 text-green-500" />
              ) : (
                <AlertCircle className="h-4 w-4 text-yellow-500" />
              )}
              Status
            </CardDescription>
            <CardTitle className="text-xl">
              {summary.changeOrder.state}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Validation Issues */}
      {summary.validationIssues && summary.validationIssues.length > 0 && (
        <Card className="border-yellow-200 dark:border-yellow-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2 text-yellow-600 dark:text-yellow-400">
              <AlertCircle className="h-5 w-5" />
              Validation Issues
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {summary.validationIssues.map((issue, index) => (
                <li key={index} className="text-slate-600 dark:text-slate-300">
                  • {issue}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Designs Table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Affected Designs</CardTitle>
            <CardDescription>
              Designs and branches associated with this change order
            </CardDescription>
          </div>
          {isEditable && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddDesignDialogOpen(true)}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add Design
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {summary.designs.length > 0 ? (
            <div className="space-y-3">
              {summary.designs.map((design) => (
                <div
                  key={design.designId}
                  className="flex items-center justify-between p-4 rounded-lg border border-slate-300 dark:border-slate-700"
                >
                  <div className="flex items-center gap-4">
                    <Box className="h-5 w-5 text-slate-400" />
                    <div>
                      <Link
                        to="/designs/$id"
                        params={{ id: design.designId }}
                        className="font-medium text-cyan-600 dark:text-cyan-400 hover:underline"
                      >
                        {design.designCode}
                      </Link>
                      <p className="text-sm text-slate-500 dark:text-slate-400">
                        {design.designName}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    {design.branch?.name && (
                      <div className="flex items-center gap-2 text-sm text-slate-500">
                        <GitBranch className="h-4 w-4" />
                        {design.branch.name}
                      </div>
                    )}
                    <div className="text-sm text-slate-500">
                      {design.itemsAffected}{' '}
                      {design.itemsAffected === 1 ? 'item' : 'items'}
                    </div>
                    {design.hasCheckedOutItems && (
                      <Badge variant="warning">checked out</Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-slate-500 dark:text-slate-400">
              <Package className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p className="font-medium">No designs affected yet</p>
              <p className="text-sm mt-1">
                Checkout items to this ECO to see them here
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Design Dialog */}
      <AddDesignToEcoDialog
        open={addDesignDialogOpen}
        onOpenChange={setAddDesignDialogOpen}
        changeOrderId={changeOrderId}
        changeOrderNumber={summary.changeOrder.itemNumber}
        existingDesignIds={summary.designs.map((d) => d.designId)}
        onSuccess={handleDesignAdded}
      />
    </div>
  )
}
