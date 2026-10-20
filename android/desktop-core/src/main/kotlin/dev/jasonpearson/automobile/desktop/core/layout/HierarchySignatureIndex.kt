package dev.jasonpearson.automobile.desktop.core.layout

data class HierarchySignatureIndex(
  val keys: MutableSet<String>,
  val node: UIElementInfo,
  val parentKey: String,
  val siblingIndex: Int,
  val keyMode: DiffKeyMode,
  val parentRole: StructuralRole?,
)
