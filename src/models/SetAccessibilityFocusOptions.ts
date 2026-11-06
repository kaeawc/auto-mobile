/**
 * Options for Android TalkBack or iOS VoiceOver focus on a specific element.
 * Clearing is supported only on Android.
 */
export interface SetAccessibilityFocusOptions {
  /**
   * Whether to set or clear accessibility focus (TalkBack or VoiceOver).
   * Defaults to "set".
   */
  action?: "set" | "clear";

  /**
   * Target element selectors (at least one must be specified).
   * Android resolves selectors locally to a unique native resource-id.
   * iOS uses the first matching accessibility element in the foreground app SDK.
   */
  text?: string; // Text content of the element
  resourceId?: string; // Resource ID of the element (e.g., "com.app:id/button")
  contentDesc?: string; // Content description of the element

  /**
   * Whether to trigger TalkBack announcement when focus is set (default: true)
   */
  announce?: boolean;
}
