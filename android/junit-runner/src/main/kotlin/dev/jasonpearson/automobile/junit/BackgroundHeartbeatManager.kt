package dev.jasonpearson.automobile.junit

import java.io.Closeable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * Heartbeats every registered session once per interval. Each beat runs on [beatExecutor] so one
 * slow daemon round-trip (up to the 2 s connect + 2 s read timeouts) never delays the other
 * sessions' beats or the next cycle: a serial loop over N sessions could take N x 4 s and starve
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
  @Volatile private var running = AtomicBoolean(false)
  private val startLock = Any()
  private val refCount = AtomicInteger(0)
  @Volatile private var intervalMs: Long = 1_000L
  @Volatile private var heartbeatThread: Thread? = null
  private val failureWarnings = RateLimitedWarning(FAILURE_WARNING_INTERVAL_MS, nowMs, warn)

  internal val isRunning: Boolean
    get() = running.get()

  internal val holderCount: Int
    get() = refCount.get()

  fun start(intervalMs: Long): Closeable {
    synchronized(startLock) {
      this.intervalMs = intervalMs
      refCount.incrementAndGet()
      ensureRunning()
    }
    val closed = AtomicBoolean(false)
    return Closeable { if (closed.compareAndSet(false, true)) stop() }
  }

  fun addSession(sessionId: String) {
    // A released UUID is terminal on the daemon (#11072): never heartbeat it again.
    if (losses.containsKey(sessionId)) return
    synchronized(startLock) {
      sessions.add(sessionId)
      ensureRunning()
    }
  }

  fun removeSession(sessionId: String) {
    // Under startLock so an in-flight heartbeat's bookkeeping (taken under the same lock) cannot
    // interleave with the prune and re-create state for the removed id.
    synchronized(startLock) {
      sessions.remove(sessionId)
      // Prune per-id bookkeeping so a long-lived JVM does not grow with every plan UUID. `losses`
      // stays: it is the terminal marker that keeps a released id from being heartbeated again.
      clearProgress(sessionId)
      stopIfUnneededLocked()
    }
  }

  private fun clearProgress(sessionId: String) {
    confirmed.remove(sessionId)
    unconfirmedMisses.remove(sessionId)
  }

  /** Ids with acknowledged/miss bookkeeping still held; for tests asserting pruning. */
  internal fun hasProgressState(sessionId: String): Boolean =
    confirmed.contains(sessionId) || unconfirmedMisses.containsKey(sessionId)

  /** Why the daemon released [sessionId] while it was heartbeated, or null if it has not. */
  fun sessionLoss(sessionId: String): DaemonSessionLoss? = losses[sessionId]

  // Called under startLock so holder changes and thread lifecycle stay together.
  private fun ensureRunning() {
    if (running.get()) {
      return
    }
    val loopRunning = AtomicBoolean(true)
    running = loopRunning
    // Each run keeps its own stop flag, even if a new holder starts before the old loop exits.
    heartbeatThread =
      threadFactory("auto-mobile-daemon-heartbeat", Runnable { runLoop(loopRunning) })
  }

  private fun stop() {
    synchronized(startLock) {
      if (refCount.decrementAndGet() > 0) {
        return
      }
      stopLoopLocked()
    }
  }

  /** A holderless loop exists only for its sessions; once none remain it ends. */
  private fun stopIfUnneededLocked() {
    if (refCount.get() == 0 && sessions.isEmpty()) stopLoopLocked()
  }

  private fun stopLoopLocked() {
    running.set(false)
    heartbeatThread?.interrupt()
    heartbeatThread = null
  }

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
      if (loopRunning.get()) recordReleaseLocked(sessionId, released)
    }
  }

  private fun recordReleaseLocked(sessionId: String, released: DaemonSessionReleasedException) {
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
    clearProgress(sessionId)
    warn("${loss.describe()}; no longer heartbeating it")
    stopIfUnneededLocked()
  }

  private fun recordAcknowledged(sessionId: String, loopRunning: AtomicBoolean) {
    synchronized(startLock) {
      if (loopRunning.get() && sessions.contains(sessionId)) {
        confirmed.add(sessionId)
        unconfirmedMisses.remove(sessionId)
      }
    }
  }

  private fun runLoop(loopRunning: AtomicBoolean) {
    while (loopRunning.get()) {
      sessions.toList().forEach { sessionId -> dispatchBeat(sessionId, loopRunning) }

      try {
        sleeper(intervalMs)
      } catch (_: InterruptedException) {
        // Allow loop to exit if stopped.
      }
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
