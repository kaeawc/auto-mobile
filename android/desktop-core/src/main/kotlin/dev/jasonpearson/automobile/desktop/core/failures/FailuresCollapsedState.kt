package dev.jasonpearson.automobile.desktop.core.failures

import androidx.compose.ui.Modifier

data class FailuresCollapsedState(
  val dateRangeLabel: String,
  val crashCount: Int,
  val anrCount: Int,
  val toolFailureCount: Int,
  val nonFatalCount: Int,
  val modifier: Modifier = Modifier,
)
