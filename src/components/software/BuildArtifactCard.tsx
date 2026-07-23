import { useRef, useState } from 'react'
import { Download, Package, Trash2, Upload } from 'lucide-react'
import type { Software } from '@/lib/items/types/software'
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

interface FileMetadata {
  id: string
  originalFileName?: string
  fileName?: string
  fileSize?: number
}

/**
 * The primary build artifact slot (proposal §5.2): one vault file
 * (.bin/.hex/.elf/.zip) attached to this software version. Vault files are
 * branch-scoped, so an artifact uploaded on an ECO branch promotes to main
 * on release alongside the source it was built from.
 */
export function BuildArtifactCard({ software }: { software: Software }) {
  const { handleError, showSuccess } = useErrorHandler()
  const inputRef = useRef<HTMLInputElement>(null)
  const [artifactFileId, setArtifactFileId] = useState<string | null>(
    software.buildArtifactFileId ?? null,
  )
  const [artifactName, setArtifactName] = useState<string | null>(null)
  const [isUploading, setIsUploading] = useState(false)

  const isReleased = ['Released', 'Obsolete', 'Superseded'].includes(
    software.state ?? '',
  )

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !software.id) return

    setIsUploading(true)
    try {
      const formData = new FormData()
      formData.append('file_0', file)
      // Raw fetch: multipart needs the browser-set boundary
      const response = await fetch(
        `/api/v1/items/${software.id}/files/upload`,
        { method: 'POST', body: formData },
      )
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string }
        } | null
        throw new Error(
          body?.error?.message ?? `Upload failed (${response.status})`,
        )
      }
      const result = (await response.json()) as {
        data: { files: Array<FileMetadata> }
      }
      const uploaded = result.data.files[0]
      if (!uploaded) throw new Error('Upload returned no file')

      await apiFetch(`/api/v1/software/${software.id}`, {
        method: 'PUT',
        body: JSON.stringify({ buildArtifactFileId: uploaded.id }),
      })

      setArtifactFileId(uploaded.id)
      setArtifactName(file.name)
      showSuccess('Build artifact attached', file.name)
    } catch (error) {
      handleError(error, { title: 'Failed to upload build artifact' })
    } finally {
      setIsUploading(false)
    }
  }

  const handleRemove = async () => {
    if (!software.id) return
    try {
      await apiFetch(`/api/v1/software/${software.id}`, {
        method: 'PUT',
        body: JSON.stringify({ buildArtifactFileId: null }),
      })
      setArtifactFileId(null)
      setArtifactName(null)
      showSuccess('Build artifact detached', 'The vault file was kept')
    } catch (error) {
      handleError(error, { title: 'Failed to detach build artifact' })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Package className="h-4 w-4" />
          Build Artifact
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={handleUpload}
        />
        {artifactFileId ? (
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm text-slate-700 dark:text-slate-300">
              {artifactName ?? 'Attached artifact'}
            </span>
            <div className="flex shrink-0 gap-1">
              <a href={`/api/v1/files/${artifactFileId}/download`} download>
                <Button variant="ghost" size="sm" title="Download">
                  <Download className="h-4 w-4" />
                </Button>
              </a>
              {!isReleased && (
                <Button
                  variant="ghost"
                  size="sm"
                  title="Detach"
                  onClick={handleRemove}
                >
                  <Trash2 className="h-4 w-4 text-red-500" />
                </Button>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No build artifact attached.
          </p>
        )}
        {!isReleased && (
          <Button
            variant="outline"
            size="sm"
            disabled={isUploading}
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="mr-2 h-4 w-4" />
            {isUploading
              ? 'Uploading...'
              : artifactFileId
                ? 'Replace artifact'
                : 'Upload artifact'}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
