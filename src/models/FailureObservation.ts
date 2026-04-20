/**
 * Observe payload attached to failed plan steps for CI/debugging.
 * Includes full view hierarchy from the observe result (can be large).
 */
export interface FailureObservationSummary {
  capturedAtMs: number;
  activeWindow?: unknown;
  awaitTimeout?: boolean;
  awaitedElement?: unknown;
  accessibilityState?: unknown;
  /** Full processed view hierarchy from observe (same as tool output). */
  viewHierarchy?: unknown;
  /** Present when observe was run with raw: true. */
  rawViewHierarchy?: unknown;
  /** Visible text from elements.clickable / .text / .scrollable (capped). */
  visibleTextsSample?: string[];
  resourceIdsSample?: string[];
  /** Present when observe failed or payload could not be parsed. */
  observeError?: string;
}
