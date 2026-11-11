package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import dev.jasonpearson.automobile.protocol.NodeSelector

/** Captured identity is additive on the wire so older clients can still send bounds alone. */
data class NodeIdentityHints(
  val className: String? = null,
  val text: String? = null,
  val contentDesc: String? = null,
  val labelText: String? = null,
  val labelContentDesc: String? = null,
) {
  fun matches(node: AccessibilityNodeInfo): Boolean =
    (className == null || node.className?.toString() == className) &&
      (text == null || node.text?.toString() == text) &&
      (contentDesc == null || node.contentDescription?.toString() == contentDesc) &&
      ((labelText == null && labelContentDesc == null) || matchesLabel(node))

  private fun ownLabelMatches(node: AccessibilityNodeInfo): Boolean {
    val textOk = labelText == null || node.text?.toString() == labelText
    val descOk = labelContentDesc == null || node.contentDescription?.toString() == labelContentDesc
    return textOk && descOk
  }

  private fun matchesLabel(node: AccessibilityNodeInfo): Boolean {
    if (ownLabelMatches(node)) return true
    for (index in 0 until node.childCount) {
      val child = node.getChild(index) ?: continue
      try {
        if (matchesLabel(child)) return true
      } finally {
        child.recycle()
      }
    }
    return false
  }
}

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

internal data class NodeBoundsConstraint(
  val expectedBounds: NodeExpectedBounds? = null,
  val identityHints: NodeIdentityHints? = null,
  val allowInvisible: Boolean = false,
)

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
  boundsOnly: Boolean = false,
  identityHints: NodeIdentityHints? = null,
  allowInvisible: Boolean = false,
): AccessibilityNodeInfo {
  val qualifying = nodes.filter {
    val bounds = Rect()
    it.getBoundsInScreen(bounds)
    val visible =
      if (boundsOnly || allowInvisible) bounds.width() > 0 && bounds.height() > 0
      else it.isVisibleToUser
    visible && expectedBounds.matches(it)
  }
  val selected = qualifying.singleOrNull()
  nodes.forEach { if (it !== selected) it.recycle() }
  if (selected == null) {
    throw IllegalStateException(
      if (qualifying.isEmpty()) {
        "node_bounds_mismatch: No node match has the expected bounds"
      } else {
        "node_bounds_ambiguous: Multiple node matches have the expected bounds"
      },
    )
  }
  if (boundsOnly && identityHints != null) {
    var matches = false
    try {
      matches = identityHints.matches(selected)
    } finally {
      if (!matches) selected.recycle()
    }
    if (!matches) {
      throw IllegalStateException(
        "node_identity_mismatch: Node at expected bounds has changed identity",
      )
    }
  }
  return selected
}
