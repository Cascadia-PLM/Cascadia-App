/**
 * Shared helpers for design-engine stage tools.
 */

/**
 * Extract a safe, model-facing message from a thrown tool error.
 *
 * I/O tools (searches, catalog/BOM lookups) wrap their body in try/catch and
 * return a schema-valid empty result carrying this message under an `error`
 * field, so a transient failure lets the model recover instead of failing the
 * whole design session.
 */
export function toolErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Tool execution failed'
}
