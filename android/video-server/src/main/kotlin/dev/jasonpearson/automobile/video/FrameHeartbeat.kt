package dev.jasonpearson.automobile.video

/**
 * Decides when the capture path must force a fresh surface submission so a WebRTC stream does not
 * starve a late viewer on a static screen (issue #4383).
 *
 * The encoder is fed by a mirrored VirtualDisplay. When the screen is static no new surface buffers
 * arrive, so the encoder emits its initial SPS/PPS + IDR + a short burst and then stops: a WHEP
 * viewer that subscribes after that burst never receives a decodable frame.
 * `MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER` is meant to keep the encoder producing idle
 * repeats, but it does not reliably sustain them on every device, and a keyframe request
 * (`PARAMETER_KEY_REQUEST_SYNC_FRAME`) cannot yield a fresh IDR with no new surface input. This
 * heartbeat is the backstop: it tells [VideoServer] when to nudge the VirtualDisplay into
 * re-submitting a frame — periodically while idle, and promptly after a keyframe request that
 * produced nothing.
 *
 * Pure and clock-injectable so it unit-tests without the Android framework. Thread-safe because the
 * keyframe request arrives on the command-reader thread while the encode loop polls and reports
 * emitted frames.
 */
class FrameHeartbeat(
  private val clock: Clock,
  /** Force a fresh submission after this long with no emitted frame (idle repeat backstop). */
  private val idleForceIntervalMs: Long = DEFAULT_IDLE_FORCE_INTERVAL_MS,
  /** After a keyframe request, force a submission if no frame lands within this window. */
  private val keyFrameGraceMs: Long = DEFAULT_KEY_FRAME_GRACE_MS,
) {
  /** Injectable monotonic clock; production uses `SystemClock.uptimeMillis()`. */
  fun interface Clock {
    fun nowMs(): Long
  }

  /** Last emitted frame OR issued nudge — whichever is later. Throttles idle nudges. */
  private var lastActivityMs = 0L

  /** When an unsatisfied keyframe request began, or null when none is outstanding. */
  private var keyFramePendingSinceMs: Long? = null

  /** Baseline the timers at capture start so the first idle nudge is a full interval out. */
  @Synchronized
  fun start() {
    lastActivityMs = clock.nowMs()
    keyFramePendingSinceMs = null
  }

  /** Record that the encoder emitted a frame: resets idle timing and clears any request. */
  @Synchronized
  fun onFrameEmitted() {
    lastActivityMs = clock.nowMs()
    keyFramePendingSinceMs = null
  }

  /** Record a keyframe request (a relayed WHEP viewer PLI). Coalesces repeats. */
  @Synchronized
  fun onKeyFrameRequested() {
    if (keyFramePendingSinceMs == null) {
      keyFramePendingSinceMs = clock.nowMs()
    }
  }

  /**
   * @return true if the caller should force a fresh surface submission now. Firing advances the
   *   internal timers so a wedged surface is nudged at most once per interval (idle) or once per
   *   grace window (pending keyframe) until a frame lands.
   */
  @Synchronized
  fun poll(): Boolean {
    val now = clock.nowMs()
    val pending = keyFramePendingSinceMs
    val dueForKeyFrame = pending != null && now - pending >= keyFrameGraceMs
    val dueForIdle = now - lastActivityMs >= idleForceIntervalMs
    if (!dueForKeyFrame && !dueForIdle) {
      return false
    }
    lastActivityMs = now
    if (pending != null) {
      // Keep the request outstanding but re-throttle: if the nudge produces nothing,
      // fire again after another grace window rather than every poll.
      keyFramePendingSinceMs = now
    }
    return true
  }

  companion object {
    const val DEFAULT_IDLE_FORCE_INTERVAL_MS = 1_000L
    const val DEFAULT_KEY_FRAME_GRACE_MS = 150L
  }
}
