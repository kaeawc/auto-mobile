package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions

/** Settings shared by active-window and multi-window hierarchy capture. */
data class HierarchyExtractionOptions(
  val textFilter: String? = null,
  val screenDimensions: ScreenDimensions? = null,
  val dedupeTextContentDesc: Boolean = true,
  val disableAllFiltering: Boolean = false,
  val occlusionEnabled: Boolean = true,
  val snapshotOptions: HierarchySnapshotOptions = HierarchySnapshotOptions(),
  val displayId: Int? = null,
  val panelUniqueId: String? = null,
)
