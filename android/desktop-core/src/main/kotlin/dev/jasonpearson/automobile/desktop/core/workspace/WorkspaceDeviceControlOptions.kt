package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import kotlinx.coroutines.Dispatchers

data class WorkspaceDeviceControlOptions(
  val column: DeviceColumn,
  val clientProvider: () -> AutoMobileClient?,
  val enabled: Boolean,
  val sessionUuidProvider: (() -> String?)? = null,
  val streamFactory: () -> ObservationStream = {
    createWorkspaceControlObservationClient(sessionUuidProvider = sessionUuidProvider)
  },
  val onDeviceHeldElsewhere: (deviceId: String) -> Unit = {},
  val ioDispatcher: kotlinx.coroutines.CoroutineDispatcher = kotlinx.coroutines.Dispatchers.Default,
)
