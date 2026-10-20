package dev.jasonpearson.automobile.ctrlproxy

import io.ktor.websocket.CloseReason
import java.util.ArrayDeque
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.BeforeClass

/** Shared deterministic stroke dispatcher, session, and queued router fixtures. */
@OptIn(ExperimentalCoroutinesApi::class)
internal abstract class GestureStreamSessionTestFixtures {
  companion object {
    @BeforeClass
    @JvmStatic
    fun warmScheduler() {
      runTest {} // Keep coroutine scheduler initialization outside per-test timing.
    }
  }

  protected class FakeStroke(val segment: GestureSegment, val parent: FakeStroke? = null)

  protected class FakeStrokeDispatcher(
    private val initialError: Exception? = null,
    private val continueError: Exception? = null,
    private val dispatchError: Exception? = null,
  ) : StrokeDispatcher<FakeStroke> {
    data class Call(
      val stroke: FakeStroke,
      val complete: () -> Unit,
      val fail: (String) -> Unit,
      val reject: (String) -> Unit,
    )

    val calls = mutableListOf<Call>()
    val dispatched = mutableListOf<GestureSegment>()
    val displays = mutableListOf<Int?>()
    var initialCount = 0
    var continueCount = 0
    var nextContinueError: Exception? = null
    var nextDispatchError: Exception? = null
    private var pending: Call? = null

    override fun initialStroke(segment: GestureSegment): FakeStroke {
      initialCount++
      initialError?.let { throw it }
      return FakeStroke(segment)
    }

    override fun continueStroke(previous: FakeStroke, segment: GestureSegment): FakeStroke {
      continueCount++
      val nextError = nextContinueError
      nextContinueError = null
      nextError?.let { throw it }
      continueError?.let { throw it }
      return FakeStroke(segment, previous)
    }

    override fun dispatch(
      stroke: FakeStroke,
      onComplete: () -> Unit,
      onFailed: (error: String) -> Unit,
      displayId: Int?,
    ) = dispatchContinuing(stroke, onComplete, onFailed, onFailed, displayId)

    override fun dispatchContinuing(
      stroke: FakeStroke,
      onComplete: () -> Unit,
      onFailed: (error: String) -> Unit,
      onRejected: (error: String) -> Unit,
      displayId: Int?,
    ) {
      dispatched.add(stroke.segment)
      displays.add(displayId)
      val call = Call(stroke, onComplete, onFailed, onRejected)
      calls.add(call)
      pending = call
      val nextError = nextDispatchError
      nextDispatchError = null
      nextError?.let { throw it }
      dispatchError?.let { throw it }
    }

    /** Fire the in-flight stroke's completion, driving the loop one step. */
    fun completeLast() {
      val call = requireNotNull(pending) { "no stroke in flight" }
      pending = null
      call.complete()
    }

    fun failLast(error: String) {
      val call = requireNotNull(pending) { "no stroke in flight" }
      pending = null
      call.fail(error)
    }

    fun rejectLast(error: String) {
      val call = requireNotNull(pending) { "no stroke in flight" }
      pending = null
      call.reject(error)
    }
  }

  protected class Session(val dispatcher: FakeStrokeDispatcher = FakeStrokeDispatcher()) {
    var finishedSuccess: Boolean? = null
    var finishedError: String? = null
    var finishCount = 0
    val session =
      GestureStreamSession(
        coordinator = GestureStreamCoordinator(),
        dispatcher = dispatcher,
        runOnGestureThread = { it() }, // immediate: dispatch stores the callback, so no recursion
        onFinished = { success, error ->
          finishCount++
          finishedSuccess = success
          finishedError = error
        },
      )

    fun assertRelease(anchor: FakeStroke, at: GesturePoint) {
      val release = dispatcher.calls.last().stroke
      assertSame(anchor, release.parent)
      assertEquals(GestureSegment(at, at, 1L, false, false, true), release.segment)
      assertEquals(0, finishCount)
    }

    fun assertFailedOnce(message: String) {
      assertEquals(1, finishCount)
      assertEquals(false, finishedSuccess)
      assertEquals(message, finishedError)
    }
  }

  protected data class Ack(val requestId: String?, val success: Boolean, val error: String?)

  protected class RouterHarness {
    private val gestureQueue = ArrayDeque<() -> Unit>()
    var acceptPosts = true
    val dispatchers = mutableListOf<FakeStrokeDispatcher>()
    val acks = mutableListOf<Ack>()
    val warnings = mutableListOf<String>()
    val router =
      GestureStreamRouter(
        runOnGestureThread = {
          if (acceptPosts) gestureQueue.addLast(it)
          acceptPosts
        },
        newSession = { onFinished ->
          val dispatcher = FakeStrokeDispatcher()
          dispatchers.add(dispatcher)
          GestureStreamSession(
            coordinator = GestureStreamCoordinator(),
            dispatcher = dispatcher,
            runOnGestureThread = { gestureQueue.addLast(it) },
            onFinished = onFinished,
          )
        },
        onResult = { requestId, success, error -> acks.add(Ack(requestId, success, error)) },
        logWarning = { warnings.add(it) },
      )

    fun drain() {
      while (gestureQueue.isNotEmpty()) gestureQueue.removeFirst()()
    }

    fun pendingEndCount(): Int {
      var count = -1
      router.pendingEndCount { count = it }
      drain()
      return count
    }

    fun terminalFailureCount(): Int {
      var count = -1
      router.terminalFailureCount { count = it }
      drain()
      return count
    }
  }

  protected fun owner(id: Int = 1) =
    WebSocketServer.ConnectedClient(
      id,
      object : WebSocketServer.ClientTransport {
        override suspend fun send(message: String) = Unit

        override suspend fun close(reason: CloseReason) = Unit
      },
      Channel(1),
      Channel(1),
    )
}
