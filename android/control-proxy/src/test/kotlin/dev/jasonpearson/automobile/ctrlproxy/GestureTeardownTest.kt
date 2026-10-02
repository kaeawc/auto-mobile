package dev.jasonpearson.automobile.ctrlproxy

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GestureTeardownTest {
  private data class Ack(val id: String?, val success: Boolean, val error: String?)

  private class FakeStroke(val segment: GestureSegment)

  private class FakeDispatcher : StrokeDispatcher<FakeStroke> {
    val strokes = mutableListOf<GestureSegment>()
    var complete: (() -> Unit)? = null

    override fun initialStroke(segment: GestureSegment) = FakeStroke(segment)

    override fun continueStroke(previous: FakeStroke, segment: GestureSegment) = FakeStroke(segment)

    override fun dispatch(
      stroke: FakeStroke,
      onComplete: () -> Unit,
      onFailed: (String) -> Unit,
      displayId: Int?,
    ) {
      strokes.add(stroke.segment)
      complete = onComplete
    }
  }

  @Test
  fun `teardown lifts active stroke and answers end before quitting`() {
    val dispatcher = FakeDispatcher()
    val acks = mutableListOf<Ack>()
    val scope = CoroutineScope(SupervisorJob())
    val router =
      GestureStreamRouter(
        runOnGestureThread = {
          it()
          true
        },
        newSession = { onFinished ->
          GestureStreamSession(GestureStreamCoordinator(), dispatcher, { it() }, onFinished)
        },
        onResult = { id, success, error -> acks.add(Ack(id, success, error)) },
      )
    router.start("start", "gesture", 1f, 2f)
    router.end("end", "gesture", 3f, 4f, cancel = false)
    var quits = 0
    val quitThread = {
      assertEquals(2, dispatcher.strokes.size)
      assertFalse(dispatcher.strokes.last().willContinue)
      assertEquals(dispatcher.strokes.last().from, dispatcher.strokes.last().to)
      assertEquals(
        listOf(Ack("end", false, "Gesture stream closed")),
        acks.filter { it.id == "end" },
      )
      quits++
      Unit
    }

    teardownGestures(router::close, quitThread, { scope.cancel() }, { throw it })
    dispatcher.complete?.invoke() // late platform result cannot send a second ack
    teardownGestures(router::close, quitThread, { scope.cancel() }, { throw it })

    assertEquals(2, quits)
    assertEquals(1, acks.count { it.id == "end" })
    assertFalse(scope.coroutineContext[Job]!!.isActive)
  }

  @Test
  fun `teardown quits thread and cancels scope when close throws`() {
    val scope = CoroutineScope(SupervisorJob())
    var quits = 0
    var logged: Throwable? = null

    teardownGestures(
      close = { error("close failed") },
      quitThread = { quits++ },
      cancelScope = { scope.cancel() },
      onCloseFailure = { logged = it },
    )

    assertEquals("close failed", logged?.message)
    assertEquals(1, quits)
    assertFalse(scope.coroutineContext[Job]!!.isActive)
    assertTrue(scope.coroutineContext[Job]!!.isCancelled)
  }
}
