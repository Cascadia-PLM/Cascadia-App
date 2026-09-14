// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The runtime-configurable part of an item type: which lifecycle governs it.
 *
 * Deliberately this small. The interface used to carry `label`,
 * `pluralLabel`, `icon`, `permissions`, `relationships` and `fieldMetadata`
 * as well, and the admin screen offered an input for each — but the enforced
 * permission model is the role/resource one in `lib/auth/permissions.ts` and
 * never read these, `relationships` and `fieldMetadata` were read by nothing
 * at all, and the labels reached two of the dozen surfaces that display a
 * type's name, so renaming Part to Component produced a search typeahead
 * saying "Components" beside a page still saying "Part". A setting that does
 * not take effect is worse than no setting: an administrator believes the
 * system is configured in a way it is not.
 *
 * Everything else about an item type is code — see ITEM_TYPE_DEFINITIONS.
 *
 * This interface is kept separate from database schema to avoid
 * pulling database dependencies into client bundles.
 */
export interface RuntimeItemTypeConfig {
  /**
   * Links this item type to a lifecycle definition (from workflow_definitions table).
   * The lifecycle controls which states are valid and how items transition between them.
   * Multiple item types can share the same lifecycle definition.
   *
   * Validation rules:
   * - Cannot change to a lifecycle that doesn't include current items' states
   * - Cannot delete a lifecycle that item types reference
   * - Cannot remove states from a lifecycle that items are currently in
   */
  lifecycleDefinitionId?: string
  /**
   * ChangeOrder only: the Driving definition each change type runs. Creation
   * starts that definition's instance, so every change type an install
   * creates needs an entry.
   */
  lifecyclesByChangeType?: LifecyclesByChangeType
  /**
   * The key this shipped under. Read for one release — a config written by
   * an older client or a database not yet migrated still says it — and
   * never written: `ConfigService` moves it to `lifecyclesByChangeType` on
   * the way in and out (remediation plan CM-25).
   * @deprecated
   */
  workflowsByChangeType?: LifecyclesByChangeType
}

export interface LifecyclesByChangeType {
  ECO?: string
  ECN?: string
  Deviation?: string
  MCO?: string
  XCO?: string
}
