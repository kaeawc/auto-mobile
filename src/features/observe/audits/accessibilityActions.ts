/** Android advertises these bookkeeping actions even on non-interactive nodes. */
export const BASELINE_ACCESSIBILITY_ACTIONS: ReadonlySet<string> = new Set([
  "select",
  "clear_selection",
  "accessibility_focus",
  "clear_accessibility_focus",
]);
