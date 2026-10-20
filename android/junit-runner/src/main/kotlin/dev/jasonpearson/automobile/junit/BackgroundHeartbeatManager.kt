package dev.jasonpearson.automobile.junit

import java.io.Closeable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Heartbeats every registered session once per interval. Each beat runs on [beatExecutor] so one
 * slow daemon round-trip (up to the 1 s connect + 1 s read timeouts) never delays the other
 * sessions' beats or the next cycle: a serial loop over N sessions could take N x 2 s and starve
 * live sessions past the daemon's 10 s no-heartbeat budget (#11195). A session whose previous beat
 * is still in flight is skipped that cycle rather than stacking a second request.
 *
 * The loop runs only while something needs it: a [start] holder, or a registered session. A session
 * registered with no holder starts it, and removing the last such session stops it, so the thread
 * never outlives its sessions (#11195).
 */
internal class BackgroundHeartbeatManager(
  private val sendHeartbeat: (String) -> Unit,
  private val sleeper: (Long) -> Unit = { Thread.sleep(it) },
  private val threadFactory: (String, Runnable) -> Thread = { name, runnable ->
    thread(start = true, isDaemon = true, name = name) { runnable.run() }
  },
  private val beatExecutor: Executor = defaultBeatExecutor,
  private val nowMs: () -> Long = System::currentTimeMillis,
  private val warn: (String) -> Unit = { println("Warning: $it") },
) {
  private val sessions = ConcurrentHashMap.newKeySet<String>()
  private val inFlight = ConcurrentHashMap.newKeySet<String>()
  private val losses = ConcurrentHashMap<String, DaemonSessionLoss>()
  // Sessions the daemon has acknowledged at least once; only then is a bare 404 a real loss.
  private val confirmed = ConcurrentHashMap.newKeySet<String>()
  private val unconfirmedMisses = ConcurrentHashMap<String, Int>()
  private val startLock = Any()
  private val failureWarnings = RateLimitedWarning(FAILURE_WARNING_INTERVAL_MS, nowMs, warn)
  private val lifecycle =
    HeartbeatLifecycle(startLock, { sessions.isEmpty() }, sleeper, threadFactory) { running ->
      sessions.toList().forEach { dispatchBeatSafely(it, running) }
    }

  internal val isRunning: Boolean
    get() = lifecycle.isRunning

  internal val holderCount: Int
    get() = lifecycle.holderCount

  fun start(intervalMs: Long): Closeable = lifecycle.start(intervalMs)

  fun addSession(sessionId: String) {
    // A released UUID is terminal on the daemon (#11072): never heartbeat it again.
    if (losses.containsKey(sessionId)) return
    synchronized(startLock) {
      sessions.add(sessionId)
      lifecycle.ensureRunning()
    }
  }

  fun removeSession(sessionId: String) {
    // Under startLock so an in-flight heartbeat's bookkeeping (taken under the same lock) cannot
    // interleave with the prune and re-create state for the removed id.
    synchronized(startLock) {
      sessions.remove(sessionId)
      // Prune per-id bookkeeping so a long-lived JVM does not grow with every plan UUID. `losses`
      // stays: it is the terminal marker that keeps a released id from being heartbeated again.
      confirmed.remove(sessionId)
      unconfirmedMisses.remove(sessionId)
      lifecycle.stopIfUnneededLocked()
    }
  }

  /** Ids with acknowledged/miss bookkeeping still held; for tests asserting pruning. */
  internal fun hasProgressState(sessionId: String): Boolean =
    confirmed.contains(sessionId) || unconfirmedMisses.containsKey(sessionId)

  /** Why the daemon released [sessionId] while it was heartbeated, or null if it has not. */
  fun sessionLoss(sessionId: String): DaemonSessionLoss? = losses[sessionId]

  /**
   * A 404 for an id the daemon never acknowledged is usually a session it has not created yet
   * (registration precedes executePlan), so keep heartbeating it, bounded. A 404 after a successful
   * heartbeat, or carrying a `releaseReason`, means the daemon released it (#11072).
   */
  private fun recordRelease(
    sessionId: String,
    released: DaemonSessionReleasedException,
    loopRunning: AtomicBoolean,
  ) {
    // A stopped loop can still be mid-iteration when a new holder starts a second loop; only the
    // live loop may count misses, or both would charge the same id and give up early.
    synchronized(startLock) {
      if (!loopRunning.get()) return
      // removeSession ran while this heartbeat was in flight; do not resurrect its pruned state.
      if (!sessions.contains(sessionId)) return
      val sure = released.releaseReason != null || confirmed.contains(sessionId)
      if (!sure) {
        val misses = unconfirmedMisses.merge(sessionId, 1, Int::plus) ?: 1
        if (misses < MAX_UNCONFIRMED_MISSES) return
      }
      val loss =
        DaemonSessionLoss(
          sessionId,
          released.releaseReason,
          released.message ?: "Session not found",
          confirmed = sure,
        )
      losses[sessionId] = loss
      sessions.remove(sessionId)
      confirmed.remove(sessionId)
      unconfirmedMisses.remove(sessionId)
      warn("${loss.describe()}; no longer heartbeating it")
      lifecycle.stopIfUnneededLocked()
    }
  }

  private fun recordAcknowledged(sessionId: String, loopRunning: AtomicBoolean) {
    synchronized(startLock) {
      if (loopRunning.get() && sessions.contains(sessionId)) {
        confirmed.add(sessionId)
        unconfirmedMisses.remove(sessionId)
      }
    }
  }

  /**
   * A dispatch failure (e.g. a [java.util.concurrent.RejectedExecutionException] from the beat
   * executor) must not kill the loop while [running] stays true: record a rate-limited warning and
   * carry on with the next session and cycle (#11208).
   */
  private fun dispatchBeatSafely(sessionId: String, loopRunning: AtomicBoolean) {
    try {
      dispatchBeat(sessionId, loopRunning)
    } catch (error: Exception) {
      failureWarnings.record(
        "Daemon heartbeat for $sessionId could not be dispatched: ${error.message ?: error}",
      )
    }
  }

  private fun dispatchBeat(sessionId: String, loopRunning: AtomicBoolean) {
    // The previous beat for this id is still waiting on the daemon; do not stack another.
    if (!inFlight.add(sessionId)) return
    try {
      beatExecutor.execute { beat(sessionId, loopRunning) }
    } catch (error: Exception) {
      inFlight.remove(sessionId)
      throw error
    }
  }

  private fun beat(sessionId: String, loopRunning: AtomicBoolean) {
    try {
      sendHeartbeat(sessionId)
      recordAcknowledged(sessionId, loopRunning)
    } catch (released: DaemonSessionReleasedException) {
      recordRelease(sessionId, released, loopRunning)
    } catch (error: Exception) {
      // A missed heartbeat is transient (daemon restarting, socket busy, a 5xx) and the next tick
      // retries, but a daemon that keeps refusing beats must leave a trace: warn, rate-limited.
      failureWarnings.record("Daemon heartbeat for $sessionId failed: ${error.message ?: error}")
    } finally {
      inFlight.remove(sessionId)
    }
  }

  private companion object {
    /** About 30 s at the 1 s cadence: how long a never-acknowledged id may 404 before giving up. */
    const val MAX_UNCONFIRMED_MISSES = 30

    /** At most one heartbeat-failure warning per this window; the rest are counted, not printed. */
    const val FAILURE_WARNING_INTERVAL_MS = 30_000L

    /**
     * Daemon threads, created on demand and reaped when idle; at most one per session in flight.
     */
    val defaultBeatExecutor: Executor = Executors.newCachedThreadPool { runnable ->
      Thread(runnable, "auto-mobile-daemon-heartbeat-beat").apply { isDaemon = true }
    }
  }
}

/**
 * Prints the first warning, then at most one per [intervalMs], noting how many were suppressed in
 * between, so a daemon that fails every beat does not flood test output.
 */
internal class RateLimitedWarning(
  private val intervalMs: Long,
  private val nowMs: () -> Long,
  private val warn: (String) -> Unit,
) {
  private var lastWarnedAtMs: Long? = null
  private var suppressed = 0

  @Synchronized
  fun record(message: String) {
    val now = nowMs()
    val last = lastWarnedAtMs
    if (last != null && now - last < intervalMs) {
      suppressed++
      return
    }
    val note = if (suppressed > 0) " ($suppressed similar warnings suppressed)" else ""
    warn("$message$note")
    lastWarnedAtMs = now
    suppressed = 0
  }
}
