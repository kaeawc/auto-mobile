package dev.jasonpearson.automobile.junit

import java.io.Closeable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

internal class BackgroundHeartbeatManager(
  private val sendHeartbeat: (String) -> Unit,
  private val sleeper: (Long) -> Unit = { Thread.sleep(it) },
  private val threadFactory: (String, Runnable) -> Thread = { name, runnable ->
    thread(start = true, isDaemon = true, name = name) { runnable.run() }
  },
) {
  private val sessions = ConcurrentHashMap.newKeySet<String>()
  private val losses = ConcurrentHashMap<String, DaemonSessionLoss>()
  // Sessions the daemon has acknowledged at least once; only then is a bare 404 a real loss.
  private val confirmed = ConcurrentHashMap.newKeySet<String>()
  private val unconfirmedMisses = ConcurrentHashMap<String, Int>()
  @Volatile private var running = AtomicBoolean(false)
  private val startLock = Any()
  private val refCount = AtomicInteger(0)
  @Volatile private var intervalMs: Long = 1_000L
  @Volatile private var heartbeatThread: Thread? = null

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
    sessions.remove(sessionId)
  }

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
      running.set(false)
      heartbeatThread?.interrupt()
      heartbeatThread = null
    }
  }

  /**
   * A 404 for an id the daemon never acknowledged is usually a session it has not created yet
   * (registration precedes executePlan), so keep heartbeating it, bounded. A 404 after a successful
   * heartbeat, or carrying a `releaseReason`, means the daemon released it (#11072).
   */
  private fun recordRelease(sessionId: String, released: DaemonSessionReleasedException) {
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
    println("Warning: ${loss.describe()}; no longer heartbeating it")
  }

  private fun runLoop(loopRunning: AtomicBoolean) {
    while (loopRunning.get()) {
      val snapshot = sessions.toList()
      snapshot.forEach { sessionId ->
        try {
          sendHeartbeat(sessionId)
          confirmed.add(sessionId)
          unconfirmedMisses.remove(sessionId)
        } catch (released: DaemonSessionReleasedException) {
          recordRelease(sessionId, released)
        } catch (_: Exception) {
          // A missed heartbeat is transient (daemon restarting, socket busy); the next tick
          // retries.
        }
      }

      try {
        sleeper(intervalMs)
      } catch (_: InterruptedException) {
        // Allow loop to exit if stopped.
      }
    }
  }

  private companion object {
    /** About 30 s at the 1 s cadence: how long a never-acknowledged id may 404 before giving up. */
    const val MAX_UNCONFIRMED_MISSES = 30
  }
}
