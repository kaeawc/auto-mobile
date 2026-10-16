package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Rect
import android.os.Build
import android.view.accessibility.AccessibilityNodeInfo
import dev.jasonpearson.automobile.protocol.NodeSelector

// Stateless AccessibilityNodeInfo tree walks used by the service's node actions and IME focus
// traversal. They hold no service state, so they live here rather than on the service class.

/** Find the next focusable node after the given node in document order. */
internal fun findNextFocusableNode(
  root: AccessibilityNodeInfo?,
  currentNode: AccessibilityNodeInfo,
): AccessibilityNodeInfo? {
  if (root == null) return null

  // Collect all focusable editable nodes in document order
  val focusableNodes = mutableListOf<AccessibilityNodeInfo>()
  collectFocusableNodes(root, focusableNodes)

  // Find current node's position and return the next one
  var foundCurrent = false
  for (node in focusableNodes) {
    if (foundCurrent) {
      // This is the next node - return it (don't recycle it)
      // Recycle all remaining nodes
      focusableNodes.forEach { n -> if (n != node) n.recycle() }
      return node
    }
    if (isSameNode(node, currentNode)) {
      foundCurrent = true
    }
  }

  // If no next node found, recycle all collected nodes
  focusableNodes.forEach { it.recycle() }
  return null
}

/** Find the previous focusable node before the given node in document order. */
internal fun findPreviousFocusableNode(
  root: AccessibilityNodeInfo?,
  currentNode: AccessibilityNodeInfo,
): AccessibilityNodeInfo? {
  if (root == null) return null

  // Collect all focusable editable nodes in document order
  val focusableNodes = mutableListOf<AccessibilityNodeInfo>()
  collectFocusableNodes(root, focusableNodes)

  // Find current node's position and return the previous one. Each copy is released exactly once.
  return selectPreviousFocusable(focusableNodes) { isSameNode(it, currentNode) }
}

/** Collect all focusable and editable nodes in document order (pre-order traversal). */
internal fun collectFocusableNodes(
  node: AccessibilityNodeInfo,
  result: MutableList<AccessibilityNodeInfo>,
) {
  // Approximate traversal must only include editors the user can reach.
  if (
    isImeFocusCandidate(
      ImeFocusCandidate(node.isEditable, node.isFocusable, node.isVisibleToUser, node.isEnabled),
    )
  ) {
    // Create a copy to add to our list (we'll recycle the originals as we traverse)
    result.add(AccessibilityNodeInfo.obtain(node))
  }

  // Traverse children in order
  for (i in 0 until node.childCount) {
    val child = node.getChild(i) ?: continue
    collectFocusableNodes(child, result)
    child.recycle()
  }
}

/** Check if two AccessibilityNodeInfo objects refer to the same node. */
internal fun isSameNode(
  node1: AccessibilityNodeInfo,
  node2: AccessibilityNodeInfo,
): Boolean {
  // Compare by bounds and text/id since we can't reliably compare node objects directly
  val bounds1 = Rect()
  val bounds2 = Rect()
  node1.getBoundsInScreen(bounds1)
  node2.getBoundsInScreen(bounds2)
  return bounds1 == bounds2 &&
    node1.viewIdResourceName == node2.viewIdResourceName &&
    node1.text?.toString() == node2.text?.toString()
}

internal fun findNodeBySelector(
  root: AccessibilityNodeInfo?,
  selector: NodeSelector,
): AccessibilityNodeInfo? {
  if (root == null) return null

  if (matchesSelector(root, selector)) {
    return root
  }

  for (i in 0 until root.childCount) {
    val child = root.getChild(i) ?: continue
    val found = findNodeBySelector(child, selector)
    if (found != null) {
      if (found != child) {
        child.recycle()
      }
      return found
    }
    child.recycle()
  }

  return null
}

internal fun matchesSelector(
  node: AccessibilityNodeInfo,
  selector: NodeSelector,
): Boolean =
  nodeSelectorMatches(
    selector,
    NodeSelectorFields(
      resourceId = node.viewIdResourceName,
      testTag = extractTestTag(node),
      uniqueId = if (Build.VERSION.SDK_INT >= 33) node.uniqueId else null,
      collectionRow = node.collectionItemInfo?.rowIndex,
      collectionColumn = node.collectionItemInfo?.columnIndex,
    ),
  )

internal fun extractTestTag(node: AccessibilityNodeInfo): String? {
  val extras = node.extras ?: return null
  val candidates =
    listOf(
      "androidx.compose.ui.semantics.testTag",
      "androidx.compose.ui.semantics.TestTag",
      "androidx.compose.ui.testTag",
      "testTag",
      "test-tag",
    )
  for (key in candidates) {
    val value = extras.get(key)?.toString()
    if (!value.isNullOrBlank()) {
      return value
    }
  }
  return extras
    .keySet()
    .firstOrNull { it.contains("testtag", ignoreCase = true) }
    ?.let { key ->
      extras.get(key)?.toString()
    }
}

/** Find the currently focused editable node. */
internal fun findFocusedEditableNode(
  root: AccessibilityNodeInfo?,
): AccessibilityNodeInfo? {
  if (root == null) return null

  // First try to find the input-focused node
  val focusedNode = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
  if (focusedNode != null && focusedNode.isEditable) {
    return focusedNode
  }
  focusedNode?.recycle()

  // Fallback: search for any focused editable node in hierarchy
  return findFocusedEditableInHierarchy(root)
}

/** Recursively search for a focused editable node in the hierarchy. */
internal fun findFocusedEditableInHierarchy(
  node: AccessibilityNodeInfo?,
): AccessibilityNodeInfo? {
  if (node == null) return null

  // Check if this node is focused and editable
  if (node.isFocused && node.isEditable) {
    return node
  }

  // Search children
  for (i in 0 until node.childCount) {
    val child = node.getChild(i) ?: continue
    val found = findFocusedEditableInHierarchy(child)
    if (found != null) {
      if (found != child) {
        child.recycle()
      }
      return found
    }
    child.recycle()
  }

  return null
}
