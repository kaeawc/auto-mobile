package dev.jasonpearson.automobile.ctrlproxy

import android.annotation.SuppressLint
import android.os.Build
import android.view.accessibility.AccessibilityNodeInfo

/** Action names that change no visible state, so no settled hierarchy is published after them. */
internal val NON_VISUAL_NODE_ACTIONS = setOf("focus", "clear_focus")

/** App-defined accessibility action matched by its label (#14077). */
internal const val CUSTOM_NODE_ACTION = "custom"

/** ACTION_SET_PROGRESS with [NodeActionArguments.progress] (#14077). */
internal const val SET_PROGRESS_NODE_ACTION = "set_progress"

/** Arguments a node action may carry beyond its name (#14077). */
data class NodeActionArguments(
  /** For [CUSTOM_NODE_ACTION]: the label of the app-defined action to perform. */
  val customAction: String? = null,
  /** For [SET_PROGRESS_NODE_ACTION]: the value for ACTION_ARGUMENT_PROGRESS_VALUE. */
  val progress: Float? = null,
)

/** What the target node reports about itself, for [decideNodeAction]. */
internal data class NodeActionState(
  val isAccessibilityFocused: Boolean,
  /** The ids of the actions the node offers, or null when its action list is unknown. */
  val availableActionIds: Collection<Int>?,
  /** Labels of the node's actions by id, which name its app-defined (custom) actions. */
  val actionLabels: Map<Int, String> = emptyMap(),
)

private data class StandardNodeAction(val id: Int, val minSdk: Int = 0)

/**
 * Every standard node action the host can request by name, in the order refusals list them. Each
 * entry is gated at runtime against the device's SDK level by [StandardNodeAction.minSdk]; the
 * module's minSdk (24) already covers every entry without one.
 */
@SuppressLint("InlinedApi")
private val STANDARD_NODE_ACTIONS: Map<String, StandardNodeAction> =
  linkedMapOf(
    "click" to StandardNodeAction(AccessibilityNodeInfo.ACTION_CLICK),
    "long_click" to StandardNodeAction(AccessibilityNodeInfo.ACTION_LONG_CLICK),
    "focus" to StandardNodeAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS),
    "clear_focus" to StandardNodeAction(AccessibilityNodeInfo.ACTION_CLEAR_ACCESSIBILITY_FOCUS),
    "scroll_forward" to StandardNodeAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD),
    "scroll_backward" to StandardNodeAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD),
    "expand" to StandardNodeAction(AccessibilityNodeInfo.ACTION_EXPAND),
    "collapse" to StandardNodeAction(AccessibilityNodeInfo.ACTION_COLLAPSE),
    "dismiss" to StandardNodeAction(AccessibilityNodeInfo.ACTION_DISMISS),
    "select" to StandardNodeAction(AccessibilityNodeInfo.ACTION_SELECT),
    "clear_selection" to StandardNodeAction(AccessibilityNodeInfo.ACTION_CLEAR_SELECTION),
    "show_on_screen" to StandardNodeAction(android.R.id.accessibilityActionShowOnScreen),
    "scroll_up" to StandardNodeAction(android.R.id.accessibilityActionScrollUp),
    "scroll_down" to StandardNodeAction(android.R.id.accessibilityActionScrollDown),
    "scroll_left" to StandardNodeAction(android.R.id.accessibilityActionScrollLeft),
    "scroll_right" to StandardNodeAction(android.R.id.accessibilityActionScrollRight),
    "page_up" to StandardNodeAction(android.R.id.accessibilityActionPageUp, minSdk = 29),
    "page_down" to StandardNodeAction(android.R.id.accessibilityActionPageDown, minSdk = 29),
    "page_left" to StandardNodeAction(android.R.id.accessibilityActionPageLeft, minSdk = 29),
    "page_right" to StandardNodeAction(android.R.id.accessibilityActionPageRight, minSdk = 29),
    "press_and_hold" to
      StandardNodeAction(android.R.id.accessibilityActionPressAndHold, minSdk = 30),
    SET_PROGRESS_NODE_ACTION to StandardNodeAction(android.R.id.accessibilityActionSetProgress),
  )

/**
 * Why [action] cannot be sent to a node offering [availableActionIds], or null when it can.
 * [actionLabels] (id to label) lets a refusal name the app-defined actions the node does offer.
 */
internal fun nodeActionFailure(
  action: String,
  availableActionIds: Collection<Int>?,
  sdkInt: Int = Build.VERSION.SDK_INT,
  actionLabels: Map<Int, String> = emptyMap(),
): String? {
  val standard = STANDARD_NODE_ACTIONS[action] ?: return "Unsupported accessibility action: $action"
  if (sdkInt < standard.minSdk) {
    return "Accessibility action $action needs Android API ${standard.minSdk} (device is API $sdkInt)"
  }
  if (availableActionIds != null && standard.id !in availableActionIds) {
    return "Accessibility action is unavailable: $action" +
      availableActionsSuffix(availableActionIds, actionLabels)
  }
  return null
}

/**
 * The actions a node offers, by the names a host can request: standard names, then `custom:label`.
 */
internal fun availableNodeActionNames(
  availableActionIds: Collection<Int>,
  actionLabels: Map<Int, String>,
): List<String> =
  availableActionIds
    .mapNotNull { id ->
      STANDARD_NODE_ACTIONS.entries.firstOrNull { it.value.id == id }?.key
        ?: actionLabels[id]?.let { "$CUSTOM_NODE_ACTION:$it" }
    }
    .distinct()

private fun availableActionsSuffix(
  availableActionIds: Collection<Int>,
  actionLabels: Map<Int, String>,
): String {
  val names = availableNodeActionNames(availableActionIds, actionLabels)
  return if (names.isEmpty()) "" else " (available: ${names.joinToString(", ")})"
}

/** What to do with a node action request given the node's current state (issue #10148). */
internal sealed interface NodeActionDecision {
  /** Send [actionId] to the node, with ACTION_ARGUMENT_PROGRESS_VALUE when [progress] is set. */
  data class Perform(val actionId: Int, val progress: Float? = null) : NodeActionDecision

  /** The node is already in the requested state; no action is sent and the request succeeds. */
  data object AlreadySatisfied : NodeActionDecision

  /** The request cannot be honored; [message] is the failure reported to the host. */
  data class Refused(val message: String) : NodeActionDecision
}

/**
 * Accessibility focus is state, not a one-shot action: a node holding accessibility focus
 * advertises only ACTION_CLEAR_ACCESSIBILITY_FOCUS and an unfocused node only
 * ACTION_ACCESSIBILITY_FOCUS. So `focus` on an already-focused node and `clear_focus` on an
 * unfocused node are satisfied as-is, rather than refused as "unavailable". Every other case keeps
 * the availability check.
 */
internal fun decideNodeAction(
  action: String,
  state: NodeActionState,
  sdkInt: Int = Build.VERSION.SDK_INT,
  arguments: NodeActionArguments = NodeActionArguments(),
): NodeActionDecision {
  val (isAccessibilityFocused, availableActionIds, actionLabels) = state
  if (action == "focus" && isAccessibilityFocused) return NodeActionDecision.AlreadySatisfied
  if (action == "clear_focus" && !isAccessibilityFocused) return NodeActionDecision.AlreadySatisfied
  if (action == CUSTOM_NODE_ACTION) {
    return decideCustomNodeAction(arguments.customAction, availableActionIds, actionLabels)
  }
  nodeActionFailure(action, availableActionIds, sdkInt, actionLabels)?.let {
    return NodeActionDecision.Refused(it)
  }
  val actionId =
    nodeActionId(action, sdkInt)
      ?: return NodeActionDecision.Refused("Unsupported accessibility action: $action")
  if (action != SET_PROGRESS_NODE_ACTION) return NodeActionDecision.Perform(actionId)
  val progress = arguments.progress
  return if (progress == null || !progress.isFinite()) {
    NodeActionDecision.Refused("set_progress requires a finite progress value")
  } else {
    NodeActionDecision.Perform(actionId, progress)
  }
}

/**
 * An app-defined action is matched by its label, exactly first and then ignoring case. A node whose
 * action list is unknown cannot be matched.
 */
private fun decideCustomNodeAction(
  label: String?,
  availableActionIds: Collection<Int>?,
  actionLabels: Map<Int, String>,
): NodeActionDecision {
  if (label.isNullOrBlank()) {
    return NodeActionDecision.Refused("custom requires the label of the action to perform")
  }
  val labeled = availableActionIds.orEmpty().mapNotNull { id -> actionLabels[id]?.let { id to it } }
  val match =
    labeled.firstOrNull { it.second == label }
      ?: labeled.firstOrNull { it.second.equals(label, ignoreCase = true) }
  return match?.let { NodeActionDecision.Perform(it.first) }
    ?: NodeActionDecision.Refused(
      "Custom accessibility action is unavailable: $label" +
        availableActionsSuffix(availableActionIds.orEmpty(), actionLabels),
    )
}

internal fun nodeActionId(action: String, sdkInt: Int = Build.VERSION.SDK_INT): Int? =
  STANDARD_NODE_ACTIONS[action]?.takeIf { sdkInt >= it.minSdk }?.id
