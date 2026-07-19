import { Element } from "./Element";

/**
 * Result of an accessibilityFocus (set/clear TalkBack cursor) operation.
 * Returned by the `accessibilityFocus` MCP tool.
 */
export interface SetAccessibilityFocusResult {
  /**
   * Whether the operation succeeded
   */
  success: boolean;

  /**
   * Error message if the operation failed
   */
  error?: string;

  /**
   * Warning message if the operation partially succeeded
   */
  warning?: string;

  /**
   * The element that received accessibility focus
   */
  focusedElement?: Element;

  /**
   * Whether the post-action focus state was successfully read back to confirm
   * the cursor moved. `false` means the set/clear was dispatched but the
   * confirmation read failed, so `focusedElement` may be missing even though the
   * action itself did not error — callers can use this to decide whether to
   * retry rather than assume the cursor never moved (#3922).
   */
  confirmed?: boolean;
}
