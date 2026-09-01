package dev.jasonpearson.automobile.desktop.core.workspace.picker

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
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
import dev.jasonpearson.automobile.desktop.core.daemon.ScreenshotStreamUpdate
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

/**
 * Width:height ratio of a thumbnail with no screenshot yet (shut-down, booting, or capture still
 * pending): a portrait-phone-ish stand-in so the staggered grid's placeholder cards stay compact.
 * Once a screenshot decodes, the card adopts that bitmap's true ratio — a landscape tablet goes
 * wide, a foldable goes square-ish — which is what gives the grid its masonry variety.
 */
internal const val PLACEHOLDER_THUMBNAIL_ASPECT = 0.62f

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

/**
 * Whether a stream frame is THIS card's thumbnail. The observation socket can deliver frames for
 * other subscribed devices (and a `replay = 1` stream can hand a new collector another device's
 * last frame), so a capture that accepts "any non-empty screenshot" attributes the fastest device's
 * frame to whichever card asked — an Android home screen on an iPhone card. Only a frame stamped
 * with this device's id qualifies; an unstamped frame is ambiguous and is skipped.
 */
internal fun isThumbnailFrameFor(deviceId: String, update: ScreenshotStreamUpdate): Boolean =
  update.deviceId == deviceId && !update.screenshotBase64.isNullOrEmpty()

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
  val placeholder = thumbnailPlaceholder(device.state, booting)
  // One still per boot, retried with backoff until the observation service yields one. The state
  // is hoisted here (not in a screenshot-only child) because the CARD's aspect ratio derives from
  // it; the placeholder reset below reproduces the old unmount-through-placeholder semantics, so a
  // rebooted device captures a fresh still rather than keeping the previous boot's screen.
  var screenshot by remember(device.id) { mutableStateOf<ImageBitmap?>(null) }
  LaunchedEffect(placeholder) {
    if (placeholder != null) {
      screenshot = null
    }
  }
  LaunchedEffect(device.id, screenshotSource, placeholder) {
    if (placeholder == null && screenshotSource != null && screenshot == null) {
      screenshot = captureScreenshotWithRetry(device.id, screenshotSource)
    }
  }

  val still = screenshot
  // Each card fits its own device: the decoded screenshot's ratio once available, a portrait
  // stand-in until then. This is what lets the staggered grid pack disjoint card heights.
  val aspect =
    if (still != null && still.height > 0) still.width.toFloat() / still.height
    else PLACEHOLDER_THUMBNAIL_ASPECT
  Box(
    modifier =
      modifier
        .aspectRatio(aspect)
        .clip(RoundedCornerShape(4.dp))
        .background(Color.Black)
        .semantics {
          contentDescription = "Thumbnail ${device.name}"
        },
    contentAlignment = Alignment.Center,
  ) {
    when {
      placeholder != null ->
        Text(placeholder, color = Color.White.copy(alpha = 0.6f), fontSize = 12.sp)
      still != null ->
        Image(
          bitmap = still,
          contentDescription = "Screenshot of ${device.name}",
          modifier = Modifier.fillMaxSize(),
          contentScale = ContentScale.Fit,
        )
      else ->
        Text(
          "No preview yet",
          color = Color.White.copy(alpha = 0.5f),
          fontSize = 11.sp,
          textAlign = TextAlign.Center,
          modifier = Modifier.padding(8.dp),
        )
    }
  }
}

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
            stream.screenshotUpdates.first { isThumbnailFrameFor(deviceId, it) }.screenshotBase64
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
