package dev.jasonpearson.automobile.ctrlproxy.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.JsonElement

/**
 * Data class representing UI elements with all relevant properties extracted from
 * AccessibilityNodeInfo for automated testing.
 *
 * Property names match the XML attribute format used by uiautomator to maintain compatibility with
 * existing test frameworks.
 */
@Serializable
data class UIElementInfo(
  val text: String? = null,
  val textSize: Float? = null,
  @SerialName("text-color") val textColor: String? = null, // Hex color string like "#FF000000"
  @SerialName("content-desc") val contentDesc: String? = null,
  @SerialName("resource-id") val resourceId: String? = null,
  @SerialName("view-id") val viewId: String? = null,
  val className: String? = null,
  val bounds: ElementBounds? = null,
  val clickable: String? = null, // "true"/"false" to match XML format
  val enabled: String? = null,
  val focusable: String? = null,
  val focused: String? = null,
  @SerialName("accessibility-focused") val accessibilityFocused: String? = null,
  val scrollable: String? = null,
  val password: String? = null,
  val checkable: String? = null,
  val checked: String? = null,
  val selected: String? = null,
  @SerialName("long-clickable") val longClickable: String? = null,
  val fragment: String? = null, // Fragment class name when applicable

  // Additional accessibility semantics fields
  @SerialName("test-tag") val testTag: String? = null, // Compose or View accessibility-extra tag
  @SerialName("unique-id") val uniqueId: String? = null, // Android-owned ID (API 33+)
  @SerialName("visible-to-user") val visibleToUser: Boolean? = null,
  @SerialName("container-title") val containerTitle: String? = null, // API 34+
  val role: String? = null, // Accessibility role (button, checkbox, etc.)
  @SerialName("state-description") val stateDescription: String? = null, // Custom state description
  @SerialName("error-message") val errorMessage: String? = null, // Error message for form fields
  @SerialName("hint-text") val hintText: String? = null, // Hint text for input fields
  @SerialName("tooltip-text") val tooltipText: String? = null, // Tooltip text
  @SerialName("pane-title") val paneTitle: String? = null, // Pane title for navigation
  @SerialName("live-region") val liveRegion: String? = null, // Live region mode
  @SerialName("collection-info") val collectionInfo: String? = null, // Collection information
  @SerialName("collection-item-info")
  val collectionItemInfo: String? = null, // Collection item info
  @SerialName("collection-row-index") val collectionRowIndex: Int? = null,
  @SerialName("collection-column-index") val collectionColumnIndex: Int? = null,
  @SerialName("range-info") val rangeInfo: String? = null, // Range information for sliders/progress
  @SerialName("input-type") val inputType: String? = null, // Input type for text fields
  @SerialName("actions") val actions: List<String>? = null, // Available accessibility actions
  @SerialName("extras") val extras: Map<String, String>? = null, // Custom extras from semantics
  val occlusionState: String? = null, // visible | partial | hidden
  val occludedBy: String? = null, // Resource ID or label of the occluding view
  @SerialName("occludedByViewId")
  val occludedByViewId: String? = null, // Stable view-id of the occluding view
  val recomposition: RecompositionEntry? = null,

  // Wire projection of the child subtree (issue #5471). This is the ONLY serialized
  // representation of children: `null` (leaf), a JSON object (single child), or a JSON array
  // (multiple children), matching the format existing desktop/MCP/TS consumers parse.
  //
  // During extraction this stays null — the pipeline (optimize, detectors, occlusion, focus
  // search, hashing) walks the typed [children] list below with zero (de)serialization. `node`
  // is materialized from [children] exactly once, at the wire boundary (see WireNodeCodec).
  val node: JsonElement? = null,

  // Typed, in-memory child list. Not serialized (see [node] for the wire form). Every intermediate
  // extraction pass operates on this list so a snapshot never re-encodes/re-decodes subtrees.
  @Transient val children: List<UIElementInfo> = emptyList(),
) {
  /** Helper properties for boolean checks (for backwards compatibility) */
  val isClickable: Boolean
    get() = clickable == "true"

  val isEnabled: Boolean
    get() = enabled != "false" // Default true if not specified

  val isFocusable: Boolean
    get() = focusable == "true"

  val isFocused: Boolean
    get() = focused == "true"

  val isAccessibilityFocused: Boolean
    get() = accessibilityFocused == "true"

  val isScrollable: Boolean
    get() = scrollable == "true"

  val isPassword: Boolean
    get() = password == "true"

  val isCheckable: Boolean
    get() = checkable == "true"

  val isChecked: Boolean
    get() = checked == "true"

  val isSelected: Boolean
    get() = selected == "true"

  val isLongClickable: Boolean
    get() = longClickable == "true"
}
