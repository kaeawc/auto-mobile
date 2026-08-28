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

/** A non-functional display region in the observation's physical-pixel coordinate space. */
@Serializable
data class DisplayCutoutBoundsInfo(
  val left: Int,
  val top: Int,
  val right: Int,
  val bottom: Int,
) {
  val width: Int
    get() = right - left

  val height: Int
    get() = bottom - top
}

/** Display-cutout classification and, when available, its observed non-functional regions. */
@Serializable
data class DisplayCutoutInfo(
  val classification: String,
  val bounds: List<DisplayCutoutBoundsInfo>? = null,
) {
  companion object {
    val unknown = DisplayCutoutInfo(classification = "unknown")
  }
}

/** Conservative, geometry-only classification for Android DisplayCutout regions. */
object DisplayCutoutClassifier {
  private const val EDGE_TOLERANCE_PX = 1
  private const val MAX_COMPACT_SIZE_RATIO = 0.18
  private const val MAX_COMPACT_ASPECT_RATIO = 1.6
  private const val MIN_NOTCH_EDGE_RATIO = 0.22
  private const val MAX_NOTCH_DEPTH_RATIO = 0.12
  private const val MIN_NOTCH_ASPECT_RATIO = 2.0

  fun classify(
    bounds: List<DisplayCutoutBoundsInfo>,
    screen: ScreenDimensions,
    cutoutInsets: SystemInsetsInfo,
  ): String {
    if (bounds.isEmpty()) {
      return if (cutoutInsets == SystemInsetsInfo()) "none" else "unknown"
    }
    if (!screen.isValid()) return "unknown"

    val classifications = bounds.map { classifyRegion(it, screen) }
    return when {
      classifications.all { it == "hole_punch" } -> "hole_punch"
      classifications.all { it == "notch" } -> "notch"
      else -> "unknown"
    }
  }

  private fun classifyRegion(
    bounds: DisplayCutoutBoundsInfo,
    screen: ScreenDimensions,
  ): String {
    val horizontalEdge =
      when {
        bounds.top <= EDGE_TOLERANCE_PX -> true
        bounds.bottom >= screen.height - EDGE_TOLERANCE_PX -> true
        else -> false
      }
    val verticalEdge =
      when {
        bounds.left <= EDGE_TOLERANCE_PX -> true
        bounds.right >= screen.width - EDGE_TOLERANCE_PX -> true
        else -> false
      }
    if (horizontalEdge == verticalEdge || bounds.width <= 0 || bounds.height <= 0) return "unknown"

    val edgeLength = if (horizontalEdge) screen.width else screen.height
    val perpendicularLength = if (horizontalEdge) screen.height else screen.width
    val alongEdge = if (horizontalEdge) bounds.width else bounds.height
    val depth = if (horizontalEdge) bounds.height else bounds.width
    val aspectRatio = alongEdge.toDouble() / depth
    val compactSize = maxOf(bounds.width, bounds.height).toDouble()
    val shortestScreenEdge = minOf(screen.width, screen.height).toDouble()

    return when {
      compactSize <= shortestScreenEdge * MAX_COMPACT_SIZE_RATIO &&
        aspectRatio <= MAX_COMPACT_ASPECT_RATIO -> "hole_punch"
      alongEdge >= edgeLength * MIN_NOTCH_EDGE_RATIO &&
        depth <= perpendicularLength * MAX_NOTCH_DEPTH_RATIO &&
        aspectRatio >= MIN_NOTCH_ASPECT_RATIO -> "notch"
      else -> "unknown"
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
  val displayCutoutState: DisplayCutoutInfo = DisplayCutoutInfo.unknown,
  val systemGestures: SystemInsetsInfo? = null,
  val mandatorySystemGestures: SystemInsetsInfo? = null,
  val tappableElement: SystemInsetsInfo? = null,
  val systemChrome: SystemChromeInfo? = null,
)
