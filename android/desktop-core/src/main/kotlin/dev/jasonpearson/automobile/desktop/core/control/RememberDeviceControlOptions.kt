package dev.jasonpearson.automobile.desktop.core.control

import androidx.compose.runtime.getValue
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.DesktopInputAllocation
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers

data class RememberDeviceControlOptions(
  val scope: CoroutineScope,
  val clientProvider: (() -> AutoMobileClient)?,
  val inputAllocation: () -> DesktopInputAllocation,
  val platform: () -> String,
  val nowMs: () -> Long,
  val publishError: (String?) -> Unit,
  val streamingEnabled: Boolean,
  val uiContext: CoroutineContext = Dispatchers.Main,
  val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
)
