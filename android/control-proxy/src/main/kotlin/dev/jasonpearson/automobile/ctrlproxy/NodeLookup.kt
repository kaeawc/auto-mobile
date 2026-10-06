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
 * The node focus should move to when stepping backwards from the node [isCurrent] identifies, or
 * null when the current node is missing or first. [nodes] are pooled copies in document order; each
 * is released exactly once — all but the returned node — so no copy is recycled twice (a second
 * `recycle()` throws "Already in the pool!" before API 33, issue #10071). The caller owns the
 * returned node.
 */
internal fun selectPreviousFocusable(
  nodes: List<AccessibilityNodeInfo>,
  isCurrent: (AccessibilityNodeInfo) -> Boolean,
): AccessibilityNodeInfo? {
  val index = nodes.indexOfFirst(isCurrent)
  val previous = if (index > 0) nodes[index - 1] else null
  nodes.forEach { if (it !== previous) it.recycle() }
  return previous
}
