// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  Edit,
  ExternalLink,
  GitBranch,
  Loader2,
  Lock,
  Save,
  Trash2,
  X,
} from 'lucide-react'
import { BuildArtifactCard } from './BuildArtifactCard'
import { SourceViewer } from './SourceViewer'
import type { Software } from '@/lib/items/types/software'
import type { Design } from '@/lib/types/design'
import { PageContainer } from '@/components/layout'
import {
  AttributesEditor,
  formatAttributeValue,
} from '@/components/items/AttributesEditor'
import { ItemHistoryTab } from '@/components/items/ItemHistoryTab'
import { CheckoutDialog } from '@/components/items/CheckoutDialog'
import { useVersionContext } from '@/lib/hooks/useVersionContext'
import { useEditLock, useItemEditContext } from '@/lib/hooks/useEditLock'
import { WorkspaceContextBanner } from '@/components/workspaces/WorkspaceContextBanner'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  ViewEditSelect,
  ViewEditStatic,
  ViewEditText,
  ViewEditTextarea,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { StateBadge } from '@/components/items/StateBadge'
import { useReleasedFamily } from '@/lib/hooks/useReleasedFamily'
import { ItemCreateDesignSection } from '@/components/items/ItemCreateDesignSection'
import { itemAtContextQuery } from '@/lib/query/options/items'
import { branchDetailQuery, designStatusQuery } from '@/lib/query'

const SOFTWARE_TYPE_OPTIONS = [
  { value: 'firmware', label: 'Firmware' },
  { value: 'application', label: 'Application' },
  { value: 'library', label: 'Library' },
  { value: 'configuration', label: 'Configuration' },
  { value: 'fpga', label: 'FPGA' },
]

const SOURCE_MODE_OPTIONS = [
  { value: 'internal', label: 'Internal (source lives in Cascadia)' },
  { value: 'external', label: 'External (pinned repository ref)' },
]

const createEmptySoftware = (defaultDesignId?: string): Software => ({
  id: undefined,
  masterId: undefined,
  itemType: 'Software',
  designId: defaultDesignId ?? '',
  itemNumber: '',
  name: '',
  state: '',
  isCurrent: true,
  description: '',
  softwareType: 'firmware',
  sourceMode: 'internal',
  externalRepositoryUrl: '',
  externalRef: '',
  externalCommitSha: '',
  version: '',
  targetHardware: '',
  toolchain: '',
})

/**
 * The tabs this detail view renders. The route's search schema derives its
 * `tab` enum from this list, so the URL contract and the rendered tabs
 * cannot drift apart; the `onValueChange` cast below is the one seam where
 * Radix's `string` meets it, and the triggers are rendered from the same
 * source of truth.
 */
export const SOFTWARE_DETAIL_TABS = ['details', 'source', 'history'] as const
export type SoftwareDetailTab = (typeof SOFTWARE_DETAIL_TABS)[number]

function ExternalRepositoryField({
  url,
  className,
}: {
  url?: string | null
  className?: string
}) {
  const isLink = !!url && /^https?:\/\//i.test(url)

  return (
    <div className={className}>
      <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
        Repository
      </dt>
      <dd className="mt-1 break-all text-sm">
        {isLink ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400"
          >
            {url}
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          </a>
        ) : (
          <span className="text-slate-500 dark:text-slate-400">
            No repository URL recorded
          </span>
        )}
      </dd>
    </div>
  )
}

function ExternalSourcePanel({ software }: { software: Software }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>External source</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Development takes place outside Cascadia. This repository pin is
          maintained manually; Cascadia does not fetch, mirror, or synchronize
          the repository.
        </p>
        <dl className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <ExternalRepositoryField
            url={software.externalRepositoryUrl}
            className="md:col-span-2"
          />
          <ViewEditStatic
            label="Pinned reference"
            value={software.externalRef}
          />
          <ViewEditStatic
            label="Commit SHA"
            value={software.externalCommitSha}
          />
        </dl>
      </CardContent>
    </Card>
  )
}

interface SoftwareDetailProps {
  software?: Software
  designs?: Array<Design>
  defaultDesignId?: string
  onSave: (software: Software, branchId?: string) => Promise<void>
  onDelete?: () => Promise<void>
  onCancel: () => void
  isSubmitting?: boolean
  activeTab?: SoftwareDetailTab
  onTabChange?: (tab: SoftwareDetailTab) => void
}

export function SoftwareDetail({
  software: initialSoftware,
  designs = [],
  defaultDesignId,
  onSave,
  onDelete,
  onCancel,
  isSubmitting = false,
  activeTab = 'details',
  onTabChange,
}: SoftwareDetailProps) {
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError } = useErrorHandler()

  const isCreateMode = !initialSoftware?.id

  const [software, setSoftware] = useState<Software>(
    () => initialSoftware || createEmptySoftware(defaultDesignId),
  )
  const [isEditing, setIsEditing] = useState(isCreateMode)
  const [isCheckoutDialogOpen, setIsCheckoutDialogOpen] = useState(false)
  const [selectedBranchId, setSelectedBranchId] = useState<string | undefined>()
  const [attributes, setAttributes] = useState<Record<string, unknown>>(
    initialSoftware?.attributes ?? {},
  )

  useEffect(() => {
    if (initialSoftware) {
      setSoftware(initialSoftware)
      setAttributes(initialSoftware.attributes ?? {})
    }
  }, [initialSoftware])

  // Where the server says this item may be edited: the branch holding its
  // edit lock, and whether main is protected for this item's TYPE (a design
  // with released items protects main for everything in it, but a Free or
  // Driving lifecycle stays editable there). Software shares the Part
  // lifecycle — it is Driven, so a protected main refuses its writes.
  // Asked once and fed to both the version context — which decides whether
  // main is editable at all — and the edit lock below, because neither
  // answer is derivable from the item.
  const editContext = useItemEditContext(isCreateMode ? undefined : software.id)
  const { context, contextLabel, isEditable, setContext } = useVersionContext({
    designId: isCreateMode ? undefined : software.designId,
    isMainProtected: editContext?.isMainProtected ?? false,
  })

  // The software item as it stood at the selected version context. Viewing
  // `main` addresses nothing, so the query stays disabled and the caller's
  // copy is shown — the same rule the shared factory encodes for every
  // detail page.
  const { data: versionAtContext, isFetching: isLoadingVersion } = useQuery(
    itemAtContextQuery<Software>(
      software.id ?? '',
      context,
      !isCreateMode && Boolean(software.designId),
    ),
  )

  const current = isCreateMode ? software : (versionAtContext ?? software)

  // Whether the viewing context is a workspace branch, read through the
  // shared cache rather than a per-mount probe.
  const { data: contextBranch } = useQuery(
    branchDetailQuery(
      context.type === 'branch' ? (context.branchId ?? '') : '',
      !isCreateMode,
    ),
  )
  const isWorkspaceContext = contextBranch?.branchType === 'workspace'

  const { isReleasedFamily } = useReleasedFamily('Software', current.state)
  const { data: designStatus = null } = useQuery(
    designStatusQuery(
      software.designId,
      isCreateMode && Boolean(software.designId),
    ),
  )
  const branchRequired = designStatus?.protection.phase === 'post-release'

  // Released lineage on main is revised through a change order (the
  // CheckoutDialog); membership comes from the lifecycle's mappings
  const needsCheckout =
    !isCreateMode && isReleasedFamily && context.type === 'main'

  // The server-side edit lock behind the Edit button. The hook reads where the
  // lock lives off `editContext`, so released-on-main resolves to no lock
  // branch at all and the Edit button becomes Revise (the CheckoutDialog).
  const editLock = useEditLock({
    itemId: isCreateMode ? undefined : current.id,
    context,
    editContext,
  })

  const updateField = (field: keyof Software, value: unknown) => {
    setSoftware((prev) => ({ ...prev, [field]: value }))
  }

  const updateSourceMode = (value: string) => {
    setSoftware((prev) => ({
      ...prev,
      sourceMode: value as Software['sourceMode'],
      ...(value === 'internal'
        ? {
            externalRepositoryUrl: '',
            externalRef: '',
            externalCommitSha: '',
          }
        : {}),
    }))
  }

  const handleEdit = async () => {
    if (needsCheckout) {
      setIsCheckoutDialogOpen(true)
      return
    }
    // Acquire the edit lock (checkout) before entering edit mode — the
    // server rejects saves without it, and other users see the lock.
    if (!isCreateMode && editLock.canLock && !editLock.heldByMe) {
      try {
        await editLock.acquire()
      } catch (error) {
        handleError(error, { title: 'Cannot edit item' })
        return
      }
    }
    setSoftware(current)
    setAttributes(current.attributes ?? {})
    setIsEditing(true)
  }

  // A revise-checkout mints the branch working copy up front, so editing
  // belongs on that row's page: the route-level save PUTs the id in the URL,
  // and from the released row's page it would target the released version and
  // be refused (BRANCH_PROTECTED). Navigate there in edit mode — the route
  // component survives the param change, so `isEditing` carries over and the
  // working copy drops into the form via the initialSoftware effect above.
  const handleCheckoutComplete = (branchId: string, currentItemId?: string) => {
    setSoftware(current)
    setAttributes(current.attributes ?? {})
    setIsEditing(true)
    if (currentItemId && currentItemId !== current.id) {
      navigate({
        to: '/software/$id',
        params: { id: currentItemId },
        search: { branch: branchId, tab: activeTab },
      } as any)
      return
    }
    // The branch still tracks the row this page is showing — edit in place.
    setContext({ type: 'branch', branchId })
  }

  const handleSave = async () => {
    const branchId = isCreateMode
      ? selectedBranchId
      : context.type === 'branch'
        ? context.branchId
        : undefined
    await onSave({ ...software, attributes }, branchId)
    if (!isCreateMode) {
      // Leaving edit mode releases the lock (changes are kept)
      if (editLock.heldByMe) {
        try {
          await editLock.checkin()
        } catch {
          // Lock release is best-effort; the user can re-enter edit mode
        }
      }
      setIsEditing(false)
    }
  }

  const handleCancelEdit = () => {
    if (isCreateMode) {
      onCancel()
    } else {
      if (editLock.heldByMe) {
        // Discard the checkout (removes the untouched branch row entirely)
        void editLock.cancel().catch(() => {})
      }
      // Revert to the saved copy for the context being viewed. Not `current`:
      // on main that resolves to the in-progress form state itself, so
      // reverting to it would keep the very edits this discards.
      const saved = versionAtContext ?? initialSoftware
      setSoftware(saved)
      setAttributes(saved.attributes ?? {})
      setIsEditing(false)
    }
  }

  const handleDelete = () => {
    if (!onDelete || !current.id) return
    confirm({
      title: 'Delete Software',
      description: `Are you sure you want to delete ${current.itemNumber}? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: onDelete,
    })
  }

  // Get reason for disabled Edit button
  const getEditDisabledReason = (): string | undefined => {
    // Ordered by what actually stops the click. Someone else's lock stops
    // every path including Revise, so it is asked first. Then Revise: a
    // released item on a protected main is not blocked at all, since the
    // button opens the CheckoutDialog and revises onto a branch. What is left
    // is the context itself.
    if (editLock.lockedByOther) {
      return `Checked out by ${editLock.lockHolderLabel}`
    }
    if (needsCheckout) {
      return undefined
    }
    if (!isEditable) {
      if (context.type === 'tag' || context.type === 'commit') {
        return 'Cannot edit historical versions'
      }
      if (context.type === 'main' && editLock.isMainProtected) {
        return 'This design has released items, so main is protected. Switch to an ECO or workspace branch to edit this item.'
      }
      return 'Editing not available in this context'
    }
    return undefined
  }

  /**
   * Why the source tree is read-only right now, or undefined if it is not.
   *
   * Source writes land on the same edit policy as the fields above:
   * `SoftwareSourceService` routes every import, file write, rename and
   * delete through `ItemService.update`, so a protected main, a historical
   * context, a locked ECO branch and another user's checkout each refuse
   * them. None of that was visible — the editor opened, the 30-second
   * autosave fired, and every write failed in a toast. Ask the same
   * questions the Edit button asks, and say the answer out loud.
   */
  const getSourceReadOnlyReason = (): string | undefined => {
    if (editLock.lockedByOther) {
      return `Checked out by ${editLock.lockHolderLabel}`
    }
    if (context.type === 'tag' || context.type === 'commit') {
      return 'Historical versions are read-only.'
    }
    // Released on main only — the Revise button beside this tab is the way
    // out, and it is the same `needsCheckout` the Edit button branches on.
    // On a branch a released-family row is still writable: the update
    // reroutes through `saveChanges` and mints the working copy, so gating
    // on the state alone (as this did) refused an edit the server accepts.
    if (needsCheckout) {
      return 'Released source is read-only. Revise this item to edit it.'
    }
    if (context.type === 'main' && editLock.isMainProtected) {
      return 'This design has released items, so main is protected. Switch to an ECO or workspace branch to edit this item.'
    }
    if (editContext?.isBranchLocked) {
      return 'This branch is locked while its change order is out for approval.'
    }
    return undefined
  }

  const sourceReadOnlyReason = getSourceReadOnlyReason()

  const getContextBadgeVariant = () => {
    switch (context.type) {
      case 'branch':
        return 'secondary'
      case 'tag':
      case 'commit':
        return 'outline'
      default:
        return 'default'
    }
  }

  const formatDate = (date?: string | Date) => {
    if (!date) return '-'
    try {
      return new Date(date).toLocaleDateString()
    } catch {
      return '-'
    }
  }

  return (
    <PageContainer>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link to="/software">
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
                {isCreateMode ? 'Create Software Item' : current.itemNumber}
              </h1>
              {!isCreateMode && isLoadingVersion && (
                <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
              )}
            </div>
            <p className="text-slate-600 dark:text-slate-400 mt-1">
              {isCreateMode
                ? 'The configuration item behind a firmware or software BOM line'
                : current.name || 'Unnamed'}
            </p>
          </div>
        </div>

        <div className="flex gap-2">
          {isEditing ? (
            <>
              <Button
                variant="outline"
                onClick={handleCancelEdit}
                disabled={isSubmitting}
              >
                <X className="h-4 w-4 mr-2" />
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={
                  isSubmitting ||
                  (isCreateMode && branchRequired && !selectedBranchId)
                }
              >
                <Save className="h-4 w-4 mr-2" />
                {isSubmitting
                  ? 'Saving...'
                  : isCreateMode
                    ? 'Create Software'
                    : 'Save Changes'}
              </Button>
            </>
          ) : (
            <>
              {/* Edit button with tooltip when disabled */}
              {getEditDisabledReason() ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Button
                        variant="outline"
                        onClick={handleEdit}
                        disabled={
                          (!isEditable && !needsCheckout) ||
                          editLock.lockedByOther
                        }
                      >
                        {needsCheckout ? (
                          <>
                            <GitBranch className="h-4 w-4 mr-2" />
                            Revise
                          </>
                        ) : (
                          <>
                            <Edit className="h-4 w-4 mr-2" />
                            Edit
                          </>
                        )}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{getEditDisabledReason()}</p>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Button
                  variant="outline"
                  onClick={handleEdit}
                  disabled={
                    (!isEditable && !needsCheckout) || editLock.lockedByOther
                  }
                >
                  {needsCheckout ? (
                    <>
                      <GitBranch className="h-4 w-4 mr-2" />
                      Revise
                    </>
                  ) : (
                    <>
                      <Edit className="h-4 w-4 mr-2" />
                      Edit
                    </>
                  )}
                </Button>
              )}
              {onDelete && (
                <Button
                  variant="destructive"
                  onClick={handleDelete}
                  disabled={!isEditable}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {!isCreateMode && (
        <div className="flex flex-wrap gap-2">
          <StateBadge
            itemType="Software"
            state={current.state}
            className="text-sm"
          />
          <Badge variant="secondary" className="text-sm font-mono">
            Rev {current.revision}
          </Badge>
          {current.version && (
            <Badge variant="default" className="text-sm font-mono">
              v{current.version}
            </Badge>
          )}
          {current.designId && context.type !== 'main' && (
            <Badge variant={getContextBadgeVariant()} className="text-sm">
              <GitBranch className="h-3 w-3 mr-1" />
              {contextLabel}
            </Badge>
          )}
          {editLock.status?.isCheckedOut && (
            <Badge
              variant="outline"
              className="text-sm text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-700"
            >
              <Lock className="h-3 w-3 mr-1" />
              {editLock.heldByMe
                ? 'Checked out by you'
                : `Checked out by ${editLock.lockHolderLabel}`}
            </Badge>
          )}
        </div>
      )}

      {!isCreateMode &&
        isWorkspaceContext &&
        context.type === 'branch' &&
        context.branchId && (
          <WorkspaceContextBanner branchId={context.branchId} />
        )}

      <Tabs
        value={activeTab}
        onValueChange={(value) => onTabChange?.(value as SoftwareDetailTab)}
        className="w-full"
      >
        <TabsList
          className={
            isCreateMode ? 'grid w-full grid-cols-1' : 'grid w-full grid-cols-3'
          }
        >
          <TabsTrigger value="details">Details</TabsTrigger>
          {!isCreateMode && <TabsTrigger value="source">Source</TabsTrigger>}
          {!isCreateMode && <TabsTrigger value="history">History</TabsTrigger>}
        </TabsList>

        <TabsContent value="details" className="mt-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Overview</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <ViewEditText
                      label="Item Number"
                      value={
                        isEditing ? software.itemNumber : current.itemNumber
                      }
                      onChange={(v) => updateField('itemNumber', v)}
                      isEditing={isEditing && isCreateMode}
                      placeholder="Auto-assigned (SW-...)"
                    />
                    <ViewEditText
                      label="Name"
                      value={isEditing ? software.name : current.name}
                      onChange={(v) => updateField('name', v)}
                      isEditing={isEditing}
                      placeholder="e.g., TDJ-25 Motor Firmware"
                      required
                    />
                    {isCreateMode ? (
                      <ItemCreateDesignSection
                        designs={designs}
                        designId={software.designId}
                        displayedDesignId={current.designId}
                        onDesignChange={(value) => {
                          updateField('designId', value)
                          setSelectedBranchId(undefined)
                        }}
                        isEditing={isEditing}
                        isCreateMode={isCreateMode}
                        selectedBranchId={selectedBranchId}
                        onBranchChange={setSelectedBranchId}
                        itemLabel="software item"
                      />
                    ) : (
                      <ViewEditStatic
                        label="Design"
                        value={
                          designs.find((d) => d.id === current.designId)
                            ?.name ?? current.designId
                        }
                      />
                    )}
                  </dl>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Software Information</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <ViewEditSelect
                      label="Software Type"
                      value={
                        isEditing ? software.softwareType : current.softwareType
                      }
                      onChange={(v) => updateField('softwareType', v)}
                      isEditing={isEditing}
                      options={SOFTWARE_TYPE_OPTIONS}
                    />
                    <ViewEditSelect
                      label="Source Mode"
                      value={
                        isEditing ? software.sourceMode : current.sourceMode
                      }
                      onChange={updateSourceMode}
                      isEditing={isEditing && isCreateMode}
                      options={SOURCE_MODE_OPTIONS}
                    />
                    {isEditing && software.sourceMode === 'external' && (
                      <>
                        <ViewEditText
                          label="Repository URL"
                          value={software.externalRepositoryUrl}
                          onChange={(v) =>
                            updateField('externalRepositoryUrl', v)
                          }
                          isEditing
                          inputType="url"
                          placeholder="https://github.com/organization/repository"
                          className="md:col-span-2"
                        />
                        <ViewEditText
                          label="Pinned Reference"
                          value={software.externalRef}
                          onChange={(v) => updateField('externalRef', v)}
                          isEditing
                          placeholder="e.g., v2.3.0, release/2.3, or a commit"
                        />
                        <ViewEditText
                          label="Commit SHA"
                          value={software.externalCommitSha}
                          onChange={(v) => updateField('externalCommitSha', v)}
                          isEditing
                          placeholder="Optional full 40- or 64-character SHA"
                        />
                        <div className="md:col-span-2 text-sm text-slate-500 dark:text-slate-400">
                          The reference is stored manually. Cascadia does not
                          currently verify it against the repository or keep it
                          synchronized.
                        </div>
                      </>
                    )}
                    <ViewEditText
                      label="Version"
                      value={isEditing ? software.version : current.version}
                      onChange={(v) => updateField('version', v)}
                      isEditing={isEditing}
                      placeholder="e.g., 2.3.0"
                    />
                    <ViewEditText
                      label="Target Hardware"
                      value={
                        isEditing
                          ? software.targetHardware
                          : current.targetHardware
                      }
                      onChange={(v) => updateField('targetHardware', v)}
                      isEditing={isEditing}
                      placeholder="e.g., STM32F407, board rev C"
                    />
                    <ViewEditText
                      label="Toolchain"
                      value={isEditing ? software.toolchain : current.toolchain}
                      onChange={(v) => updateField('toolchain', v)}
                      isEditing={isEditing}
                      placeholder="e.g., arm-none-eabi-gcc 13.2, CMake"
                    />
                  </dl>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Description</CardTitle>
                </CardHeader>
                <CardContent>
                  <ViewEditTextarea
                    label=""
                    value={
                      isEditing ? software.description : current.description
                    }
                    onChange={(v) => updateField('description', v)}
                    isEditing={isEditing}
                    placeholder="What this software does, its scope, and constraints..."
                  />
                </CardContent>
              </Card>
            </div>

            {/* Right sidebar */}
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Source</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <ViewEditStatic
                    label="Mode"
                    value={current.sourceMode ?? 'internal'}
                  />
                  {(current.sourceMode ?? 'internal') === 'external' ? (
                    <>
                      <ExternalRepositoryField
                        url={current.externalRepositoryUrl}
                      />
                      <ViewEditStatic
                        label="Pinned reference"
                        value={current.externalRef}
                      />
                      {current.externalCommitSha && (
                        <ViewEditStatic
                          label="Commit SHA"
                          value={current.externalCommitSha}
                        />
                      )}
                    </>
                  ) : (
                    <>
                      <ViewEditStatic
                        label="Source snapshot"
                        value={
                          current.manifestId
                            ? 'Imported (see Source tab)'
                            : 'No source imported yet'
                        }
                      />
                      {current.draftManifestId && (
                        <ViewEditStatic
                          label="Draft"
                          value="Uncommitted changes (see Source tab)"
                        />
                      )}
                    </>
                  )}
                </CardContent>
              </Card>

              {!isCreateMode && current.id && (
                <BuildArtifactCard software={current} />
              )}

              {isEditing ? (
                <Card>
                  <AttributesEditor
                    value={attributes}
                    onChange={setAttributes}
                    disabled={isSubmitting}
                    className="border-0 rounded-none"
                  />
                </Card>
              ) : (
                <Card>
                  <Collapsible
                    defaultOpen={
                      Object.keys(current.attributes ?? {}).length > 0
                    }
                  >
                    <CardHeader className="pb-3">
                      <CollapsibleTrigger className="hover:opacity-70">
                        <CardTitle>Custom Attributes</CardTitle>
                      </CollapsibleTrigger>
                    </CardHeader>
                    <CollapsibleContent>
                      <CardContent className="pt-0">
                        {Object.keys(current.attributes ?? {}).length > 0 ? (
                          <dl className="space-y-3">
                            {Object.entries(current.attributes ?? {}).map(
                              ([key, value]) => (
                                <div key={key} className="space-y-1">
                                  <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
                                    {key}
                                  </dt>
                                  <dd className="text-sm text-slate-900 dark:text-white bg-slate-100 dark:bg-slate-900 px-3 py-1.5 rounded-md">
                                    {formatAttributeValue(value) || '-'}
                                  </dd>
                                </div>
                              ),
                            )}
                          </dl>
                        ) : (
                          <p className="text-sm text-slate-500 dark:text-slate-400">
                            No custom attributes defined.
                          </p>
                        )}
                      </CardContent>
                    </CollapsibleContent>
                  </Collapsible>
                </Card>
              )}

              {!isCreateMode && (
                <Collapsible defaultOpen={false}>
                  <Card>
                    <CardHeader>
                      <CollapsibleTrigger className="hover:opacity-70">
                        <CardTitle>Metadata</CardTitle>
                      </CollapsibleTrigger>
                    </CardHeader>
                    <CollapsibleContent>
                      <CardContent className="space-y-3">
                        <ViewEditStatic
                          label="Revision"
                          value={current.revision}
                        />
                        <ViewEditStatic
                          label="Created"
                          value={formatDate(current.createdAt)}
                        />
                        <ViewEditStatic
                          label="Modified"
                          value={formatDate(current.modifiedAt)}
                        />
                      </CardContent>
                    </CollapsibleContent>
                  </Card>
                </Collapsible>
              )}
            </div>
          </div>
        </TabsContent>

        {!isCreateMode && current.id && (
          <TabsContent value="source" className="mt-6">
            {(current.sourceMode ?? 'internal') === 'external' ? (
              <ExternalSourcePanel software={current} />
            ) : (
              <SourceViewer
                itemId={current.id}
                canImport={!sourceReadOnlyReason}
                canEdit={!sourceReadOnlyReason}
                readOnlyReason={sourceReadOnlyReason}
              />
            )}
          </TabsContent>
        )}

        {!isCreateMode && current.id && (
          <TabsContent value="history" className="mt-6">
            <ItemHistoryTab
              itemId={current.id}
              designId={current.designId || null}
              versionContext={context}
              onViewHistoricalState={setContext}
              itemType="Software"
            />
          </TabsContent>
        )}
      </Tabs>

      {!isCreateMode && current.id && current.designId && (
        <CheckoutDialog
          open={isCheckoutDialogOpen}
          onOpenChange={setIsCheckoutDialogOpen}
          itemId={current.id}
          itemNumber={current.itemNumber ?? ''}
          designId={current.designId}
          onCheckoutComplete={handleCheckoutComplete}
        />
      )}
    </PageContainer>
  )
}
