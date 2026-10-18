import type { Element } from "./Element";

/** Evidence captured while the opt-in screen-reader cursor journey runs. */
export interface ScreenReaderNavigationResult {
  /** Whether the cursor reached the target through accessibility-focus navigation. */
  reachable: boolean;
  /** Focused nodes in the order the cursor visited them. */
  traversalOrder: Element[];
  /**
   * Whether the cursor was stuck or diverging. Cursor navigation is now one focus request, so a
   * failed move is a thrown error rather than evidence here; this stays false.
   */
  focusTrapDetected: boolean;
}
