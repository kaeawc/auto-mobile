package dev.jasonpearson.automobile.desktop.core.layout

data class AlignedHierarchyChildren(
  val mapA: LinkedHashMap<String, UIElementInfo>,
  val mapB: LinkedHashMap<String, UIElementInfo>,
  val childrenA: List<UIElementInfo>,
  val slotsA: IntArray,
  val childrenB: List<UIElementInfo>,
  val slotsB: IntArray,
  val parentKey: String,
  val parentRoleA: StructuralRole?,
  val parentRoleB: StructuralRole?,
  val keyMode: DiffKeyMode,
)
