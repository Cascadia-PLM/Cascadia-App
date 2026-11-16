// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { z } from 'zod'
import type { InterfaceItem } from '@cascadia/commons/items/types/interface'
import { InterfaceDetail } from '@/components/interfaces/InterfaceDetail'
import { useErrorHandler } from '@/hooks/useErrorHandler'
import { designListQuery, useInvalidateResources } from '@/query'
import { apiFetch } from '@/api/client'

// The design the interface belongs to and the branch the caller was
// viewing — the new interface lands there.
const newInterfaceSearchSchema = z.object({
  designId: z.string().uuid().optional(),
  branch: z.string().uuid().optional(),
})

export const Route = createFileRoute('/interfaces/new')({
  validateSearch: newInterfaceSearchSchema,
  component: NewInterfacePage,
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(designListQuery()),
})

function NewInterfacePage() {
  const navigate = useNavigate()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const { data: designs = [] } = useQuery(designListQuery())
  const searchParams = Route.useSearch()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSave = async (iface: InterfaceItem, branchId?: string) => {
    setIsSubmitting(true)
    try {
      const payload = {
        ...iface,
        itemType: 'Interface',
        ...(branchId && { branchId }),
      }
      const result = await apiFetch<{ data: { item: InterfaceItem } }>(
        '/api/v1/items',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      )
      const created = result.data.item
      showSuccess(
        'Interface created',
        `${created.itemNumber} has been created successfully`,
      )
      await invalidate('interfaces')
      navigate({
        to: '/interfaces/$id',
        params: { id: created.id! },
        search: branchId ? { branch: branchId } : {},
      })
    } catch (error) {
      handleError(error, { title: 'Failed to create interface' })
      throw error
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    navigate({ to: '/interfaces' })
  }

  return (
    <InterfaceDetail
      designs={designs}
      defaultDesignId={searchParams.designId}
      defaultBranchId={searchParams.branch}
      onSave={handleSave}
      onCancel={handleCancel}
      isSubmitting={isSubmitting}
    />
  )
}
