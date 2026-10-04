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
  private val logWarning: (String) -> Unit = {},
) {
  private data class Outcome(val success: Boolean, val error: String?)

  private data class PendingEnd(
    val requestId: String,
    val requester: WebSocketServer.ConnectedClient?,
  )

  private class Gesture(
    val owner: WebSocketServer.ConnectedClient?,
    val session: GestureStreamSession<*>,
  ) {
    var disconnected = false
  }

  private companion object {
    const val MAX_TERMINAL_FAILURES = 16
  }

  private val sessions = mutableMapOf<String, Gesture>()
  private val pendingEndRequests = mutableMapOf<String, MutableList<PendingEnd>>()
  private val terminalFailures = linkedMapOf<String, Outcome>()
  private var closed = false

  fun start(
    requestId: String?,
    gestureId: String,
    x: Float,
    y: Float,
    displayId: Int? = null,
    owner: WebSocketServer.ConnectedClient? = null,
  ) = runOnGestureThread {
    // A command can post its start just after the disconnect hook posts cancellation.
    if (closed || owner?.isConnected == false) return@runOnGestureThread
    if (sessions.containsKey(gestureId)) {
      onResult(requestId, false, "Gesture $gestureId is already active")
      return@runOnGestureThread
    }
    // A new stream with the same wire id supersedes an unclaimed old result.
    terminalFailures.remove(gestureId)
    lateinit var gesture: Gesture
    val session = newSession { success, error -> finish(gestureId, gesture, success, error) }
    gesture = Gesture(owner, session)
    sessions[gestureId] = gesture
    session.start(x, y, displayId)
    onResult(requestId, true, null)
  }

  /** Fail other connected awaiters before cancelling on the existing gesture thread. */
  fun cancelOwnedBy(owner: WebSocketServer.ConnectedClient) = runOnGestureThread {
    val owned = sessions.filterValues { it.owner === owner }
    owned.forEach { (gestureId, gesture) ->
      gesture.disconnected = true
      sessions.remove(gestureId)
      pendingEndRequests.remove(gestureId)?.forEach { pending ->
        // Unattributed ends retain the existing disconnect behavior: no reply.
        val requester = pending.requester
        if (requester != null && requester !== owner && requester.isConnected) {
          onResult(pending.requestId, false, "Gesture owner disconnected")
        }
      }
      terminalFailures.remove(gestureId)
      gesture.session.cancel()
    }
  }

  fun move(requestId: String?, gestureId: String, x: Float, y: Float) = runOnGestureThread {
    if (closed) return@runOnGestureThread
    // A move after completion is a benign late frame.
    sessions[gestureId]?.session?.move(x, y)
    onResult(requestId, true, null)
  }

  fun end(
    requestId: String?,
    gestureId: String,
    x: Float,
    y: Float,
    cancel: Boolean,
    requester: WebSocketServer.ConnectedClient? = null,
  ) = runOnGestureThread {
    if (closed) return@runOnGestureThread
    val session = sessions[gestureId]?.session
    if (session == null) {
      // A failure can arrive before the end frame. Return its actual result to that awaiter.
      val outcome = terminalFailures.remove(gestureId)
      onResult(requestId, outcome?.success ?: true, outcome?.error)
      return@runOnGestureThread
    }
    if (requestId != null) {
      pendingEndRequests
        .getOrPut(gestureId) { mutableListOf() }
        .add(PendingEnd(requestId, requester))
    }
    session.end(x, y, cancel)
  }

  private fun finish(gestureId: String, gesture: Gesture, success: Boolean, error: String?) {
    if (gesture.disconnected) {
      if (!success) logWarning("Failed to release disconnected gesture $gestureId: $error")
      return
    }
    if (closed || sessions[gestureId] !== gesture) return
    sessions.remove(gestureId)
    val requests = pendingEndRequests.remove(gestureId)
    if (!success) {
      terminalFailures[gestureId] = Outcome(success, error)
      if (terminalFailures.size > MAX_TERMINAL_FAILURES) {
        terminalFailures.remove(terminalFailures.keys.first())
      }
    }
    requests?.forEach { onResult(it.requestId, success, error) }
  }

  /**
   * Observe pending acknowledgments on the gesture thread for diagnostics and deterministic tests.
   */
  internal fun pendingEndCount(onCount: (Int) -> Unit) = runOnGestureThread {
    onCount(pendingEndRequests.values.sumOf { it.size })
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
          sessions.values.toList().forEach { it.session.cancel() }
          pendingEndRequests.values.flatten().forEach {
            onResult(it.requestId, false, "Gesture stream closed")
          }
          sessions.clear()
          pendingEndRequests.clear()
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
