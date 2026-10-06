package dev.jasonpearson.automobile.ctrlproxy

import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo

/**
 * Run [find] over the active window first, then over the other windows the hierarchy extractor
 * reports (in the extractor's own topmost-first order), and return the first hit. The widening
 * keeps a node that `observe` listed from any window of the display actionable, not only one in
 * `rootInActiveWindow` (issue #10070).
 *
 * The active window goes first so that a bare id that matches in both the app and a non-app window
 * (the IME, a system bar, a permission dialog) resolves to the app node, and so that an app node
 * that vanished replies "Element not found" from the app's own window before any other window is
 * consulted. The framework's z-order lists the IME and system UI windows ahead of the app window,
 * so a plain topmost-first scan would prefer them. The wire request carries no package, so the
 * lookup cannot exclude the IME or system UI outright: a selector that matches nowhere in the
 * active window can still resolve to a same-id node in another window of the display.
 *
 * Ownership: every root acquired here is recycled unless [find] returns it (a descendant it returns
 * is its own copy). The caller owns the returned node. [activeRoot] is read once, up front; a
 * listed window that reports itself active is not searched again when the active root was already
 * searched.
 */
internal fun findNodeAcrossWindows(
  windows: List<AccessibilityWindowInfo>,
  activeRoot: () -> AccessibilityNodeInfo?,
  find: (AccessibilityNodeInfo) -> AccessibilityNodeInfo?,
): AccessibilityNodeInfo? {
  val active = activeRoot()
  val activeSearched = active != null
  findInRoot(active, find)?.let {
    return it
  }
  for (window in windows) {
    if (activeSearched && window.isActive) continue
    findInRoot(window.root, find)?.let {
      return it
    }
  }
  return null
}

private fun findInRoot(
  root: AccessibilityNodeInfo?,
  find: (AccessibilityNodeInfo) -> AccessibilityNodeInfo?,
): AccessibilityNodeInfo? {
  if (root == null) return null
  var found: AccessibilityNodeInfo? = null
  try {
    found = find(root)
    return found
  } finally {
    if (found !== root) root.recycle()
  }
}

/**
 * The node focus should move to when stepping from the node [isCurrent] identifies, forward or
 * backward in tree order, or null when the current node is missing or there is no eligible
 * neighbour. Disabled, invisible, non-focusable and non-editable nodes are skipped
 * ([selectAdjacentCandidate]). [nodes] are pooled copies in document order; each is released
 * exactly once — all but the returned node — so no copy is recycled twice (a second `recycle()`
 * throws "Already in the pool!" before API 33, issue #10071). The caller owns the returned node.
 */
internal fun selectAdjacentFocusable(
  nodes: List<AccessibilityNodeInfo>,
  forward: Boolean,
  isCurrent: (AccessibilityNodeInfo) -> Boolean,
): AccessibilityNodeInfo? {
  val candidates = nodes.map {
    FocusCandidate(
      isCurrent = isCurrent(it),
      editable = it.isEditable,
      focusable = it.isFocusable,
      visibleToUser = it.isVisibleToUser,
      enabled = it.isEnabled,
    )
  }
  val target = selectAdjacentCandidate(candidates, forward)?.let(nodes::get)
  nodes.forEach { if (it !== target) it.recycle() }
  return target
}

/** How a traversal attempt ended. */
internal enum class TraversalOutcome {
  /** A target accepted focus. */
  FOCUSED,
  /** At least one eligible target was found but every one refused focus. */
  REFUSED,
  /** No strategy produced an eligible target. */
  NO_TARGET,
}

/**
 * Moves focus with the first of the lazily evaluated [strategies] whose node is an eligible target
 * (not [isCurrent], an editable input, reachable by [isReachableFocusTarget]) AND accepts [focus].
 * A node that is not eligible, or that refuses focus, is recycled and the next strategy runs, so a
 * framework hint that resolves to the host view itself (for Compose, `AndroidComposeView`: it
 * passes the reachability check but refuses `ACTION_FOCUS`), a disabled node or a hidden one never
 * ends the attempt while a later strategy (ending at tree order) could still succeed. Each node is
 * recycled exactly once, here.
 */
internal fun focusFirstTraversalTarget(
  strategies: List<() -> AccessibilityNodeInfo?>,
  isCurrent: (AccessibilityNodeInfo) -> Boolean,
  focus: (AccessibilityNodeInfo) -> Boolean,
): TraversalOutcome {
  var refused = false
  for (strategy in strategies) {
    val node = strategy() ?: continue
    try {
      if (!isEligibleTraversalTarget(node, isCurrent)) continue
      if (focus(node)) return TraversalOutcome.FOCUSED
      refused = true
    } finally {
      node.recycle()
    }
  }
  return if (refused) TraversalOutcome.REFUSED else TraversalOutcome.NO_TARGET
}

private fun isEligibleTraversalTarget(
  node: AccessibilityNodeInfo,
  isCurrent: (AccessibilityNodeInfo) -> Boolean,
): Boolean =
  !isCurrent(node) &&
    node.isEditable &&
    isReachableFocusTarget(node.isFocusable, node.isVisibleToUser, node.isEnabled)
