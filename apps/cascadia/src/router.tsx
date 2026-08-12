// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createAppRouter } from '@cascadia/core/create-router'
import { routeTree } from './routeTree.gen'

/** This edition's router, built around its own generated route tree. */
export const getRouter = () => createAppRouter(routeTree as never)
