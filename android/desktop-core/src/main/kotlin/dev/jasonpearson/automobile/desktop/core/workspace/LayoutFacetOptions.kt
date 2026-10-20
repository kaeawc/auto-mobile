package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.getValue
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamClient
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamQuality
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamSource
import kotlinx.coroutines.delay

data class LayoutFacetOptions(
  val column: DeviceColumn,
  val sessionUuidProvider: () -> String? = { null },
  val observationStreamFactory: () -> ObservationStream = {
    ObservationStreamClient(sessionUuidProvider = sessionUuidProvider)
  },
  val backoffDelay: suspend (attempt: Int) -> Unit = { attempt ->
    delay(reconnectBackoffMs(attempt))
  },
  val socketAvailable: () -> Boolean = { ObservationStreamClient.socketExists() },
  val streamingEnabled: Boolean = true,
  val videoSourceFactory: (deviceId: String) -> VideoStreamSource = {
    VideoStreamClient(
      VideoStreamClient.Options(
        quality = VideoStreamQuality.High,
        fps = INSPECTOR_PANE_FPS,
        sessionUuidProvider = sessionUuidProvider,
      ),
    )
  },
)
