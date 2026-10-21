package dev.jasonpearson.automobile.ctrlproxy

import android.text.InputType
import android.view.accessibility.AccessibilityNodeInfo

/** Wire names for Android action and input-type constants. */
internal object NodeFieldNames {
  // Mirrors BASELINE_ACCESSIBILITY_ACTIONS in src/features/observe/audits/accessibilityActions.ts.
  val baselineAccessibilityActions =
    setOf("select", "clear_selection", "accessibility_focus", "clear_accessibility_focus")

  val actions =
    mapOf(
      AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS to "accessibility_focus",
      AccessibilityNodeInfo.ACTION_CLEAR_ACCESSIBILITY_FOCUS to "clear_accessibility_focus",
      AccessibilityNodeInfo.ACTION_CLEAR_FOCUS to "clear_focus",
      AccessibilityNodeInfo.ACTION_CLEAR_SELECTION to "clear_selection",
      AccessibilityNodeInfo.ACTION_CLICK to "click",
      AccessibilityNodeInfo.ACTION_COLLAPSE to "collapse",
      AccessibilityNodeInfo.ACTION_COPY to "copy",
      AccessibilityNodeInfo.ACTION_CUT to "cut",
      AccessibilityNodeInfo.ACTION_DISMISS to "dismiss",
      AccessibilityNodeInfo.ACTION_EXPAND to "expand",
      AccessibilityNodeInfo.ACTION_FOCUS to "focus",
      AccessibilityNodeInfo.ACTION_LONG_CLICK to "long_click",
      AccessibilityNodeInfo.ACTION_NEXT_AT_MOVEMENT_GRANULARITY to "next_at_movement_granularity",
      AccessibilityNodeInfo.ACTION_NEXT_HTML_ELEMENT to "next_html_element",
      AccessibilityNodeInfo.ACTION_PASTE to "paste",
      AccessibilityNodeInfo.ACTION_PREVIOUS_AT_MOVEMENT_GRANULARITY to
        "previous_at_movement_granularity",
      AccessibilityNodeInfo.ACTION_PREVIOUS_HTML_ELEMENT to "previous_html_element",
      AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD to "scroll_backward",
      AccessibilityNodeInfo.ACTION_SCROLL_FORWARD to "scroll_forward",
      AccessibilityNodeInfo.ACTION_SELECT to "select",
      AccessibilityNodeInfo.ACTION_SET_SELECTION to "set_selection",
      AccessibilityNodeInfo.ACTION_SET_TEXT to "set_text",
    )
  val inputTypes =
    mapOf(
      InputType.TYPE_CLASS_TEXT to "text",
      InputType.TYPE_CLASS_NUMBER to "number",
      InputType.TYPE_CLASS_PHONE to "phone",
      InputType.TYPE_CLASS_DATETIME to "datetime",
      InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS to "email_address",
      InputType.TYPE_TEXT_VARIATION_EMAIL_SUBJECT to "email_subject",
      InputType.TYPE_TEXT_VARIATION_FILTER to "filter",
      InputType.TYPE_TEXT_VARIATION_LONG_MESSAGE to "long_message",
      InputType.TYPE_TEXT_VARIATION_PASSWORD to "password",
      InputType.TYPE_TEXT_VARIATION_PERSON_NAME to "person_name",
      InputType.TYPE_TEXT_VARIATION_PHONETIC to "phonetic",
      InputType.TYPE_TEXT_VARIATION_POSTAL_ADDRESS to "postal_address",
      InputType.TYPE_TEXT_VARIATION_SHORT_MESSAGE to "short_message",
      InputType.TYPE_TEXT_VARIATION_URI to "uri",
      InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD to "visible_password",
      InputType.TYPE_TEXT_VARIATION_WEB_EDIT_TEXT to "web_edit_text",
      InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS to "web_email_address",
      InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD to "web_password",
    )
}
