package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.ObservationInsetsInfo
import dev.jasonpearson.automobile.ctrlproxy.models.SystemInsetsInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy

/** Metadata captured alongside a hierarchy, shared by every extraction route. */
internal data class HierarchyMetadata(
  val displayId: Int,
  val panelUniqueId: String?,
  val screenWidth: Int?,
  val screenHeight: Int?,
  val rotation: Int?,
  val systemInsets: SystemInsetsInfo?,
  val insets: ObservationInsetsInfo,
  val wakefulness: String?,
  val foregroundActivity: String?,
  val density: Int?,
  val sdkInt: Int,
  val deviceModel: String,
  val isEmulator: Boolean,
  val accessibilityTool: Boolean? = null,
)

/** Applies the complete metadata set to hierarchy results from either extraction route. */
internal object HierarchyMetadataBuilder {
  fun enrich(hierarchy: ViewHierarchy?, metadata: HierarchyMetadata): ViewHierarchy? =
    hierarchy?.copy(
      displayId = metadata.displayId,
      panelUniqueId = metadata.panelUniqueId,
      screenWidth = metadata.screenWidth,
      screenHeight = metadata.screenHeight,
      rotation = metadata.rotation,
      systemInsets = metadata.systemInsets,
      insets = metadata.insets,
      wakefulness = metadata.wakefulness,
      foregroundActivity = metadata.foregroundActivity,
      density = metadata.density,
      sdkInt = metadata.sdkInt,
      deviceModel = metadata.deviceModel,
      isEmulator = metadata.isEmulator,
      accessibilityTool = metadata.accessibilityTool,
    )
}
