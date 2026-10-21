/**
 * Named match-mode policies for resolver-backed lookups, so a call site states
 * the intent ("contains, ignoring case", "inspect", "focus input with hint
 * fallback") instead of repeating raw flag combinations. Each policy is the
 * exact option fragment the call sites previously spelled out inline.
 */

/** Substring match that ignores case: the label policy for user-visible text. */
export const CONTAINS_IGNORE_CASE = Object.freeze({
  partialMatch: true,
  caseSensitive: false,
} as const);

/** Whole-value match for an element id. */
export const EXACT_MATCH = Object.freeze({ partialMatch: false } as const);

/** Read the node itself: inert labels and collapsed-group children stay addressable. */
export const INSPECT_INTENT = Object.freeze({ intentAction: "inspect" } as const);

/** Resolve a label to the text input it names, using the hint as a last resort. */
export const FOCUS_INPUT_WITH_HINT_FALLBACK = Object.freeze({
  intentAction: "focus-input",
  allowHintFallback: true,
} as const);

/** Resolve a label to the text input it names, without hint matching. */
export const FOCUS_INPUT_INTENT = Object.freeze({ intentAction: "focus-input" } as const);

/** Resolve the checkable control a label or its row encloses. */
export const TOGGLE_INSPECT_INTENT = Object.freeze({
  intentAction: "inspect",
  selectionIntent: "toggle",
} as const);

/** Resolve the field a label names for typing, via the inspect intent. */
export const FOCUS_INPUT_INSPECT_INTENT = Object.freeze({
  intentAction: "inspect",
  selectionIntent: "focus-input",
} as const);

/** Drag source and target lookups use the drag action. */
export const DRAG_INTENT = Object.freeze({ intentAction: "drag" } as const);

/** Case-insensitive match, whole-value or substring per `partial`. */
export function ignoreCasePolicy(partial: boolean): {
  readonly partialMatch: boolean;
  readonly caseSensitive: false;
} {
  return { partialMatch: partial, caseSensitive: false };
}
