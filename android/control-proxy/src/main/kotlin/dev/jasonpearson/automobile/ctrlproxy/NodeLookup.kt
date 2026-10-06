package dev.jasonpearson.automobile.ctrlproxy

import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo

/**
 * Run [find] over the same windows the hierarchy extractor reports, in the same order (the
 * framework's topmost-window-first order), and return the first hit. The extractor falls back to
 * the active window's root when the window list is empty or misses (see
 * [ViewHierarchyExtractor.extractFromAllWindows]); this lookup does the same, so a node that
 * `observe` listed from any window of the display is found by node actions and the accessibility
 * focus read-back, not only one in `rootInActiveWindow` (issue #10070).
 *
 * Ownership: every root acquired here is recycled unless [find] returns it (a descendant it returns
 * is its own copy). The caller owns the returned node. [activeRoot] is read lazily, so the common
 * case of a hit in a listed window never pays for it.
 */
internal fun findNodeAcrossWindows(
  windows: List<AccessibilityWindowInfo>,
  activeRoot: () -> AccessibilityNodeInfo?,
  find: (AccessibilityNodeInfo) -> AccessibilityNodeInfo?,
): AccessibilityNodeInfo? {
  for (window in windows) {
    findInRoot(window.root, find)?.let {
      return it
    }
  }
  return findInRoot(activeRoot(), find)
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
