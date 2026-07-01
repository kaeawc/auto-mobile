package dev.jasonpearson.automobile.sdk.session

import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** Interface for tracking user sessions based on app foreground/background state. */
internal interface SessionTracking {
  fun currentSessionId(): String?

  fun onForeground()

  fun onBackground()

  fun shutdown()
}

/**
 * Tracks user sessions based on app foreground/background state. A new session starts on first
 * foreground or after the timeout expires while backgrounded.
 *
 * @param timeoutMs How long the app can be backgrounded before a new session starts (default 30s)
 * @param uuidProvider Injectable UUID generator for testing
 * @param timerFactory Injectable timer for testing - takes a delayMs and Runnable, returns a cancel
 *   function
 */
internal class SessionTracker(
    private val timeoutMs: Long = 30_000L,
    private val uuidProvider: () -> String = { java.util.UUID.randomUUID().toString() },
    private val timerFactory: (Long, Runnable) -> (() -> Unit) = { delayMs, action ->
      val executor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "SessionTimeout").apply { isDaemon = true }
      }
      val future = executor.schedule(action, delayMs, TimeUnit.MILLISECONDS)
      val cancel: () -> Unit = {
        future.cancel(false)
        executor.shutdown()
      }
      cancel
    },
) : SessionTracking {

  private val lock = ReentrantLock()

  @Volatile private var _sessionId: String? = null
  private var timeoutCancel: (() -> Unit)? = null
  private var state: SessionState = SessionState.ENDED

  enum class SessionState {
    ACTIVE,
    BACKGROUNDED,
    ENDED,
  }

  override fun currentSessionId(): String? = _sessionId

  override fun onForeground() {
    lock.withLock {
      timeoutCancel?.invoke()
      timeoutCancel = null

      when (state) {
        SessionState.ENDED -> {
          _sessionId = uuidProvider()
          state = SessionState.ACTIVE
        }
        SessionState.BACKGROUNDED -> {
          state = SessionState.ACTIVE
        }
        SessionState.ACTIVE -> {}
      }
    }
  }

  override fun onBackground() {
    lock.withLock {
      if (state != SessionState.ACTIVE) return
      state = SessionState.BACKGROUNDED
      timeoutCancel =
          timerFactory(
              timeoutMs,
              Runnable {
                lock.withLock {
                  if (state == SessionState.BACKGROUNDED) {
                    state = SessionState.ENDED
                    _sessionId = null
                  }
                }
              },
          )
    }
  }

  override fun shutdown() {
    lock.withLock {
      timeoutCancel?.invoke()
      timeoutCancel = null
      state = SessionState.ENDED
      _sessionId = null
    }
  }
}
