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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
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

// Backoff bounds for the screenshot-fallback capture retry (see captureScreenshotWithRetry).
private const val SCREENSHOT_RETRY_INITIAL_MS = 1_000L
private const val SCREENSHOT_RETRY_MAX_MS = 15_000L

/**
 * Capture a fallback still, retrying with bounded exponential backoff until one succeeds. Each
 * attempt first waits for the live relay to be [VideoStreamState.Unavailable] — there is no point
 * capturing an observation still while live video works (the caller prefers the frame), so a
 * recovered relay pauses retries. A single timed-out or too-early capture therefore no longer
 * leaves the card stuck on "No preview": when the observation service becomes ready, the next
 * attempt succeeds. The caller cancels this by leaving the composition. [delayMs] is injectable so
 * a test can drive the cadence without real time.
 */
internal suspend fun captureScreenshotWithRetry(
  state: StateFlow<VideoStreamState>,
  deviceId: String,
  source: DeviceThumbnailScreenshotSource,
  initialBackoffMs: Long = SCREENSHOT_RETRY_INITIAL_MS,
  maxBackoffMs: Long = SCREENSHOT_RETRY_MAX_MS,
  delayMs: suspend (Long) -> Unit = { delay(it) },
): ImageBitmap {
  var backoff = initialBackoffMs
  while (true) {
    state.first { it is VideoStreamState.Unavailable }
    source.latest(deviceId)?.let {
      return it
    }
    delayMs(backoff)
    backoff = (backoff * 2).coerceAtMost(maxBackoffMs)
  }
}

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

  // Fetch the screenshot fallback while the relay is Unavailable, retrying with backoff until it
  // yields a still — so a daemon that predates the relay (or the pristine home grid before a
  // session
  // is registered) still shows a frame, and a single timed-out/early capture doesn't leave the card
  // stuck on "No preview" once the observation service recovers. Keyed on deviceId only (NOT the
  // live
  // stream state): auto-reconnect cycles Connecting<->Unavailable, and keying on the full state
  // would
  // cancel and restart the capture on every flip. The retry pauses while live video works, and the
  // `when` below still prefers a live frame if one arrives.
  var screenshot by remember(deviceId) { mutableStateOf<ImageBitmap?>(null) }
  LaunchedEffect(deviceId, screenshotSource) {
    if (screenshotSource != null && screenshot == null) {
      screenshot = captureScreenshotWithRetry(source.state, deviceId, screenshotSource)
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
 * Screenshot fallback backed by a one-shot [ObservationStream] observation. Deliberately does NOT
 * cache across calls: the caller ([LiveThumbnail]) already holds the captured still in per-deviceId
 * composition state, and a booted card unmounts through the "Shutdown"/"Booting" placeholder on a
 * reboot — so a rebooted device (same AVD/simulator id) captures a fresh still rather than showing
 * the previous boot's screen indefinitely (which a process-lifetime cache keyed only by deviceId
 * would do). System-touching, so (like the workspace's screenshot capture) it is exercised only in
 * manual/production runs; tests inject a fake [DeviceThumbnailScreenshotSource].
 */
object ObservationScreenshotSource : DeviceThumbnailScreenshotSource {
  private const val CAPTURE_TIMEOUT_MS = 5_000L
  private val streamFactory: () -> ObservationStream = { ObservationStreamClient() }

  override suspend fun latest(deviceId: String): ImageBitmap? {
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
        withContext(Dispatchers.Default) {
          SkiaImage.makeFromEncoded(bytes).toComposeImageBitmap()
        }
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
