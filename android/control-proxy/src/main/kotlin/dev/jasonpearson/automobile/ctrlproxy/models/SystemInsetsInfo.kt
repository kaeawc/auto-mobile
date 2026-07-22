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
)
