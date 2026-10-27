package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*

internal fun stackPopTarget(
  root: PrototypeRenderNode,
  stacks: Map<String, PrototypeStackSnapshot>,
): String? {
  var target: String? = null
  fun visit(node: PrototypeRenderNode) {
    if (!node.visible || node.role in PROTOTYPE_MODAL_ROLES) return
    val stack = node.source as? PrototypeStackNode
    if (stack != null && (stacks[stack.id]?.depth ?: 1) > 1) target = stack.id
    // Visit parents before children: a nested top-screen stack wins over its ancestor.
    // Among siblings the last eligible stack in document order wins, matching render order.
    val children =
      if (node.role == "pager") listOfNotNull(node.children.getOrNull(node.page)) else node.children
    children.forEach(::visit)
  }
  visit(root)
  // Hoisted modals render last; stacks in their visible bodies take Back before inline ones.
  modalPrototypeSheets(root).forEach { modal -> modal.children.forEach(::visit) }
  return target
}
