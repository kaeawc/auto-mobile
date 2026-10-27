package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.ui.Modifier

data class StatusBarState(
  val crashCount: Int,
  val anrCount: Int,
  val nonFatalCount: Int,
  val toolFailureCount: Int,
  val currentFps: Float?,
  val currentMemoryMb: Float?,
  val isDaemonConnected: Boolean,
  val isStreamConnected: Boolean,
  val modifier: Modifier = Modifier,
)
