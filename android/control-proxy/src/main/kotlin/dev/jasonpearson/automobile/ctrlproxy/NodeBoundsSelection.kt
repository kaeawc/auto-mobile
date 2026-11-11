package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import dev.jasonpearson.automobile.protocol.NodeSelector

/** Nullable coordinates preserve partial wire bounds so they can be refused rather than ignored. */
data class NodeExpectedBounds(
  val left: Int?,
  val top: Int?,
  val right: Int?,
  val bottom: Int?,
) {
  fun matches(node: AccessibilityNodeInfo): Boolean {
    val expected = listOf(left, top, right, bottom)
    if (expected.any { it == null }) return false
    val bounds = Rect()
    node.getBoundsInScreen(bounds)
    return listOf(bounds.left, bounds.top, bounds.right, bounds.bottom) == expected
  }
}

/** All selector matches, including invisible nodes. The caller owns the returned nodes. */
internal fun findNodesBySelector(
  root: AccessibilityNodeInfo,
  selector: NodeSelector,
): List<AccessibilityNodeInfo> {
  val matches = mutableListOf<AccessibilityNodeInfo>()
  if (matchesSelector(root, selector)) matches += root
  for (index in 0 until root.childCount) {
    val child = root.getChild(index) ?: continue
    val found = findNodesBySelector(child, selector)
    matches += found
    if (found.none { it === child }) child.recycle()
  }
  return matches
}

/** Exact clickable bounds matches across a tree. The caller owns the returned nodes. */
internal fun findNodesByBounds(
  root: AccessibilityNodeInfo,
  expectedBounds: NodeExpectedBounds,
): List<AccessibilityNodeInfo> {
  val matches = mutableListOf<AccessibilityNodeInfo>()
  if (
    expectedBounds.matches(root) &&
      root.actionList.any { it.id == AccessibilityNodeInfo.ACTION_CLICK }
  ) {
    matches += root
  }
  for (index in 0 until root.childCount) {
    val child = root.getChild(index) ?: continue
    val found = findNodesByBounds(child, expectedBounds)
    matches += found
    if (found.none { it === child }) child.recycle()
  }
  return matches
}

/** Panel bounds must never be compared to physical display dimensions. Releases every non-hit. */
internal fun selectNodeWithBounds(
  nodes: List<AccessibilityNodeInfo>,
  expectedBounds: NodeExpectedBounds,
): AccessibilityNodeInfo {
  val qualifying = nodes.filter {
    val bounds = Rect()
    it.getBoundsInScreen(bounds)
    bounds.width() > 0 && bounds.height() > 0 && expectedBounds.matches(it)
  }
  val selected = qualifying.singleOrNull()
  nodes.forEach { if (it !== selected) it.recycle() }
  return selected
    ?: throw IllegalStateException(
      if (qualifying.isEmpty()) {
        "node_bounds_mismatch: No node match has the expected bounds"
      } else {
        "node_bounds_ambiguous: Multiple node matches have the expected bounds"
      },
    )
}
