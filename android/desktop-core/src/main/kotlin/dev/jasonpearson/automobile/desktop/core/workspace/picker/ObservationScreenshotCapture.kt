package dev.jasonpearson.automobile.desktop.core.workspace.picker

import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import dev.jasonpearson.automobile.desktop.core.daemon.StreamSessionRejectedException
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.merge
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.jetbrains.skia.Image as SkiaImage

private val LOG = LoggerFactory.getLogger("DeviceThumbnail")

/**
 * Thumbnail still backed by a one-shot [ObservationStream] observation. Deliberately does NOT cache
 * across calls: the caller ([DeviceThumbnail]) already holds the captured still in per-deviceId
 * composition state, and a booted card unmounts through the "Shutdown"/"Booting" placeholder on a
 * reboot — so a rebooted device (same AVD/simulator id) captures a fresh still rather than showing
 * the previous boot's screen indefinitely (which a process-lifetime cache keyed only by deviceId
 * would do). System-touching, so (like the workspace's screenshot capture) it is exercised only in
 * manual/production runs; tests inject a fake [DeviceThumbnailScreenshotSource].
 */
object ObservationScreenshotSource :
  DeviceThumbnailScreenshotSource by ObservationScreenshotCapture()

class ObservationScreenshotCapture(
  private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
  private val decodeDispatcher: CoroutineDispatcher = Dispatchers.Default,
) : DeviceThumbnailScreenshotSource {
  private val captureTimeoutMs = 5_000L

  @OptIn(ExperimentalCoroutinesApi::class)
  override suspend fun latest(
    deviceId: String,
    sessionUuidProvider: () -> String?,
  ): ImageBitmap? {
    if (sessionUuidProvider() == null) return null
    val stream = ObservationStreamClient(sessionUuidProvider = sessionUuidProvider)
    return try {
      val base64 =
        withContext(ioDispatcher) {
          stream.connect(deviceId)
          stream.requestObservation(deviceId)
          withTimeoutOrNull(captureTimeoutMs) {
            merge(
                stream.screenshotUpdates.map { update ->
                  update.screenshotBase64.takeIf { isThumbnailFrameFor(deviceId, update) }
                },
                stream.connectionState.filterIsInstance<ConnectionState.Error>().map {
                  throw StreamSessionRejectedException(it.message)
                },
              )
              .first { it != null }
          }
        }
      base64?.let {
        val bytes = Base64.getDecoder().decode(it)
        withContext(decodeDispatcher) {
          SkiaImage.makeFromEncoded(bytes).toComposeImageBitmap()
        }
      }
    } catch (rejection: StreamSessionRejectedException) {
      throw rejection
    } catch (cancellation: CancellationException) {
      throw cancellation
    } catch (error: java.io.IOException) {
      LOG.warn("Thumbnail screenshot capture failed for $deviceId: ${error.message}", error)
      null
    } catch (error: IllegalArgumentException) {
      LOG.warn("Thumbnail screenshot decode failed for $deviceId: ${error.message}", error)
      null
    } finally {
      withContext(NonCancellable + ioDispatcher) { stream.dispose() }
    }
  }
}
