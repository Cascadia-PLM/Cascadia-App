/**
 * Runtime-configurable fields for item types.
 * These can be modified without code changes or redeployment.
 *
 * This interface is kept separate from database schema to avoid
 * pulling database dependencies into client bundles.
 */
export interface RuntimeItemTypeConfig {
  label?: string
  pluralLabel?: string
  icon?: string
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
  permissions?: {
    create: Array<string>
    read: Array<string>
    update: Array<string>
    delete: Array<string>
  }
  relationships?: Array<{
    type: string
    label: string
    targetTypes: Array<string>
    allowMultiple: boolean
  }>
  fieldMetadata?: Record<
    string,
    {
      label?: string
      description?: string
      required?: boolean
      visible?: boolean
    }
  >
  /**
   * For ChangeOrder item type only: Maps change order types to their default workflow definitions.
   * When a change order is created, the workflow matching its changeType is automatically started.
   * All change types must have a workflow assigned - null values are not allowed.
   */
  workflowsByChangeType?: {
    ECO?: string
    ECN?: string
    Deviation?: string
    MCO?: string
    XCO?: string
  }
}
