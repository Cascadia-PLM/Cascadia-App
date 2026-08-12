// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { watermarkPdfPayloadSchema, watermarkPdfResultSchema } from './types'
import type { WatermarkPdfPayload, WatermarkPdfResult } from './types'
import type { JobTypeConfig } from '../../types'

export const watermarkPdfConfig: JobTypeConfig<
  WatermarkPdfPayload,
  WatermarkPdfResult
> = {
  type: 'document.watermark.apply',
  label: 'Apply PDF Watermark',
  routingKey: 'jobs.document.watermark',

  payloadSchema: watermarkPdfPayloadSchema,
  resultSchema: watermarkPdfResultSchema,

  // Generous: a batch can carry hundreds of files, and a large drawing set is
  // slow to re-save even though each individual stamp is cheap.
  timeout: 10 * 60 * 1000,
  maxAttempts: 3,
  retryDelays: [30000, 120000, 300000],
  // Behind user-facing work. A superseded stamp landing a minute late is a
  // nuisance; a notification landing late is a missed approval.
  priority: 'normal',
}
