/**
 * Resume detection for the drafting stages (toolset, requirements, BOM).
 *
 * A stage resumes when a previous run of *that* stage was interrupted — by a
 * clarification, a pause, or a disconnect — and left partial work behind. On a
 * resume the stage replays its prior tool calls into the prompt and tells the
 * model to continue rather than start over.
 *
 * The session's `stage` column alone cannot answer this. Confirming a stage
 * parks the session in the *next* stage's drafting state before that stage has
 * ever run (see `CollaborativeDesignEngine.confirmStage`), so a first run finds
 * its own drafting stage already recorded. Treating that as a resume tells the
 * model to continue work that does not exist and to skip tool calls it never
 * made, and it typically responds by doing nothing at all.
 *
 * The stage's own artifact is the only reliable witness: work exists, or it
 * does not.
 */
export function isResumingStage(
  sessionStage: string,
  draftingStage: string,
  hasPriorWork: boolean,
): boolean {
  return sessionStage === draftingStage && hasPriorWork
}
