package dev.jasonpearson.automobile.desktop.core.workspace.picker

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.rememberLiveVideoFrame
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamClient
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamQuality
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamSource
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamState
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.jetbrains.skia.Image as SkiaImage

private val LOG = LoggerFactory.getLogger("DeviceThumbnail")

/** Height of a grid device thumbnail; the frame is aspect-fit centered on black inside it. */
private val THUMBNAIL_HEIGHT = 132.dp

// Frame-rate hint for a grid thumbnail's live mirror. Even lower than a workspace pane: thumbnails
// are glanceable, non-interactive previews, so a slow rate keeps a farm of dozens of concurrent
// on-device H.264 encodes cheap. (Captures are shared per device on the daemon and the first
// subscriber fixes the encode, so a device also open in a higher-rate pane keeps the pane's rate.)
private const val THUMBNAIL_FPS = 5

/**
 * The static label a non-booted card shows over its black thumbnail: `"Booting"` while a boot is in
 * flight (its id is in the picker's `bootingIds`), `"Shutdown"` for a shut-down device, and null
 * for a booted device (its live video / screenshot renders instead). Pure so a same-module test can
 * pin the wording without composing the view. `bootingIds` is a subset of the shut-down ids, so a
 * booted device never reads as booting.
 *
 * A future "shutting down" transient (the grid has no kill path today) plugs in as one more branch
 * ahead of the shut-down case.
 */
internal fun thumbnailPlaceholder(state: DeviceState, booting: Boolean): String? =
  when {
    booting -> "Booting"
    state == DeviceState.Shutdown -> "Shutdown"
    else -> null
  }

/**
 * A last-known screenshot for a device, used as the thumbnail fallback when live video is absent.
 */
interface DeviceThumbnailScreenshotSource {
  /** The most recent screenshot for [deviceId], or null when none can be captured. */
  suspend fun latest(deviceId: String): ImageBitmap?
}

/**
 * Device thumbnail for a picker grid card.
 * - **Booted** → the daemon's live video relay (a `low`-quality [VideoStreamClient] per card,
 *   shared captures on the daemon make many cards affordable), aspect-fit on black.
 * - **Booted but no live frame** (relay predates this daemon or the subscribe was refused) → the
 *   last available screenshot from [screenshotSource], fetched lazily only once the relay reports
 *   `Unavailable`, so the fallback stays cheap.
 * - **Shut-down / booting** → a solid black box with a centered "Shutdown" / "Booting" label.
 *
 * [videoSourceFactory] and [screenshotSource] are hoisted so a test drives this with a
 * `FakeVideoStreamSource` and a fake screenshot source instead of opening sockets.
 */
@Composable
fun DeviceThumbnail(
  device: PickerDevice,
  booting: Boolean,
  sessionUuidProvider: () -> String?,
  modifier: Modifier = Modifier,
  videoSourceFactory: (deviceId: String) -> VideoStreamSource = { deviceId ->
    VideoStreamClient(
      quality = VideoStreamQuality.Low,
      fps = THUMBNAIL_FPS,
      sessionUuidProvider = sessionUuidProvider,
    )
  },
  screenshotSource: DeviceThumbnailScreenshotSource? = ObservationScreenshotSource,
) {
  Box(
    modifier =
      modifier.clip(RoundedCornerShape(4.dp)).background(Color.Black).semantics {
        contentDescription = "Thumbnail ${device.name}"
      },
    contentAlignment = Alignment.Center,
  ) {
    val placeholder = thumbnailPlaceholder(device.state, booting)
    if (placeholder != null) {
      Text(placeholder, color = Color.White.copy(alpha = 0.6f), fontSize = 12.sp)
    } else {
      LiveThumbnail(device.id, device.name, videoSourceFactory, screenshotSource)
    }
  }
}

@Composable
private fun LiveThumbnail(
  deviceId: String,
  deviceName: String,
  videoSourceFactory: (deviceId: String) -> VideoStreamSource,
  screenshotSource: DeviceThumbnailScreenshotSource?,
) {
  val source = remember(deviceId) { videoSourceFactory(deviceId) }
  val liveFrame = rememberLiveVideoFrame(source, deviceId, autoReconnect = true)
  val state by source.state.collectAsState()
  val bitmap = liveFrame?.bitmap

  // Fetch the screenshot fallback lazily the first time the relay reports Unavailable, and keep it
  // —
  // so a daemon that predates the relay still shows a still, without paying for an observation
  // stream
  // while live video is working. Keyed on deviceId only (NOT the live stream state): auto-reconnect
  // cycles Connecting<->Unavailable, and keying on the full state would cancel and restart the
  // capture on every flip — the 1s reconnect backoff would abort it before its own 5s timeout could
  // ever complete. Waiting on the source flow here lets one capture run to completion; the `when`
  // below still prefers a live frame if one arrives.
  var screenshot by remember(deviceId) { mutableStateOf<ImageBitmap?>(null) }
  LaunchedEffect(deviceId, screenshotSource) {
    if (screenshotSource == null) return@LaunchedEffect
    source.state.first { it is VideoStreamState.Unavailable }
    if (screenshot == null) {
      screenshot = screenshotSource.latest(deviceId)
    }
  }

  val fallback = screenshot
  when {
    bitmap != null ->
      Image(
        bitmap = bitmap,
        contentDescription = "Live thumbnail of $deviceName",
        modifier = Modifier.fillMaxSize(),
        contentScale = ContentScale.Fit,
      )
    fallback != null ->
      Image(
        bitmap = fallback,
        contentDescription = "Screenshot of $deviceName",
        modifier = Modifier.fillMaxSize(),
        contentScale = ContentScale.Fit,
      )
    else ->
      Text(
        liveHint(state),
        color = Color.White.copy(alpha = 0.5f),
        fontSize = 11.sp,
        textAlign = TextAlign.Center,
        modifier = Modifier.padding(8.dp),
      )
  }
}

/** One-line hint shown on a booted card that has neither a live frame nor a screenshot yet. */
private fun liveHint(state: VideoStreamState): String =
  when (state) {
    is VideoStreamState.Idle,
    is VideoStreamState.Connecting -> "Connecting…"
    is VideoStreamState.Streaming -> "Waiting for frame…"
    is VideoStreamState.Unavailable -> "No preview"
  }

/** Fixed thumbnail height, exposed so the card lays out the row above/below it consistently. */
internal val DeviceThumbnailHeight = THUMBNAIL_HEIGHT

/**
 * Screenshot fallback backed by a one-shot [ObservationStream] observation, cached per device for
 * the process lifetime so a card that scrolls off and back does not re-capture. System-touching, so
 * (like the workspace's screenshot capture) it is exercised only in manual/production runs; tests
 * inject a fake [DeviceThumbnailScreenshotSource].
 */
object ObservationScreenshotSource : DeviceThumbnailScreenshotSource {
  private const val CAPTURE_TIMEOUT_MS = 5_000L
  private val cache = ConcurrentHashMap<String, ImageBitmap>()
  private val streamFactory: () -> ObservationStream = { ObservationStreamClient() }

  override suspend fun latest(deviceId: String): ImageBitmap? {
    cache[deviceId]?.let {
      return it
    }
    val stream = streamFactory()
    return try {
      val base64 =
        withContext(Dispatchers.IO) {
          stream.connect(deviceId)
          stream.requestObservation(deviceId)
          withTimeoutOrNull(CAPTURE_TIMEOUT_MS) {
            stream.screenshotUpdates.first { !it.screenshotBase64.isNullOrEmpty() }.screenshotBase64
          }
        }
      base64?.let {
        val bytes = Base64.getDecoder().decode(it)
        val bitmap =
          withContext(Dispatchers.Default) {
            SkiaImage.makeFromEncoded(bytes).toComposeImageBitmap()
          }
        cache[deviceId] = bitmap
        bitmap
      }
    } catch (cancellation: CancellationException) {
      throw cancellation
    } catch (error: Exception) {
      LOG.warn("Thumbnail screenshot fallback failed for $deviceId: ${error.message}", error)
      null
    } finally {
      withContext(NonCancellable + Dispatchers.IO) { stream.dispose() }
    }
  }
}
