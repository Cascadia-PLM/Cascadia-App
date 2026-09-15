// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { RevisionScheme } from '@/lib/types/lifecycle'
import { ValidationError } from '@/lib/errors'
import { RevisionService } from '@/lib/services/RevisionService'

function fail(revision: string, expected: string): never {
  const message = `Revision '${revision}' is not a valid formal revision for this lifecycle; expected ${expected}`
  throw new ValidationError(message, [{ field: 'revision', message }], {
    operation: 'importBaselineRelease',
  })
}

function configuredStart(scheme: RevisionScheme): number {
  // `startAt` was added after the original revision-scheme contract. Keeping
  // this reader tolerant lets an import branch merge cleanly with trees that
  // already support R0 without weakening older R1-based configurations.
  return (scheme as { startAt?: number }).startAt ?? 1
}

/**
 * Validate and normalize an imported release revision against the lifecycle's
 * release-phase scheme. The ordinary create flow may carry a working marker;
 * this path may not, because its caller is declaring that the source system's
 * revision is already a formal release.
 */
export function parseBaselineReleaseRevision(
  input: string | null | undefined,
  scheme?: RevisionScheme,
): string {
  const revision = input?.trim() ?? ''
  if (
    revision.length === 0 ||
    revision.length > 10 ||
    RevisionService.isWorkingRevision(revision)
  ) {
    fail(revision || '(empty)', 'a released revision (not -, DRAFT, or empty)')
  }

  const resolved = scheme ?? ({ type: 'alpha' } as const)
  switch (resolved.type) {
    case 'alpha':
      if (!/^[A-Z]+$/.test(revision)) fail(revision, 'A, B, ... Z, AA, ...')
      return revision

    case 'numeric': {
      if (!/^(0|[1-9]\d*)$/.test(revision)) {
        fail(revision, `an integer at or above ${configuredStart(resolved)}`)
      }
      if (Number(revision) < configuredStart(resolved)) {
        fail(revision, `an integer at or above ${configuredStart(resolved)}`)
      }
      return revision
    }

    case 'prefixed-numeric': {
      const numeric = revision.slice(resolved.prefix.length)
      if (
        !revision.startsWith(resolved.prefix) ||
        !/^(0|[1-9]\d*)$/.test(numeric) ||
        Number(numeric) < configuredStart(resolved)
      ) {
        fail(
          revision,
          `${resolved.prefix}${configuredStart(resolved)} or a later revision`,
        )
      }
      return revision
    }

    case 'none':
      if (revision !== RevisionService.NO_REVISION) {
        fail(revision, RevisionService.NO_REVISION)
      }
      return revision
  }
}
