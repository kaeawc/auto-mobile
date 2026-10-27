package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeAdaptiveNode
import dev.jasonpearson.automobile.protocol.PrototypeStackSnapshot

/** Back in a one-pane layout clears selection or closes the supporting pane. */
internal fun adaptiveBackTarget(
  root: PrototypeRenderNode,
  expanded: Boolean,
  stacks: Map<String, PrototypeStackSnapshot> = emptyMap(),
): PrototypeInteraction? {
  if (!root.visible) return null
  val children = adaptiveActiveChildren(root, expanded)
  children
    .asReversed()
    .firstNotNullOfOrNull { adaptiveBackTarget(it, expanded, stacks) }
    ?.let {
      return it
    }
  if (children.any { stackPopTarget(it, stacks) != null }) return null
  return if (expanded) null else adaptiveOwnBack(root)
}

private fun adaptiveActiveChildren(
  node: PrototypeRenderNode,
  expanded: Boolean,
): List<PrototypeRenderNode> {
  if (node.role == "pager") return listOfNotNull(node.children.getOrNull(node.page))
  val source = node.source as? PrototypeAdaptiveNode ?: return node.children
  val slot =
    when (source.kind) {
      "listDetail" ->
        if (expanded) null else if (node.selectedValue.isNullOrEmpty()) "list" else "detail"
      "supporting" ->
        if (expanded && node.checked) null else if (node.checked) "supporting" else "main"
      else -> null
    }
  return if (slot == null) node.children
  else node.children.filter { it.identity == "${node.identity}.$slot" }
}

private fun adaptiveOwnBack(node: PrototypeRenderNode): PrototypeInteraction? {
  val source = node.source as? PrototypeAdaptiveNode ?: return null
  return when (source.kind) {
    "listDetail" ->
      if (node.selectedValue.isNullOrEmpty()) null
      else PrototypeInteraction.Choose(checkNotNull(source.selectionKey), "")
    "supporting" ->
      if (node.checked) PrototypeInteraction.Toggle(checkNotNull(source.openKey)) else null
    else -> null
  }
}
