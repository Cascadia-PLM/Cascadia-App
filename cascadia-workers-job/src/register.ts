// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Register Node.js job handlers.
 *
 * This file registers handler implementations that run in the Node.js
 * job worker. Import this file only in the worker entry point — the main
 * app does not need handler implementations.
 *
 * Job type definitions (configs) must be registered first via
 * '@cascadia/api/lib/jobs/definitions/register'.
 */

import { JobTypeRegistry } from '@cascadia/api/lib/jobs/registry'

import { workflowTransitionHandler } from './handlers/notification'
import { cloneDesignHandler } from './handlers/design-clone'
import { cacheCleanupHandler } from './handlers/cache-cleanup'
import { eventsPruneHandler } from './handlers/events-prune'
import { sessionCleanupHandler } from './handlers/session-cleanup'
import { wiPartChangedHandler } from './handlers/workinstruction'
import { watermarkPdfHandler } from './handlers/watermark'

JobTypeRegistry.registerHandler(workflowTransitionHandler)
JobTypeRegistry.registerHandler(cloneDesignHandler)
JobTypeRegistry.registerHandler(cacheCleanupHandler)
JobTypeRegistry.registerHandler(eventsPruneHandler)
JobTypeRegistry.registerHandler(sessionCleanupHandler)
JobTypeRegistry.registerHandler(wiPartChangedHandler)
JobTypeRegistry.registerHandler(watermarkPdfHandler)
