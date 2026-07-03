package dev.jasonpearson.automobile.desktop.domain

public data class ScreenNode(
  val id: String,
  val name: String,
  val type: String,
  val packageName: String,
  val transitionCount: Int,
  val discoveredAt: Long,
  val screenshotUri: String? = null,
)

public data class ScreenTransition(
  val id: String,
  val fromScreen: String,
  val toScreen: String,
  val trigger: String,
  val element: String?,
  val avgLatencyMs: Int,
  val failureRate: Float,
  val traversalCount: Int = 1,
)

public data class NavigationGraph(
  val screens: List<ScreenNode>,
  val transitions: List<ScreenTransition>,
)
