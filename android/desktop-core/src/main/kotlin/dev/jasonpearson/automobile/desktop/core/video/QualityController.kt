package dev.jasonpearson.automobile.desktop.core.video

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Client-side quality controller for the live device mirror.
 *
 * The desktop relay fixes a capture's encode at subscribe time — there is no mid-stream control
 * channel and the first subscriber's preset wins for a shared capture (see [VideoStreamQuality] and
 * the screen-streaming design doc). So this controller does the *decision* half of adaptive
 * quality: it derives the actual frame rate from the timestamps of decoded frames ([onFrame]) and,
 * when [autoAdjustEnabled] is on, picks a lower preset when the rate is chronically dropping and a
 * higher one once it is sustainably healthy. The pane applies a change by re-subscribing with the
 * new preset (which takes effect for a sole subscriber / the next subscribe); truly reconfiguring a
 * live shared capture is a server-side follow-up.
 *
 * Frame timestamps are the only clock, so decisions are deterministic and unit-testable without a
 * FakeTimer. The rate is an exponential moving average of the instantaneous inter-frame rate, so a
 * single late frame perturbs it briefly rather than smearing across a whole window; hysteresis
 * ([samplesToDowngrade]/[samplesToUpgrade]) plus [minDwellMs] then keep a brief dip or a flapping
 * rate from thrashing the encode. Every preset change (manual or automatic) also resets the rate
 * window, so the reconnect gap that a re-subscribe introduces re-seeds cleanly instead of being
 * counted as one implausibly-slow frame that biases the next decision.
 *
 * The rate is measured over the frames the pane actually renders (the caller feeds [onFrame] from
 * its render path), so under a UI that recomposes slower than frames decode it reflects render
 * cadence rather than raw decode rate — an acceptable proxy at the 10–30fps targets here.
 *
 * [onManualSelection] fires only for an explicit [selectQuality]; automatic steps deliberately do
 * NOT notify, so the caller persists the user's chosen preset without writing the settings file on
 * every transient auto-adjust (and without persisting a shared-capture ratchet-to-Low the stream
 * never actually applied).
 *
 * @property targetFps the rate the pane asked the relay for; a drop is measured relative to it.
 */
class QualityController(
  initialQuality: VideoStreamQuality,
  val targetFps: Int,
  autoAdjustEnabled: Boolean = true,
  /**
   * Smoothing factor for the inter-frame rate EMA (0..1); higher reacts faster, lower is calmer.
   */
  private val smoothing: Double = 0.2,
  /** Inter-frame samples needed before any decision, so an early estimate can't misfire. */
  private val minSamplesForDecision: Int = 5,
  /** Below this fraction of [targetFps] a sample counts as dropping. */
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

  private var lastFrameMs: Long? = null
  private var samples = 0
  private var lowStreak = 0
  private var highStreak = 0
  // Null until the first change, so the first decision is never gated by dwell (and no overflow).
  private var lastChangeAtMs: Long? = null

  /** Records a decoded frame's arrival time, updates the live rate, and maybe adjusts quality. */
  fun onFrame(receivedAtMs: Long) {
    val previous = lastFrameMs
    lastFrameMs = receivedAtMs
    if (previous == null) return // first frame: no interval yet, rate stays 0.

    val dt = receivedAtMs - previous
    if (dt <= 0L) return // out-of-order / duplicate timestamp: ignore rather than divide by zero.

    val instant = 1000f / dt
    val ema = _actualFps.value
    _actualFps.value =
      if (samples == 0) instant else (smoothing * instant + (1 - smoothing) * ema).toFloat()
    samples++

    if (!autoAdjustEnabled || samples < minSamplesForDecision) return
    evaluate(_actualFps.value, receivedAtMs)
  }

  /** Applies an explicit user choice, re-seeding the rate window so the manual pick sticks. */
  fun selectQuality(quality: VideoStreamQuality) {
    if (_quality.value == quality) return
    _quality.value = quality
    resetRateWindow()
    onManualSelection(quality)
  }

  private fun evaluate(fps: Float, nowMs: Long) {
    when {
      fps < downgradeRatio * targetFps -> {
        lowStreak++
        highStreak = 0
      }
      fps >= upgradeRatio * targetFps -> {
        highStreak++
        lowStreak = 0
      }
      // Dead-zone between the two ratios: neither dropping nor clearly healthy — hold and reset,
      // which is what gives the hysteresis its gap and stops boundary flapping.
      else -> {
        lowStreak = 0
        highStreak = 0
      }
    }

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
   * Drops the inter-frame timing and hysteresis streaks so the next frame re-seeds the EMA. Called
   * on every preset change because a change triggers a re-subscribe, and the first frame after that
   * reconnection is separated from the last pre-change frame by the whole gap — counting it as a
   * real interval would fold one implausibly-slow sample into the rate.
   */
  private fun resetRateWindow() {
    lastFrameMs = null
    samples = 0
    lowStreak = 0
    highStreak = 0
  }
}
