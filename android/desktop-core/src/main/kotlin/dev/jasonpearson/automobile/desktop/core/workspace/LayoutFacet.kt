package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import dev.jasonpearson.automobile.desktop.core.LIVE_STALL_RECONNECT_MS
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.layout.LayoutInspectorDashboard
import dev.jasonpearson.automobile.desktop.core.rememberLiveVideoFrame
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamClient
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamQuality
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamSource
import kotlinx.coroutines.delay

// Stream hints for the inspector's live mirror. Inspection wants CRISP pixels (element bounds are
// read against them) but is mostly static, so High quality at a low rate is the right trade. When
// this facet is the device's only subscriber (Inspect mode replaces the pane's stream area) its
// hints fix the shared encode; when a pane already streams the device, the daemon keeps the first
// subscriber's encode and these hints are ignored.
private const val INSPECTOR_PANE_FPS = 10

/**
 * Docked-facet body for the Layout Inspector, scoped to a single pane's device. An
 * [ObservationStream] is created via [observationStreamFactory] and connected to [column]'s device
 * while the facet is shown, then disposed when it leaves composition or the device changes — the
 * same per-device connect/dispose lifecycle as [LogsFacet]. Each pane therefore drives its own
 * stream and mirror, rather than following the app's active device.
 *
 * The inspector's device panel renders LIVE VIDEO for its pixels (like the workspace video pane): a
 * [VideoStreamSource] is owned per device with the same retain-across-drops reconnect semantics, so
 * the panel never regresses to screenshots mid-session. The observation screenshot remains the
 * pre-video bootstrap and the capture the hierarchy overlay/selection maps against.
 *
 * [observationStreamFactory] is injected (defaulting to a real per-device
 * [ObservationStreamClient]) so the connect/dispose lifecycle can be verified with a
 * [FakeObservationStream] instead of real socket I/O. The stream reconnects automatically if it
 * drops while the facet is open (see [rememberReconnectingObservationStream]); [backoffDelay] and
 * [socketAvailable] are the injected timer/daemon-availability seams that let that recovery be
 * tested with virtual time. [videoSourceFactory] is the same seam for the live mirror, and
 * [sessionUuidProvider] authenticates its subscribe against the stream-socket session guard (#4751)
 * — the host supplies it from its `DesktopDaemonSession`.
 */
@Composable
fun LayoutFacet(
  column: DeviceColumn,
  observationStreamFactory: () -> ObservationStream = { ObservationStreamClient() },
  backoffDelay: suspend (attempt: Int) -> Unit = { attempt -> delay(reconnectBackoffMs(attempt)) },
  socketAvailable: () -> Boolean = { ObservationStreamClient.socketExists() },
  sessionUuidProvider: () -> String? = { null },
  videoSourceFactory: (deviceId: String) -> VideoStreamSource = {
    VideoStreamClient(
      quality = VideoStreamQuality.High,
      fps = INSPECTOR_PANE_FPS,
      sessionUuidProvider = sessionUuidProvider,
    )
  },
) {
  val stream =
    rememberReconnectingObservationStream(
      deviceId = column.deviceId,
      streamFactory = observationStreamFactory,
      backoffDelay = backoffDelay,
      socketAvailable = socketAvailable,
    )
  val videoSource = remember(column.deviceId) { videoSourceFactory(column.deviceId) }
  val liveFrame =
    rememberLiveVideoFrame(
      videoSource,
      column.deviceId,
      autoReconnect = true,
      // Streaming-stall reconnect only for idle-heartbeat sources (Android); the iOS capture drops
      // idle buffers, so a static inspected screen legitimately makes no frame progress.
      stallReconnectMs = if (column.platform == Platform.Android) LIVE_STALL_RECONNECT_MS else null,
    )
  stream?.let { activeStream ->
    LayoutInspectorDashboard(
      dataSourceMode = DataSourceMode.Real,
      observationStream = activeStream,
      deviceId = column.deviceId,
      platform = if (column.platform == Platform.Ios) "ios" else "android",
      liveFrame = liveFrame?.bitmap,
    )
  }
}
