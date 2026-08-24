package dev.jasonpearson.automobile.desktop.core.video

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Client-side quality controller for the live device mirror.
 *
 * The desktop relay fixes a capture's encode at subscribe time — there is no mid-stream control
 * channel and the first subscriber's preset wins for a shared capture (see [VideoStreamQuality] and
 * the screen-streaming design doc). So this controller does the *decision* half of adaptive
 * quality: it derives the delivered frame rate from the timestamps of decoded frames ([onFrame])
 * and, when [autoAdjustEnabled] is on, picks a lower preset when the stream is chronically slow
 * *while actively delivering frames* and a higher one once it is sustainably at target. The pane
 * applies a change by re-subscribing with the new preset (which takes effect for a sole subscriber
 * / the next subscribe); truly reconfiguring a live shared capture is a server-side follow-up.
 *
 * ### Why frame timing alone is read carefully
 * A raw "frames per second below target" signal is confounded by how each platform handles a static
 * screen, which is the common case for UI automation (mostly still frames):
 * - Android's encoder *repeats* the previous frame after ~100ms of no change
 *   (`VideoEncoder.KEY_REPEAT_PREVIOUS_FRAME_AFTER`), so a still screen streams at ~10fps.
 * - iOS ScreenCaptureKit *suppresses* idle buffers, so a still screen makes no frame progress until
 *   it changes. Neither is encoder/transport degradation, so neither should downgrade quality. This
 *   controller therefore classifies each inter-frame interval rather than trusting an fps number:
 * - `dt` at/under the target interval → **healthy**;
 * - `dt` between the target interval and [idleIntervalMs] → **active but slow** (genuine
 *   degradation the encode can plausibly recover from by dropping resolution);
 * - `dt` at/over [idleIntervalMs] → **idle**, i.e. consistent with a static screen (Android repeat
 *   cadence) or a suppression/reconnect gap → no signal, streaks reset.
 *   [samplesToDowngrade]/[samplesToUpgrade] (hysteresis) plus [minDwellMs] then keep a brief dip or
 *   a flapping rate from thrashing the encode.
 *
 * The displayed [actualFps] is computed as frames-over-elapsed across a trailing [rateWindowMs]
 * window — an unbiased rate. (Averaging instantaneous `1000/dt` values would overstate throughput
 * for unevenly-arriving frames, e.g. alternating 10ms/90ms gaps are 20fps but average to ~50fps.)
 * That rate reflects the frames the pane actually renders (the caller feeds [onFrame] from its
 * render path), an acceptable proxy for the decode rate at the 10–30fps targets here.
 *
 * Frame timestamps are the only clock, so every decision is deterministic and unit-testable without
 * a FakeTimer. [onManualSelection] fires only for an explicit [selectQuality]; automatic steps
 * update [quality] (so the pane re-subscribes and the overlay updates) but do NOT notify, so the
 * caller persists only the user's chosen preset — never a transient auto-step or a shared-capture
 * ratchet the stream did not actually apply.
 *
 * @property targetFps the rate the pane asked the relay for; a drop is measured relative to it.
 */
class QualityController(
  initialQuality: VideoStreamQuality,
  val targetFps: Int,
  autoAdjustEnabled: Boolean = true,
  /** Trailing window the displayed [actualFps] is averaged over (frames ÷ elapsed). */
  private val rateWindowMs: Long = 2_000,
  /**
   * Non-idle inter-frame samples needed before any decision, so an early estimate can't misfire.
   */
  private val minSamplesForDecision: Int = 5,
  /**
   * At/over this inter-frame interval a frame is treated as idle — consistent with a static screen
   * (Android's ~100ms repeat cadence) or an iOS suppression / reconnect gap — and contributes no
   * drop signal. Just under the on-device repeat cadence so a still screen never reads as a drop;
   * genuine degradation the controller acts on shows up as intervals between the target and here.
   */
  private val idleIntervalMs: Long = 90,
  /** Below this fraction of [targetFps] a (non-idle) sample counts as dropping. */
  private val downgradeRatio: Double = 0.8,
  /** At or above this fraction of [targetFps] a sample counts as healthy. */
  private val upgradeRatio: Double = 0.95,
  /** Consecutive dropping samples required before a downgrade (hysteresis). */
  private val samplesToDowngrade: Int = 3,
  /**
   * Consecutive healthy samples required before an upgrade — larger, so quality climbs cautiously.
   */
  private val samplesToUpgrade: Int = 8,
  /** Minimum frame-time spacing between two automatic changes. */
  private val minDwellMs: Long = 2_000,
  /**
   * Notified only for an explicit [selectQuality] (a user's manual pick), for persistence.
   * Automatic steps update [quality] (so the pane re-subscribes and the overlay updates) but do not
   * notify.
   */
  private val onManualSelection: (VideoStreamQuality) -> Unit = {},
) {
  private val _quality = MutableStateFlow(initialQuality)
  val quality: StateFlow<VideoStreamQuality> = _quality

  private val _actualFps = MutableStateFlow(0f)
  val actualFps: StateFlow<Float> = _actualFps

  /** Whether frame-rate drops drive automatic preset changes. FPS is measured regardless. */
  var autoAdjustEnabled: Boolean = autoAdjustEnabled

  // Trailing timestamps for the displayed rate (frames ÷ elapsed over rateWindowMs).
  private val window = ArrayDeque<Long>()
  private var lastFrameMs: Long? = null
  private var samples = 0
  private var lowStreak = 0
  private var highStreak = 0
  // Null until the first change, so the first decision is never gated by dwell (and no overflow).
  private var lastChangeAtMs: Long? = null

  // Inter-frame interval thresholds (ms) derived from the target rate.
  private val healthyMaxDtMs: Double
    get() = 1000.0 / (upgradeRatio * targetFps)

  private val droppingMinDtMs: Double
    get() = 1000.0 / (downgradeRatio * targetFps)

  /** Records a decoded frame's arrival time, updates the live rate, and maybe adjusts quality. */
  fun onFrame(receivedAtMs: Long) {
    window.addLast(receivedAtMs)
    while (window.size > 1 && receivedAtMs - window.first() > rateWindowMs) window.removeFirst()
    _actualFps.value = windowFps()

    val previous = lastFrameMs
    lastFrameMs = receivedAtMs
    if (previous == null) return // first frame: no interval yet.

    val dt = receivedAtMs - previous
    if (dt <= 0L) return // out-of-order / duplicate timestamp: ignore rather than divide by zero.
    if (!autoAdjustEnabled) return

    classify(dt)
    if (samples < minSamplesForDecision) return
    maybeAdjust(receivedAtMs)
  }

  /**
   * Applies an explicit user choice, re-seeding the rate window so the manual pick sticks. Persists
   * unconditionally: the user's explicit choice must be written even when it equals the *current*
   * preset, because that preset may have been set by an automatic step while the persisted value
   * still differs — otherwise picking the already-highlighted chip would silently fail to persist.
   * The state change / re-subscribe is skipped when nothing actually changes.
   */
  fun selectQuality(quality: VideoStreamQuality) {
    onManualSelection(quality)
    if (_quality.value == quality) return
    _quality.value = quality
    resetRateWindow()
  }

  /**
   * Frames-over-elapsed across the retained window; 0 until two frames span a positive interval.
   */
  private fun windowFps(): Float {
    if (window.size < 2) return 0f
    val span = window.last() - window.first()
    if (span <= 0L) return 0f
    return (window.size - 1) * 1000f / span
  }

  /** Buckets one inter-frame interval into healthy / dropping / idle and advances the streaks. */
  private fun classify(dt: Long) {
    when {
      // Idle: consistent with a static screen's repeat cadence or a suppression/reconnect gap.
      // Not degradation — clear the streaks and do not count it as a decision sample.
      dt >= idleIntervalMs -> {
        lowStreak = 0
        highStreak = 0
      }
      dt <= healthyMaxDtMs -> {
        highStreak++
        lowStreak = 0
        samples++
      }
      dt > droppingMinDtMs -> {
        lowStreak++
        highStreak = 0
        samples++
      }
      // Dead-zone between the two ratios: neither clearly healthy nor dropping — hold and reset,
      // which is what gives the hysteresis its gap and stops boundary flapping.
      else -> {
        lowStreak = 0
        highStreak = 0
        samples++
      }
    }
  }

  private fun maybeAdjust(nowMs: Long) {
    val dwellElapsed = lastChangeAtMs?.let { nowMs - it >= minDwellMs } ?: true
    if (!dwellElapsed) return

    if (lowStreak >= samplesToDowngrade && _quality.value != VideoStreamQuality.Low) {
      change(_quality.value.lower(), nowMs)
    } else if (highStreak >= samplesToUpgrade && _quality.value != VideoStreamQuality.High) {
      change(_quality.value.higher(), nowMs)
    }
  }

  private fun change(quality: VideoStreamQuality, nowMs: Long) {
    _quality.value = quality
    lastChangeAtMs = nowMs
    resetRateWindow()
    // Deliberately no onManualSelection here: an automatic step re-subscribes via [quality] but is
    // not persisted (see the class doc).
  }

  /**
   * Drops the retained timing and hysteresis streaks so the next frames re-seed the rate. Called on
   * every preset change because a change triggers a re-subscribe, and the first frame after that
   * reconnection is separated from the last pre-change frame by the whole gap.
   */
  private fun resetRateWindow() {
    window.clear()
    lastFrameMs = null
    samples = 0
    lowStreak = 0
    highStreak = 0
  }
}
