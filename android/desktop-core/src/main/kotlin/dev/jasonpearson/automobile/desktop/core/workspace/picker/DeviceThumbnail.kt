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
import java.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.jetbrains.skia.Image as SkiaImage

private val LOG = LoggerFactory.getLogger("DeviceThumbnail")

/** Height of a grid device thumbnail; the frame is aspect-fit centered on black inside it. */
private val THUMBNAIL_HEIGHT = 132.dp

// Backoff bounds for the screenshot capture retry (see captureScreenshotWithRetry).
private const val SCREENSHOT_RETRY_INITIAL_MS = 1_000L
private const val SCREENSHOT_RETRY_MAX_MS = 15_000L

/**
 * Capture the thumbnail still, retrying with bounded exponential backoff until one succeeds. A
 * single timed-out or too-early capture must not leave the card stuck on its hint: when the
 * observation service becomes ready, the next attempt succeeds. The caller cancels this by leaving
 * the composition. [delayMs] is injectable so a test can drive the cadence without real time.
 */
internal suspend fun captureScreenshotWithRetry(
  deviceId: String,
  source: DeviceThumbnailScreenshotSource,
  initialBackoffMs: Long = SCREENSHOT_RETRY_INITIAL_MS,
  maxBackoffMs: Long = SCREENSHOT_RETRY_MAX_MS,
  delayMs: suspend (Long) -> Unit = { delay(it) },
): ImageBitmap {
  var backoff = initialBackoffMs
  while (true) {
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
 * for a booted device (its last screenshot renders instead). Pure so a same-module test can pin the
 * wording without composing the view. `bootingIds` is a subset of the shut-down ids, so a booted
 * device never reads as booting.
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

/** A last-known screenshot for a device, rendered as the grid thumbnail. */
interface DeviceThumbnailScreenshotSource {
  /** The most recent screenshot for [deviceId], or null when none can be captured. */
  suspend fun latest(deviceId: String): ImageBitmap?
}

/**
 * Device thumbnail for a picker grid card.
 * - **Booted** → the last observation screenshot, captured once per card via [screenshotSource] and
 *   aspect-fit on black. DELIBERATELY not live video: the grid can show hundreds of devices, and a
 *   per-card H.264 subscription would start a device capture/encode on the daemon and a decoder in
 *   the desktop for every booted tile — a glanceable preview is not worth that standing cost. Live
 *   video belongs to the workspace panes a device is actually opened into.
 * - **Shut-down / booting** → a solid black box with a centered "Shutdown" / "Booting" label.
 *
 * [screenshotSource] is hoisted so a test drives this with a fake instead of opening sockets.
 */
@Composable
fun DeviceThumbnail(
  device: PickerDevice,
  booting: Boolean,
  modifier: Modifier = Modifier,
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
      ScreenshotThumbnail(device.id, device.name, screenshotSource)
    }
  }
}

@Composable
private fun ScreenshotThumbnail(
  deviceId: String,
  deviceName: String,
  screenshotSource: DeviceThumbnailScreenshotSource?,
) {
  // One still per card mount, retried with backoff until the observation service yields one. Keyed
  // on deviceId: a rebooted device unmounts through the "Shutdown"/"Booting" placeholder, so a
  // fresh boot captures a fresh still rather than showing the previous boot's screen.
  var screenshot by remember(deviceId) { mutableStateOf<ImageBitmap?>(null) }
  LaunchedEffect(deviceId, screenshotSource) {
    if (screenshotSource != null && screenshot == null) {
      screenshot = captureScreenshotWithRetry(deviceId, screenshotSource)
    }
  }

  val still = screenshot
  if (still != null) {
    Image(
      bitmap = still,
      contentDescription = "Screenshot of $deviceName",
      modifier = Modifier.fillMaxSize(),
      contentScale = ContentScale.Fit,
    )
  } else {
    Text(
      "No preview yet",
      color = Color.White.copy(alpha = 0.5f),
      fontSize = 11.sp,
      textAlign = TextAlign.Center,
      modifier = Modifier.padding(8.dp),
    )
  }
}

/** Fixed thumbnail height, exposed so the card lays out the row above/below it consistently. */
internal val DeviceThumbnailHeight = THUMBNAIL_HEIGHT

/**
 * Thumbnail still backed by a one-shot [ObservationStream] observation. Deliberately does NOT cache
 * across calls: the caller ([ScreenshotThumbnail]) already holds the captured still in per-deviceId
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
      LOG.warn("Thumbnail screenshot capture failed for $deviceId: ${error.message}", error)
      null
    } finally {
      withContext(NonCancellable + Dispatchers.IO) { stream.dispose() }
    }
  }
}
