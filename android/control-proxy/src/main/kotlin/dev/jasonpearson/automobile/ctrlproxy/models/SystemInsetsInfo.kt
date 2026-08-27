package dev.jasonpearson.automobile.ctrlproxy.models

import kotlinx.serialization.Serializable

/** Insets on all four edges in physical pixels. */
@Serializable
data class SystemInsetsInfo(
  val top: Int = 0, // status bar
  val bottom: Int = 0, // nav bar
  val left: Int = 0, // gesture inset
  val right: Int = 0, // gesture inset
)

/** Separates visible system bars from their stable, temporarily-hidden extent. */
@Serializable
data class SystemBarsInsetsInfo(
  val visible: SystemInsetsInfo,
  val stable: SystemInsetsInfo,
)

/**
 * Physical display-cutout metadata, separate from the aggregate [SystemInsetsInfo] edge insets used
 * for safe-area calculations.
 *
 * Bounds are in the screen coordinate system and rotation captured with the enclosing
 * [ViewHierarchy]. Android only classifies shapes it can distinguish from their geometry.
 */
@Serializable
data class DisplayCutoutInfo(
  val classification: String,
  val bounds: List<ElementBounds>? = null,
) {
  companion object {
    private const val MIN_NOTCH_EDGE_FRACTION = 5
    private const val MAX_HOLE_PUNCH_DIMENSION_FRACTION = 6
    private const val MAX_HOLE_PUNCH_AREA_PERCENT = 1

    fun unknown(): DisplayCutoutInfo = DisplayCutoutInfo(classification = "unknown")

    /**
     * Classify Android's [android.view.DisplayCutout.boundingRects] conservatively.
     *
     * A broad shallow obstruction along an edge is a notch; a small contained obstruction that does
     * not touch an edge is a hole-punch. Anything else (including multiple cutouts) remains
     * explicit unknown rather than being guessed from camera capabilities or hardware model data.
     */
    fun fromBoundingRects(
      screenWidth: Int,
      screenHeight: Int,
      bounds: List<ElementBounds>,
    ): DisplayCutoutInfo {
      if (screenWidth <= 0 || screenHeight <= 0 || bounds.isEmpty()) {
        return unknown()
      }
      if (bounds.any { !it.isWithin(screenWidth, screenHeight) }) {
        return unknown()
      }
      if (bounds.size != 1) {
        return DisplayCutoutInfo(classification = "unknown", bounds = bounds)
      }

      val rect = bounds.single()
      if (rect.isBroadEdgeObstruction(screenWidth, screenHeight)) {
        return DisplayCutoutInfo(classification = "notch", bounds = bounds)
      }
      if (rect.isSmallInsetObstruction(screenWidth, screenHeight)) {
        return DisplayCutoutInfo(classification = "hole_punch", bounds = bounds)
      }
      return DisplayCutoutInfo(classification = "unknown", bounds = bounds)
    }

    fun none(): DisplayCutoutInfo = DisplayCutoutInfo(classification = "none")

    private fun ElementBounds.isWithin(screenWidth: Int, screenHeight: Int): Boolean =
      width > 0 &&
        height > 0 &&
        left >= 0 &&
        top >= 0 &&
        right <= screenWidth &&
        bottom <= screenHeight

    private fun ElementBounds.isBroadEdgeObstruction(screenWidth: Int, screenHeight: Int): Boolean =
      ((top == 0 || bottom == screenHeight) && width * MIN_NOTCH_EDGE_FRACTION >= screenWidth) ||
        ((left == 0 || right == screenWidth) && height * MIN_NOTCH_EDGE_FRACTION >= screenHeight)

    private fun ElementBounds.isSmallInsetObstruction(
      screenWidth: Int,
      screenHeight: Int,
    ): Boolean =
      !touchesDisplayEdge(screenWidth, screenHeight) &&
        width * MAX_HOLE_PUNCH_DIMENSION_FRACTION <= screenWidth &&
        height * MAX_HOLE_PUNCH_DIMENSION_FRACTION <= screenHeight &&
        width.toLong() * height.toLong() * 100 <=
          screenWidth.toLong() * screenHeight.toLong() * MAX_HOLE_PUNCH_AREA_PERCENT

    private fun ElementBounds.touchesDisplayEdge(screenWidth: Int, screenHeight: Int): Boolean =
      left == 0 || top == 0 || right == screenWidth || bottom == screenHeight
  }
}

/** Current system-chrome visibility, distinct from edge-to-edge layout policy. */
@Serializable
data class SystemChromeInfo(
  val visibility: String,
  val statusBar: String,
  val navigationBar: String? = null,
  val homeIndicatorAutoHideRequested: Boolean? = null,
  val source: String,
) {
  companion object {
    fun fromAndroidBars(
      statusBarVisible: Boolean,
      navigationBarVisible: Boolean,
    ): SystemChromeInfo {
      val visibility =
        when {
          statusBarVisible && navigationBarVisible -> "visible"
          !statusBarVisible && !navigationBarVisible -> "hidden"
          else -> "partial"
        }
      return SystemChromeInfo(
        visibility = visibility,
        statusBar = if (statusBarVisible) "visible" else "hidden",
        navigationBar = if (navigationBarVisible) "visible" else "hidden",
        source = "android-window-insets",
      )
    }
  }
}

/** Complete, typed inset snapshot captured with an accessibility hierarchy. */
@Serializable
data class ObservationInsetsInfo(
  val available: Boolean = true,
  val source: String = "android-window-metrics",
  val units: String = "physical-pixels",
  val systemBars: SystemBarsInsetsInfo? = null,
  val displayCutout: SystemInsetsInfo? = null,
  val displayCutoutInfo: DisplayCutoutInfo? = null,
  val systemGestures: SystemInsetsInfo? = null,
  val mandatorySystemGestures: SystemInsetsInfo? = null,
  val tappableElement: SystemInsetsInfo? = null,
  val systemChrome: SystemChromeInfo? = null,
)
