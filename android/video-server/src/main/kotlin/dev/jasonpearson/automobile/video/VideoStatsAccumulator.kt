package dev.jasonpearson.automobile.video

import java.util.Locale

/**
 * Pure, clock-injected stream-health accounting for the machine-parseable `VIDEO_STATS` line.
 *
 * The line is emitted every [intervalMs] at an exact interval boundary: `VIDEO_STATS socket=<name>
 * fps=<interval fps> bytesOut=<cumulative bytes> dropped=<cumulative drops> uptimeMs=<elapsed
 * uptime>`.
 */
class VideoStatsAccumulator(
  private val socketName: String,
  private val clock: Clock,
  private val intervalMs: Long = DEFAULT_INTERVAL_MS,
  private val droppedCount: () -> Long,
) {
  fun interface Clock {
    fun nowMs(): Long
  }

  private var startedAtMs = 0L
  private var intervalStartedAtMs = 0L
  private var intervalFrames = 0L
  private var bytesOut = 0L
  private var started = false

  init {
    require(intervalMs > 0) { "intervalMs must be positive" }
  }

  /** Baseline uptime so the first stats line is emitted only after a full interval. */
  fun start() {
    startedAtMs = clock.nowMs()
    intervalStartedAtMs = startedAtMs
    intervalFrames = 0
    bytesOut = 0
    started = true
  }

  /** Record one encoded output frame and its payload size. */
  fun onFrame(bytes: Int) {
    check(started) { "VideoStatsAccumulator must be started before recording frames" }
    require(bytes >= 0) { "frame bytes must be non-negative" }
    intervalFrames++
    bytesOut += bytes
  }

  /**
   * Return one stable stats line once the current interval has elapsed, otherwise null.
   *
   * Frame rate is calculated over the elapsed interval; bytes and drops are cumulative for the
   * session. Polling after a long scheduling gap emits one line and starts the next interval at the
   * current clock value.
   */
  fun poll(): String? {
    check(started) { "VideoStatsAccumulator must be started before polling" }
    val nowMs = clock.nowMs()
    val elapsedMs = nowMs - intervalStartedAtMs
    if (elapsedMs < intervalMs) {
      return null
    }
    val fps = intervalFrames * 1_000.0 / elapsedMs
    val line =
      String.format(
        Locale.US,
        "VIDEO_STATS socket=%s fps=%.2f bytesOut=%d dropped=%d uptimeMs=%d",
        socketName,
        fps,
        bytesOut,
        droppedCount(),
        nowMs - startedAtMs,
      )
    intervalStartedAtMs = nowMs
    intervalFrames = 0
    return line
  }

  companion object {
    const val DEFAULT_INTERVAL_MS = 5_000L
  }
}
