package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import kotlinx.coroutines.delay

data class ReconnectingObservationOptions(
  val deviceId: String,
  val deviceSessionUuid: String? = null,
  val requireDeviceSessionUuid: Boolean = false,
  val streamFactory: () -> ObservationStream,
  val backoffDelay: suspend (attempt: Int) -> Unit = { attempt ->
    delay(reconnectBackoffMs(attempt))
  },
  val socketAvailable: () -> Boolean = { ObservationStreamClient.socketExists() },
)
