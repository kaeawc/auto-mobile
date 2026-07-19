/**
 * Bounds for element matching
 */
interface SelectorBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Options for selector matching.
 *
 * Relocated here from the deleted `utils/AccessibilityFocusTracker` (#3919): the
 * tracker class was dead and matched on camelCase keys that CtrlProxy never
 * emits, but this type is the live selector shape used by the focus-navigation
 * path — {@link FocusElementMatcher}, {@link FocusPathCalculator} and
 * {@link FocusNavigationExecutor} — so it lives with its consumers.
 */
export interface ElementSelector {
  /** Match by resource ID */
  resourceId?: string;

  /** Match by text content */
  text?: string;

  /** Match by content description */
  contentDesc?: string;

  /** Match by test tag */
  testTag?: string;

  /** Match by bounds (for disambiguation when multiple elements match) */
  bounds?: SelectorBounds;
}
