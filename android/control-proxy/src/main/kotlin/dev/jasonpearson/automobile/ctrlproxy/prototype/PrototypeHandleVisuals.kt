package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.runtime.compositionLocalOf

internal val LocalPrototypeHandleVisuals = compositionLocalOf<Set<String>> { emptySet() }

/** The renderer's generic tap handler, excluding roles whose components own their actions. */
internal fun prototypeNodeTappable(node: PrototypeRenderNode): Boolean =
  !node.source?.onTap.isNullOrEmpty() &&
    node.role != "textField" &&
    node.role !in PROTOTYPE_MODAL_ROLES &&
    node.role !in PROTOTYPE_COMPONENT_ROLES &&
    node.role !in PROTOTYPE_SELECTION_ROLES &&
    node.role !in PROTOTYPE_MATERIAL_ROLES

/** Preserve visual selector handles when their nearest tap owner has no visible text handle. */
internal fun prototypeHandleVisuals(root: PrototypeRenderNode): Set<String> {
  var handles: MutableSet<String>? = null
  fun visit(node: PrototypeRenderNode, inheritedOwner: HandleVisualOwner?) {
    if (!node.visible) return
    val tappable = prototypeNodeTappable(node)
    val owner =
      when {
        tappable -> if (node.contentDescription.isNullOrEmpty()) HandleVisualOwner() else null
        node.role in PROTOTYPE_MODAL_ROLES || node.source?.anchor != null -> null
        else -> inheritedOwner
      }
    if (owner != null && !owner.hasTextHandle) {
      if (node.role == "text" && node.text.isNotEmpty()) {
        owner.hasTextHandle = true
        owner.visuals = null
      } else if (node.role == "icon" || node.role == "image") {
        val visuals = owner.visuals ?: mutableListOf<String>().also { owner.visuals = it }
        visuals.add(node.identity)
      }
    }
    for (index in node.children.indices) visit(node.children[index], owner)
    if (tappable && owner != null && !owner.hasTextHandle) {
      owner.visuals?.let { visuals ->
        val result = handles ?: mutableSetOf<String>().also { handles = it }
        result.addAll(visuals)
      }
    }
  }
  visit(root, null)
  return handles ?: emptySet()
}

/** Allocated only for tap owners; candidate storage is lazy and discarded once text is found. */
private class HandleVisualOwner {
  var hasTextHandle = false
  var visuals: MutableList<String>? = null
}
