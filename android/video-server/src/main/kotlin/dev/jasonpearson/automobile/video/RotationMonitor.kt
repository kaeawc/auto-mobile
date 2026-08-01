package dev.jasonpearson.automobile.video

/**
 * Reads the current display rotation (a `Surface.ROTATION_*` value). Production reads it from
 * `DisplayControl.getDisplayInfo().rotation`; tests inject a fake that returns scripted rotations
 * so the change-detection logic runs without a real display.
 */
fun interface RotationReader {
  fun currentRotation(): Int
}

/**
 * Registers a framework display-change callback if the runtime allows it, returning an unregister
 * lambda, or null when unavailable so the caller relies on the poll fallback. Production delegates
 * to `DisplayControl.registerDisplayListener`; tests inject a fake to exercise either the listener
 * path or the null (poll-only) path.
 */
fun interface DisplayChangeRegistrar {
  /**
   * Register [onChanged]; return a stop-lambda on success, or null if no listener was registered.
   */
  fun register(onChanged: () -> Unit): (() -> Unit)?
}

/**
 * Detects device-rotation changes so the capture path can be recreated at the new orientation's
 * dimensions (issue #4785). The video server computes output dimensions once at startup; without
 * this monitor a mid-stream rotation leaves the `VirtualDisplay` and encoder surface at the
 * original orientation, so mirrored content stays squished/letterboxed for the rest of the session.
 *
 * Two detection mechanisms funnel through the same coalescing [poll]:
 * 1. A [DisplayChangeRegistrar] listener (`DisplayManager.DisplayListener`) is the primary,
 *    low-latency signal.
 * 2. A poll thread over [RotationReader] is the fallback, because under `app_process`/shell uid the
 *    framework listener may never register or fire. It always runs; [poll]'s change coalescing
 *    means a listener callback and a poll tick that observe the same rotation dispatch a single
 *    swap.
 *
 * The rotation-change decision ([poll]) is a pure, synchronized function testable without a real
 * display or real timers. The poll loop's sleep is injected so it can be driven deterministically.
 */
class RotationMonitor(
  private val reader: RotationReader,
  private val registrar: DisplayChangeRegistrar = DisplayChangeRegistrar { null },
  private val pollIntervalMs: Long = DEFAULT_POLL_INTERVAL_MS,
  // Injected so the poll loop carries no real wall-clock dependency; production sleeps the thread.
  private val sleeper: (Long) -> Unit = { Thread.sleep(it) },
) {
  private val lock = Any()
  private var started = false
  private var lastRotation = ROTATION_UNSET

  @Volatile private var stopped = false
  @Volatile private var onRotationChanged: ((Int) -> Unit)? = null
  @Volatile private var unregister: (() -> Unit)? = null
  @Volatile private var pollThread: Thread? = null

  /**
   * Report the new rotation if it differs from the last observed value, else null. Synchronized and
   * side-effect-free beyond advancing the last-seen rotation, so a listener callback and a poll
   * tick that race on the same change collapse to one dispatch: whichever calls first advances
   * [lastRotation] and returns the new value; the other observes no change and returns null.
   */
  fun poll(): Int? =
    synchronized(lock) {
      val current = reader.currentRotation()
      if (current == lastRotation) {
        null
      } else {
        lastRotation = current
        current
      }
    }

  /**
   * Begin monitoring. Seeds the last-seen rotation from the current reading (so the startup
   * orientation is never mistaken for a change), registers the framework listener when available,
   * and always starts the poll fallback thread. Idempotent: a second call is ignored.
   */
  fun start(onRotationChanged: (Int) -> Unit) {
    synchronized(lock) {
      if (started) return
      started = true
      lastRotation = reader.currentRotation()
      this.onRotationChanged = onRotationChanged
    }
    unregister = registrar.register { dispatch() }
    pollThread =
      Thread({ runPollLoop() }, "video-rotation-poll").apply {
        isDaemon = true
        start()
      }
  }

  /** Stop monitoring: unregister the listener and let the poll thread unwind. Idempotent. */
  fun stop() {
    stopped = true
    try {
      unregister?.invoke()
    } catch (error: Exception) {
      // Best-effort unregister during shutdown; a failure here must not sink teardown.
      System.err.println("RotationMonitor unregister failed: ${error.message}")
    }
    unregister = null
    pollThread?.interrupt()
    pollThread = null
  }

  private fun runPollLoop() {
    while (!stopped) {
      try {
        sleeper(pollIntervalMs)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
        return
      }
      if (stopped) return
      dispatch()
    }
  }

  /** Read a fresh rotation and, only on a real change, notify the listener with the new value. */
  private fun dispatch() {
    val newRotation = poll() ?: return
    onRotationChanged?.invoke(newRotation)
  }

  companion object {
    /** Sentinel that no rotation has been observed yet, so the first reading is not a "change". */
    const val ROTATION_UNSET = -1

    /**
     * Poll cadence for the fallback. Rotation is a rare, human-scale event, so a coarse interval
     * keeps the fallback cheap; the framework listener (when registered) provides the low-latency
     * path.
     */
    const val DEFAULT_POLL_INTERVAL_MS = 500L
  }
}
