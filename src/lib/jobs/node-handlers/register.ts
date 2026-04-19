/**
 * Register Node.js job handlers.
 *
 * This file registers handler implementations that run in the Node.js
 * job worker. Import this file only in the worker entry point — the main
 * app does not need handler implementations.
 *
 * Job type definitions (configs) must be registered first via
 * '../definitions/register'.
 */

import { JobTypeRegistry } from '../registry'

import { workflowTransitionHandler } from './notification'
import { cloneDesignHandler } from './design-clone'
import { cacheCleanupHandler } from './cache-cleanup'
import { sessionCleanupHandler } from './session-cleanup'
import { wiPartChangedHandler } from './workinstruction'
import { zooGenerationHandler } from './zoo-generation'

JobTypeRegistry.registerHandler(workflowTransitionHandler)
JobTypeRegistry.registerHandler(cloneDesignHandler)
JobTypeRegistry.registerHandler(cacheCleanupHandler)
JobTypeRegistry.registerHandler(sessionCleanupHandler)
JobTypeRegistry.registerHandler(wiPartChangedHandler)
JobTypeRegistry.registerHandler(zooGenerationHandler)
