/** Android advertises these bookkeeping actions even on non-interactive nodes. */
export const BASELINE_ACCESSIBILITY_ACTIONS: ReadonlySet<string> = new Set([
  "select",
  "clear_selection",
  "accessibility_focus",
  "clear_accessibility_focus",
]);

/**
 * Baseline only as a pair: either action alone genuinely selects or deselects
 * the node, so it stays an interaction signal (#14435).
 */
const PAIRED_SELECTION_ACTIONS: ReadonlySet<string> = new Set(["select", "clear_selection"]);

/** True when `actions` holds anything beyond Android's baseline signature. */
export function hasInteractionAction(actions: readonly unknown[]): boolean {
  const pairedSelection = [...PAIRED_SELECTION_ACTIONS].every((action) => actions.includes(action));
  return actions.some(
    (action) =>
      typeof action !== "string" ||
      !BASELINE_ACCESSIBILITY_ACTIONS.has(action) ||
      (PAIRED_SELECTION_ACTIONS.has(action) && !pairedSelection),
  );
}
