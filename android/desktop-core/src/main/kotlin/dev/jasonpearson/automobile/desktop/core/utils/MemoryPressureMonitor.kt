package dev.jasonpearson.automobile.desktop.core.utils

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Monitors JVM heap usage and emits warnings when memory pressure is high.
 *
 * - [heapUsagePercent] is observable Compose state (0.0..1.0) for status bar display.
 * - When usage exceeds [WARNING_THRESHOLD] (80%), [onWarning] fires.
 * - When usage exceeds [CRITICAL_THRESHOLD] (90%), [onTrimRequested] fires so the caller can trim
 *   buffers (e.g. telemetry event list).
 *
 * Call [start] to begin polling and [stop] to cancel.
 */
class MemoryPressureMonitor(
    private val pollIntervalMs: Long = DEFAULT_POLL_INTERVAL_MS,
    private val onWarning: (() -> Unit)? = null,
    private val onTrimRequested: (() -> Unit)? = null,
) {
  companion object {
    const val WARNING_THRESHOLD = 0.80f
    const val CRITICAL_THRESHOLD = 0.90f
    const val DEFAULT_POLL_INTERVAL_MS = 5_000L
  }

  /** Current heap usage as a fraction (0.0..1.0). Observable in Compose. */
  var heapUsagePercent by mutableFloatStateOf(0f)
    private set

  private val scope = CoroutineScope(Dispatchers.Default)
  private var job: Job? = null

  /** Whether the critical callback has already fired for the current pressure spike. */
  private var trimFired = false

  /** Start periodic heap monitoring. Safe to call multiple times (restarts). */
  fun start() {
    stop()
    job = scope.launch {
      while (isActive) {
        val usage = sampleHeapUsage()
        heapUsagePercent = usage

        if (usage >= CRITICAL_THRESHOLD) {
          if (!trimFired) {
            trimFired = true
            onTrimRequested?.invoke()
          }
        } else if (usage >= WARNING_THRESHOLD) {
          trimFired = false
          onWarning?.invoke()
        } else {
          trimFired = false
        }

        delay(pollIntervalMs)
      }
    }
  }

  /** Stop monitoring. */
  fun stop() {
    job?.cancel()
    job = null
  }

  /** Sample current JVM heap usage. Extracted for testability. Returns a value in 0.0..1.0. */
  internal fun sampleHeapUsage(): Float {
    val runtime = Runtime.getRuntime()
    val totalMemory = runtime.totalMemory()
    val freeMemory = runtime.freeMemory()
    val maxMemory = runtime.maxMemory()
    val usedMemory = totalMemory - freeMemory
    return if (maxMemory > 0) (usedMemory.toFloat() / maxMemory.toFloat()).coerceIn(0f, 1f) else 0f
  }
}
