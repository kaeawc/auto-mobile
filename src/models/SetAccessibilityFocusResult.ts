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
}
