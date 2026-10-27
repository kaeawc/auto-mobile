package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.ui.semantics.CustomAccessibilityAction

/**
 * The accessibility action names of a node's `onLongPress` and `onDoubleTap` lists (#15123), so a
 * TalkBack user reaches both without the coordinate gesture. Fixed English defaults, like the
 * escape pill's "Dismiss AutoMobile prototype"; the long click is the platform's own long-click
 * action, the double tap a custom action.
 */
internal const val PROTOTYPE_LONG_PRESS_ACTION_LABEL = "Long press"

internal const val PROTOTYPE_DOUBLE_TAP_ACTION_LABEL = "Double tap"

/** The custom accessibility action that runs a node's `onDoubleTap` list through [run]. */
internal fun prototypeDoubleTapAction(run: () -> Unit): CustomAccessibilityAction =
  CustomAccessibilityAction(PROTOTYPE_DOUBLE_TAP_ACTION_LABEL) {
    run()
    true
  }
