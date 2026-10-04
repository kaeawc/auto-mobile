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
    synchronized(startLock) {
      sessions.add(sessionId)
      ensureRunning()
    }
  }

  fun removeSession(sessionId: String) {
    sessions.remove(sessionId)
  }

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

  private fun runLoop(loopRunning: AtomicBoolean) {
    while (loopRunning.get()) {
      val snapshot = sessions.toList()
      snapshot.forEach { sessionId ->
        try {
          sendHeartbeat(sessionId)
        } catch (_: Exception) {
          // Best-effort heartbeat; ignore failures
        }
      }

      try {
        sleeper(intervalMs)
      } catch (_: InterruptedException) {
        // Allow loop to exit if stopped.
      }
    }
  }
}
