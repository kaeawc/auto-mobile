package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.MONOTONIC_NOW_MS
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.util.concurrent.ConcurrentHashMap

private val LOG = LoggerFactory.getLogger("InteractionLatency")

/** The latency breakdown of one tap-to-visible-response interaction, all deltas in milliseconds. */
data class InteractionLatency(
  val deviceId: String,
  /** How stale the mapped observation frame was when the user clicked (tap − frame-captured). */
  val frameAgeMs: Long,
  /** Click → the `input/tap` leaving for the daemon (dispatch queue + coordinate handoff). */
  val queueMs: Long,
  /** `input/tap` sent → daemon acknowledged it (daemon-side tap processing). */
  val dispatchMs: Long,
  /** Daemon ack → first video frame rendered after it (device react + encode + stream + decode). */
  val visualMs: Long,
  /** Click → first video frame after the tap; the user-perceived responsiveness. */
  val totalMs: Long,
) {
  fun format(): String =
    "tap→frame $deviceId: total=${totalMs}ms " +
      "(frameAge=${frameAgeMs}, queue=${queueMs}, dispatch=${dispatchMs}, visual=${visualMs})"
}

/**
 * Instruments the tap→map→dispatch→ack→first-frame loop of workspace device control so we can tune
 * interaction latency. The workspace owns every seam this needs (the `onControlTap` callback, the
 * per-action daemon client, the live-video frame source), so it measures the whole loop WITHOUT
 * touching the shared [dev.jasonpearson.automobile.desktop.core.control.DeviceControlSession] or
 * the Layout `DeviceScreenView`.
 *
 * One interaction per device is tracked at a time: taps dispatch in order and are effectively
 * serial per pane, so a new tap replaces (and logs as incomplete) any prior unfinished one. A perf
 * probe, not a correctness path — best-effort correlation is fine.
 */
// Monotonic clock to match the snapshot's `capturedAtMs` (also monotonic), so the frame-age delta
// is
// meaningful; monotonic also avoids wall-clock jumps skewing the sub-second interaction deltas.
class InteractionLatencyTracer(private val nowMs: () -> Long = MONOTONIC_NOW_MS) {
  private class Interaction(val frameCapturedMs: Long, val tapInitiatedMs: Long) {
    var dispatchedMs: Long? = null
    var ackedMs: Long? = null
  }

  private val current = ConcurrentHashMap<String, Interaction>()

  /** The user clicked: [frameCapturedMs] is the mapped snapshot's `receivedAtMs`. */
  fun tapInitiated(deviceId: String, frameCapturedMs: Long) {
    current[deviceId] = Interaction(frameCapturedMs = frameCapturedMs, tapInitiatedMs = nowMs())
  }

  /** The `input/tap` is about to leave for the daemon. */
  fun dispatching(deviceId: String) {
    current[deviceId]?.let { if (it.dispatchedMs == null) it.dispatchedMs = nowMs() }
  }

  /** The daemon acknowledged the `input/tap`. */
  fun acked(deviceId: String) {
    current[deviceId]?.let { if (it.ackedMs == null) it.ackedMs = nowMs() }
  }

  /**
   * A new live-video frame reached the screen. Completes the pending interaction with the first
   * frame after dispatch; steady-state frames (no dispatched tap pending) are ignored cheaply.
   */
  fun videoFrameRendered(deviceId: String) {
    val interaction = current[deviceId] ?: return
    val dispatched = interaction.dispatchedMs ?: return
    val rendered = nowMs()
    current.remove(deviceId)
    val acked = interaction.ackedMs ?: dispatched
    LOG.info(
      InteractionLatency(
          deviceId = deviceId,
          frameAgeMs = interaction.tapInitiatedMs - interaction.frameCapturedMs,
          queueMs = dispatched - interaction.tapInitiatedMs,
          dispatchMs = acked - dispatched,
          visualMs = rendered - acked,
          totalMs = rendered - interaction.tapInitiatedMs,
        )
        .format()
    )
  }
}
