package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.ui.semantics.SemanticsNode

/**
 * Mirrors accessibility traversal: unmerged [SemanticsNode.children] includes replaced semantics,
 * but Compose's accessibility delegate uses replacedChildren, which is empty for clearing nodes.
 * Keep the clearing node itself, even when its configuration is empty (such as a button label).
 */
internal fun SemanticsNode.accessibilityNodes(): List<SemanticsNode> =
  listOf(this) +
    if (config.isClearingSemantics) emptyList() else children.flatMap { it.accessibilityNodes() }
