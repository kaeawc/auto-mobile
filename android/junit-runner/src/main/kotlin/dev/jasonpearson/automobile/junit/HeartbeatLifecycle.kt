package dev.jasonpearson.automobile.junit

import java.io.Closeable
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** Thread and holder lifecycle, serialized with session membership by the manager's lock. */
internal class HeartbeatLifecycle(
  private val startLock: Any,
  private val hasNoSessions: () -> Boolean,
  private val sleeper: (Long) -> Unit,
  private val threadFactory: (String, Runnable) -> Thread,
  private val cycle: (AtomicBoolean) -> Unit,
) {
  // The reference is swapped under startLock for each run: a loop owns the flag it was started
  // with, so a new holder can start a fresh loop while an old one is still winding down.
  @Volatile private var running: AtomicBoolean = AtomicBoolean(false)
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

  // Called under startLock so holder changes and thread lifecycle stay together.
  fun ensureRunning() {
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
  fun stopIfUnneededLocked() {
    if (refCount.get() == 0 && hasNoSessions()) stopLoopLocked()
  }

  private fun stopLoopLocked() {
    running.set(false)
    heartbeatThread?.interrupt()
    heartbeatThread = null
  }

  private fun runLoop(loopRunning: AtomicBoolean) {
    while (loopRunning.get()) {
      cycle(loopRunning)

      try {
        sleeper(intervalMs)
      } catch (_: InterruptedException) {
        // Allow loop to exit if stopped.
      }
    }
  }
}
