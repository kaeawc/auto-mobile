package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.onSubscription

/**
 * The screenshot interval a one-shot capture asks for while it waits, so the next screenshot
 * arrives quickly. It is the daemon's minimum. On a hub lease it lasts only as long as the lease:
 * the hub merges the fastest interval its leases request, and releasing the lease restores the
 * others' cadence.
 */
const val FRESH_SCREENSHOT_INTERVAL_MS = 250L

/**
 * The first screenshot frame captured after this call that [accept] takes (#17027). Works on a
 * fresh per-device stream and on a hub lease joined onto a live shared stream alike: the frame the
 * stream already holds, which a lease replays and which can be one cadence interval old, is never
 * returned. Call it after `connect`. It asks for an observation and holds
 * [FRESH_SCREENSHOT_INTERVAL_MS] on this stream, so the caller's lease (or stream) must be released
 * afterwards.
 */
suspend fun ObservationStream.awaitFreshScreenshot(
  deviceId: String?,
  accept: (ScreenshotStreamUpdate) -> Boolean = { !it.screenshotBase64.isNullOrEmpty() },
): ScreenshotStreamUpdate =
  awaitFrameAfterRequest(
    frames = screenshotUpdates,
    timestampOf = ScreenshotStreamUpdate::timestamp,
    request = {
      setCadence(screenshotIntervalMs = FRESH_SCREENSHOT_INTERVAL_MS)
      requestObservation(deviceId)
    },
    accept = accept,
  )

/**
 * The first hierarchy frame captured after this call that [accept] takes, the hierarchy half of
 * [awaitFreshScreenshot]. `request_observation` pushes a new hierarchy, so no cadence is changed. A
 * hierarchy's timestamp is the device's capture time when it has one and the daemon's otherwise, so
 * hierarchies are never ordered by it: only the replayed frames themselves are skipped.
 */
suspend fun ObservationStream.awaitFreshHierarchy(
  deviceId: String?,
  accept: (HierarchyStreamUpdate) -> Boolean = { true },
): HierarchyStreamUpdate =
  awaitFrameAfterRequest(
    frames = hierarchyUpdates,
    timestampOf = null,
    request = { requestObservation(deviceId) },
    accept = accept,
  )

/**
 * Subscribe to [frames], then snapshot what it replays and run [request], and return the first
 * later frame that [accept] takes. A replayed frame is recognised by identity (a shared flow
 * replays the same instance). When [timestampOf] reads a single clock (a screenshot's daemon
 * stamp), a frame emitted between the subscription and the snapshot is also skipped, by being older
 * than the newest replayed one; the desktop's clock is never compared with it.
 */
internal suspend fun <T : Any> awaitFrameAfterRequest(
  frames: SharedFlow<T>,
  timestampOf: ((T) -> Long)?,
  request: () -> Unit,
  accept: (T) -> Boolean,
): T {
  var stale: List<T> = emptyList()
  var newestStale = Long.MIN_VALUE
  return frames
    .onSubscription {
      stale = frames.replayCache
      if (timestampOf != null) newestStale = stale.maxOfOrNull(timestampOf) ?: Long.MIN_VALUE
      request()
    }
    .first { frame ->
      stale.none { it === frame } &&
        (timestampOf == null || timestampOf(frame) >= newestStale) &&
        accept(frame)
    }
}
