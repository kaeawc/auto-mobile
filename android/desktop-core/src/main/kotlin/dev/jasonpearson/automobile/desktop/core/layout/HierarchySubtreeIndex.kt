package dev.jasonpearson.automobile.desktop.core.layout

data class HierarchySubtreeIndex(
  val map: LinkedHashMap<String, UIElementInfo>,
  val node: UIElementInfo,
  val parentKey: String,
  val siblingIndex: Int,
  val keyMode: DiffKeyMode,
  val parentRole: StructuralRole?,
)
