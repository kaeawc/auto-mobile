package dev.jasonpearson.automobile.video

/**
 * Snapshot a volatile field the shutdown hook may null on another thread. The encode loop calls
 * this instead of a `!!` deref so a concurrent null observed mid-shutdown yields a clean stop
 * signal (null) rather than a [NullPointerException] (#4748). Kept as a seam so the loop's
 * null-tolerance is unit-testable without the Android capture stack.
 */
internal fun <T : Any> VideoServer.encodeLoopSnapshot(field: T?): T? = field

/** Only a released-codec state error during intentional shutdown is a clean loop exit. */
internal fun VideoServer.isShutdownRace(running: Boolean, error: Throwable): Boolean =
  !running && error is IllegalStateException

internal fun VideoServer.shouldCountVideoStatsFrame(isCodecConfig: Boolean): Boolean =
  !isCodecConfig

/**
 * Request one recovery IDR after a handoff drop. The handoff signal coalesces a drop burst, while
 * [FrameHeartbeat] coalesces concurrent keyframe requests and supplies the surface nudge.
 */
internal fun VideoServer.recoverFromFrameDrop(
  consumeDropGap: () -> Boolean,
  requestKeyFrame: () -> Unit,
  heartbeat: FrameHeartbeat,
): Boolean {
  if (!consumeDropGap()) {
    return false
  }
  if (heartbeat.onKeyFrameRequested()) {
    requestKeyFrame()
  }
  return true
}
