package dev.jasonpearson.automobile.ctrlproxy

/**
 * Routes wire requests to streamed gestures. Every map access and [GestureStreamSession] finish
 * callback runs on the gesture thread; callers may invoke [start], [move], and [end] from IO
 * threads. Failed terminal results remain available for a late end request until consumed or
 * evicted; success needs no stored result because it is the default for an already-finished
 * gesture.
 */
internal class GestureStreamRouter(
  private val runOnGestureThread: (() -> Unit) -> Boolean,
  private val newSession: ((Boolean, String?) -> Unit) -> GestureStreamSession<*>,
  private val onResult: (String?, Boolean, String?) -> Unit,
) {
  private data class Outcome(val success: Boolean, val error: String?)

  private companion object {
    const val MAX_TERMINAL_FAILURES = 16
  }

  private val sessions = mutableMapOf<String, GestureStreamSession<*>>()
  private val pendingEndRequestIds = mutableMapOf<String, MutableList<String>>()
  private val terminalFailures = linkedMapOf<String, Outcome>()
  private var closed = false

  fun start(requestId: String?, gestureId: String, x: Float, y: Float, displayId: Int? = null) =
    runOnGestureThread {
      if (closed) return@runOnGestureThread
      if (sessions.containsKey(gestureId)) {
        onResult(requestId, false, "Gesture $gestureId is already active")
        return@runOnGestureThread
      }
      // A new stream with the same wire id supersedes an unclaimed old result.
      terminalFailures.remove(gestureId)
      val session = newSession { success, error -> finish(gestureId, success, error) }
      sessions[gestureId] = session
      session.start(x, y, displayId)
      onResult(requestId, true, null)
    }

  fun move(requestId: String?, gestureId: String, x: Float, y: Float) = runOnGestureThread {
    if (closed) return@runOnGestureThread
    // A move after completion is a benign late frame.
    sessions[gestureId]?.move(x, y)
    onResult(requestId, true, null)
  }

  fun end(requestId: String?, gestureId: String, x: Float, y: Float, cancel: Boolean) =
    runOnGestureThread {
      if (closed) return@runOnGestureThread
      val session = sessions[gestureId]
      if (session == null) {
        // A failure can arrive before the end frame. Return its actual result to that awaiter.
        val outcome = terminalFailures.remove(gestureId)
        onResult(requestId, outcome?.success ?: true, outcome?.error)
        return@runOnGestureThread
      }
      if (requestId != null) {
        pendingEndRequestIds.getOrPut(gestureId) { mutableListOf() }.add(requestId)
      }
      session.end(x, y, cancel)
    }

  private fun finish(gestureId: String, success: Boolean, error: String?) {
    if (closed) return
    sessions.remove(gestureId)
    val requestIds = pendingEndRequestIds.remove(gestureId)
    if (!success) {
      terminalFailures[gestureId] = Outcome(success, error)
      if (terminalFailures.size > MAX_TERMINAL_FAILURES) {
        terminalFailures.remove(terminalFailures.keys.first())
      }
    }
    requestIds?.forEach { onResult(it, success, error) }
  }

  /**
   * Observe pending acknowledgments on the gesture thread for diagnostics and deterministic tests.
   */
  internal fun pendingEndCount(onCount: (Int) -> Unit) = runOnGestureThread {
    onCount(pendingEndRequestIds.values.sumOf { it.size })
  }

  /** Observe retained failures on the gesture thread for deterministic tests. */
  internal fun terminalFailureCount(onCount: (Int) -> Unit) = runOnGestureThread {
    onCount(terminalFailures.size)
  }

  /** Cancel active strokes and clear routing state on the gesture thread before stopping it. */
  fun close(onClosed: () -> Unit = {}) {
    val posted = runOnGestureThread {
      try {
        if (!closed) {
          closed = true
          // Cancellation can synchronously finish a session; keep the snapshot stable.
          sessions.values.toList().forEach { it.cancel() }
          pendingEndRequestIds.values.flatten().forEach {
            onResult(it, false, "Gesture stream closed")
          }
          sessions.clear()
          pendingEndRequestIds.clear()
          terminalFailures.clear()
        }
      } finally {
        onClosed()
      }
    }
    // A second destroy can arrive after quitSafely; Handler.post then rejects the task.
    if (!posted) onClosed()
  }
}
