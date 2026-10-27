package dev.jasonpearson.automobile.ctrlproxy.prototype

internal fun usesPlainVisibility(node: PrototypeRenderNode): Boolean {
  val type = node.source?.transition?.type
  return node.role != "stack" &&
    node.source?.visibleWhen != null &&
    (type == "fade" || type == "none")
}
