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

/** Complete, typed inset snapshot captured with an accessibility hierarchy. */
@Serializable
data class ObservationInsetsInfo(
  val available: Boolean = true,
  val source: String = "android-window-metrics",
  val units: String = "physical-pixels",
  val systemBars: SystemBarsInsetsInfo? = null,
  val displayCutout: SystemInsetsInfo? = null,
  val systemGestures: SystemInsetsInfo? = null,
  val mandatorySystemGestures: SystemInsetsInfo? = null,
  val tappableElement: SystemInsetsInfo? = null,
  val systemChrome: SystemChromeInfo? = null,
)
