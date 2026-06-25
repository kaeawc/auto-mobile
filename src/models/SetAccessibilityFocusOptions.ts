/**
 * Options for setting/clearing accessibility focus (TalkBack cursor) on a specific element.
 * Backs the `accessibilityFocus` MCP tool. Android only (TalkBack); iOS VoiceOver-focus
 * is not yet supported.
 */
export interface SetAccessibilityFocusOptions {
  /**
   * Whether to set or clear the accessibility (TalkBack) focus cursor.
   * Defaults to "set".
   */
  action?: "set" | "clear";

  /**
   * Target element selectors (at least one must be specified).
   * Non-id selectors are resolved to a resource-id via the element finder before
   * the action is sent to the accessibility service.
   */
  text?: string; // Text content of the element
  resourceId?: string; // Resource ID of the element (e.g., "com.app:id/button")
  contentDesc?: string; // Content description of the element

  /**
   * Whether to trigger TalkBack announcement when focus is set (default: true)
   */
  announce?: boolean;
}
