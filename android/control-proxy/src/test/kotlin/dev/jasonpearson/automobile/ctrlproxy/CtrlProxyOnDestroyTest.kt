package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.RectF
import android.os.Handler
import android.os.Looper
import dev.jasonpearson.automobile.ctrlproxy.overlay.FakeInteractiveOverlayHost
import dev.jasonpearson.automobile.ctrlproxy.overlay.OverlayController
import dev.jasonpearson.automobile.ctrlproxy.overlay.OverlayResultSink
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ServiceController
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowAccessibilityService
import org.robolectric.shadows.ShadowLog
import org.robolectric.util.ReflectionHelpers

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class CtrlProxyOnDestroyTest {
  private data class Ack(val id: String?, val success: Boolean, val error: String?)

  private class InlineGestureThread : GestureThread {
    override val handler = Handler(Looper.getMainLooper())
    var quits = 0
    var postFailure: RuntimeException? = null
    var onQuit: () -> Unit = {}

    override fun post(work: () -> Unit): Boolean {
      postFailure?.let { throw it }
      // Accept even after quit to exercise the router's closed guard, as with already queued work.
      work()
      return true
    }

    override fun quitSafely() {
      quits++
      onQuit()
    }
  }

  private lateinit var controller: ServiceController<CtrlProxy>
  private lateinit var service: CtrlProxy
  private lateinit var thread: InlineGestureThread
  private lateinit var shadow: ShadowAccessibilityService
  private lateinit var scopeJob: Job
  private lateinit var server: WebSocketServer
  private lateinit var serverRetryJob: Job
  private val acks = mutableListOf<Ack>()
  private var destroyed = false

  @Before
  fun setUp() {
    controller = Robolectric.buildService(CtrlProxy::class.java)
    service = controller.get()
    thread = InlineGestureThread()
    var creations = 0
    service.gestureThreadFactory = {
      creations++
      thread
    }
    assertEquals(0, creations)
    controller.create()
    assertEquals(1, creations)
    shadow = shadowOf(service)
    shadow.setCanDispatchGestures(true)

    // Observe the real router's result sink without launching IO work or opening a socket. The
    // service, router, session, coordinator and AccessibilityStrokeDispatcher remain real.
    val router = ReflectionHelpers.getField<GestureStreamRouter>(service, "gestureStreamRouter")
    val onResult: (String?, Boolean, String?) -> Unit = { id, success, error ->
      if (error == "Gesture stream closed") {
        assertTerminalLift()
        assertEquals(0, thread.quits)
      }
      acks.add(Ack(id, success, error))
    }
    ReflectionHelpers.setField(router, "onResult", onResult)
    val scope = ReflectionHelpers.getField<CoroutineScope>(service, "serviceScope")
    scopeJob = requireNotNull(scope.coroutineContext[Job])

    // onServiceConnected starts a listener and logcat process. Keep this test offline: attach a
    // real, unstarted server to the existing lifecycle and observe stop cancelling its retry job.
    // This job is independent of serviceScope, so cancelling the scope alone cannot pass the check.
    server = WebSocketServer(scope = scope)
    serverRetryJob = Job()
    ReflectionHelpers.setField(server, "startRetryJob", serverRetryJob)
    ReflectionHelpers.setField(service, "webSocketServer", server)
    ReflectionHelpers.getField<ServerLifecycle<WebSocketServer>>(service, "webSocketLifecycle")
      .replace(server)
  }

  @After
  fun tearDown() {
    if (::thread.isInitialized) {
      thread.postFailure = null
      thread.onQuit = {}
      if (!destroyed) controller.destroy()
    }
    if (::serverRetryJob.isInitialized) serverRetryJob.cancel()
  }

  @Test
  fun `onDestroy destroys interactive host outside the cancelled service scope`() {
    val host = FakeInteractiveOverlayHost()
    ReflectionHelpers.setField(
      service,
      "overlayController",
      OverlayController(host, OverlayResultSink { _, _, _ -> }),
    )
    destroyService()
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(listOf("destroy"), host.calls)
    assertTrue(scopeJob.isCancelled)
  }

  @Test
  fun `onDestroy dispatches in-flight terminal lift and answers pending ends before quitting without awaiting completion`() {
    service.requestGestureStart("start", "gesture", 1.0, 2.0)
    service.requestGestureEnd("end-1", "gesture", 3.0, 4.0, false)
    service.requestGestureEnd("end-2", "gesture", 5.0, 6.0, false)
    assertEquals(listOf(Ack("start", true, null)), acks)
    assertEquals(1, shadow.gesturesDispatched.size)
    assertTrue(shadow.gesturesDispatched.single().description().getStroke(0).willContinue())
    assertTrue(scopeJob.isActive)
    assertTrue(serverRetryJob.isActive)

    thread.onQuit = {
      // close -> session.cancel -> pump -> dispatchGesture happens in the same runnable as quit.
      // Completion is deliberately unconfirmed; Android cancels service-owned gestures on teardown.
      assertTerminalLift()
      assertEquals(
        listOf(
          Ack("start", true, null),
          Ack("end-1", false, "Gesture stream closed"),
          Ack("end-2", false, "Gesture stream closed"),
        ),
        acks,
      )
      assertTrue(serverRetryJob.isCancelled)
      assertTrue(scopeJob.isActive)
    }

    destroyService()

    assertEquals(1, thread.quits)
    assertFalse(server.isRunning())
    assertNull(ReflectionHelpers.getField<Job?>(server, "startRetryJob"))
    assertTrue(scopeJob.isCancelled)
    assertClosedAndIgnoresLateCallbacks()
  }

  @Test
  fun `onDestroy dispatches terminal lift for a parked continued stroke before quitting`() {
    service.requestGestureStart("start", "gesture", 1.0, 2.0)
    val press = shadow.gesturesDispatched.single()
    press.callback().onCompleted(press.description())
    assertEquals(1, shadow.gesturesDispatched.size)
    thread.onQuit = { assertTerminalLift() }

    destroyService()

    assertEquals(1, thread.quits)
    assertTrue(serverRetryJob.isCancelled)
    assertTrue(scopeJob.isCancelled)
    assertClosedAndIgnoresLateCallbacks()
  }

  @Test
  fun `onDestroy quits gesture thread and cancels service scope even when real router close throws`() {
    service.requestGestureStart("start", "gesture", 1.0, 2.0)
    val failure = IllegalStateException("gesture close post failed")
    thread.postFailure = failure

    destroyService()

    assertEquals(1, thread.quits)
    assertTrue(serverRetryJob.isCancelled)
    assertTrue(scopeJob.isCancelled)
    assertTrue(
      ShadowLog.getLogs().any {
        it.msg == "Failed to close streamed gestures" && it.throwable === failure
      }
    )
  }

  private fun destroyService() {
    controller.destroy()
    destroyed = true
  }

  private fun assertTerminalLift() {
    assertEquals(2, shadow.gesturesDispatched.size)
    val press = shadow.gesturesDispatched.first().description().getStroke(0)
    val lift = shadow.gesturesDispatched.last().description().getStroke(0)
    assertFalse(lift.willContinue())
    // Stroke IDs are hidden Android APIs; inspect them only in the test, using Robolectric.
    assertEquals(
      ReflectionHelpers.getField<Int>(press, "mId"),
      ReflectionHelpers.getField<Int>(lift, "mContinuedStrokeId"),
    )
    val bounds = RectF()
    lift.path.computeBounds(bounds, true)
    assertEquals(RectF(1f, 2f, 1f, 2f), bounds)
  }

  private fun assertClosedAndIgnoresLateCallbacks() {
    val before = acks.toList()
    val dispatched = shadow.gesturesDispatched.toList()
    dispatched.forEach {
      it.callback().onCompleted(it.description())
      it.callback().onCancelled(it.description())
    }
    service.requestGestureStart("late-start", "late", 7.0, 8.0)
    service.requestGestureMove("late-move", "gesture", 7.0, 8.0)
    service.requestGestureEnd("late-end", "gesture", 7.0, 8.0, false)
    assertEquals(before, acks)
    assertEquals(dispatched, shadow.gesturesDispatched)
  }
}
