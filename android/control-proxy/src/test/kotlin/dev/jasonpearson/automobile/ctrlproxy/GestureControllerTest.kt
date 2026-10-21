package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityService.GestureResultCallback
import android.accessibilityservice.GestureDescription
import android.os.Handler
import android.os.Looper
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.RequestGestureStart
import dev.jasonpearson.automobile.protocol.RequestPinch
import dev.jasonpearson.automobile.protocol.RequestSwipe
import dev.jasonpearson.automobile.protocol.RequestTapCoordinates
import dev.jasonpearson.automobile.protocol.RequestTwoFingerSwipe
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Exercises [GestureController] behind fakes for its seams: the accessibility service's
 * `dispatchGesture`, the frame context, the caret, the settled hierarchy and the WebSocket server.
 * Stroke shapes through the real service are pinned by [CtrlProxyGestureDispatchPinTest].
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
@OptIn(ExperimentalCoroutinesApi::class)
class GestureControllerTest {
  private class FakeTimer : TimeProvider {
    var now = 1_000L

    override fun currentTimeMillis() = now
  }

  private class InlineGestureThread : GestureThread {
    override val handler = Handler(Looper.getMainLooper())

    override fun post(work: () -> Unit): Boolean {
      work()
      return true
    }

    override fun quitSafely() = Unit
  }

  private class FakeHost(
    private val scope: CoroutineScope,
    private val events: MutableList<String>,
  ) : GestureController.Host {
    data class Dispatch(val gesture: GestureDescription, val callback: GestureResultCallback)

    val dispatches = mutableListOf<Dispatch>()
    var frameContext = "epoch:1"
    var forgets = 0
    var settled: ViewHierarchy? = null
    val settledDisplays = mutableListOf<Int?>()

    override fun dispatchGesture(
      gesture: GestureDescription,
      callback: GestureResultCallback,
      handler: Handler,
    ): Boolean {
      dispatches += Dispatch(gesture, callback)
      return true
    }

    override fun currentFrameContext() = frameContext

    override fun launchRequestScope(requestId: String?, block: suspend CoroutineScope.() -> Unit) {
      scope.launch(block = block)
    }

    override fun forgetRememberedInsert() {
      forgets++
    }

    override suspend fun settledHierarchy(displayId: Int?): ViewHierarchy? {
      settledDisplays += displayId
      return settled
    }

    override suspend fun publishHierarchy(hierarchy: ViewHierarchy) {
      events += "hierarchy"
    }
  }

  private class FakeSender(private val events: MutableList<String>) : FakeResultTransport() {
    val frames = mutableListOf<JsonObject>()

    override suspend fun sendFrame(frame: String) {
      val parsed = Json.parseToJsonElement(frame).jsonObject
      frames += parsed
      events += parsed.getValue("type").jsonPrimitive.content
    }
  }

  private val events = mutableListOf<String>()
  private val scope = CoroutineScope(UnconfinedTestDispatcher() + SupervisorJob())
  private val timer = FakeTimer()
  private val host = FakeHost(scope, events)
  private val sender = FakeSender(events)
  private val controller =
    GestureController(
        host = host,
        scope = { scope },
        reporting =
          GestureReportingDependencies(
            perfProvider = PerfProvider.createForTesting(timer),
            timeProvider = timer,
            resultSender =
              guardedResultSender(
                sender,
                ResultBroadcaster(broadcastError = {}, logError = { _, _ -> }),
              ),
          ),
        gestureThreadFactory = ::InlineGestureThread,
      )
      .also { it.startThread() }

  private fun completeLast(elapsedMs: Long) {
    timer.now += elapsedMs
    host.dispatches.last().let { it.callback.onCompleted(it.gesture) }
  }

  @Test
  fun `completed swipe reports success with gesture and total time`() {
    controller.performSwipe(RequestSwipe("swipe", 1.0, 2.0, 3.0, 4.0, 250L, "epoch:1", null))
    assertEquals(1, host.forgets)
    assertTrue(sender.frames.isEmpty())
    completeLast(250L)
    val frame = sender.frames.single()
    assertEquals("swipe_result", frame.getValue("type").jsonPrimitive.content)
    assertEquals("swipe", frame.getValue("requestId").jsonPrimitive.content)
    assertTrue(frame.getValue("success").jsonPrimitive.boolean)
    assertEquals(250L, frame.getValue("gestureTimeMs").jsonPrimitive.long)
    assertEquals(250L, frame.getValue("totalTimeMs").jsonPrimitive.long)
  }

  @Test
  fun `cancelled pinch reports failure without a gesture time`() {
    controller.performPinch(RequestPinch("pinch", 100.0, 100.0, 10.0, 50.0, 0f, 300L, null))
    host.dispatches.last().let { it.callback.onCancelled(it.gesture) }
    val frame = sender.frames.single()
    assertEquals("pinch_result", frame.getValue("type").jsonPrimitive.content)
    assertFalse(frame.getValue("success").jsonPrimitive.boolean)
    assertEquals("Gesture was cancelled", frame.getValue("error").jsonPrimitive.content)
    assertFalse(frame.containsKey("gestureTimeMs"))
  }

  @Test
  fun `completed tap publishes the settled hierarchy before the tap result`() {
    host.settled = ViewHierarchy()
    controller.performTapCoordinates(
      RequestTapCoordinates("tap", 5.0, 6.0, 10L, null, displayId = 3),
    )
    completeLast(10L)
    assertEquals(listOf<Int?>(3), host.settledDisplays)
    assertEquals(listOf("hierarchy", "tap_coordinates_result"), events)
    assertTrue(sender.frames.single().getValue("success").jsonPrimitive.boolean)
  }

  @Test
  fun `stale frame context fails before dispatching`() {
    controller.performSwipe(RequestSwipe("stale", 1.0, 2.0, 3.0, 4.0, 250L, "epoch:0", null))
    assertTrue(host.dispatches.isEmpty())
    val frame = sender.frames.single()
    assertFalse(frame.getValue("success").jsonPrimitive.boolean)
    assertEquals(
      "Stale frame context; observe a fresh frame before retrying",
      frame.getValue("error").jsonPrimitive.content,
    )
  }

  @Test
  fun `results are dropped while the server is not running`() {
    sender.running = false
    controller.performTwoFingerSwipe(
      RequestTwoFingerSwipe("multi", 1.0, 2.0, 3.0, 4.0, 100L, 20, null, 3),
    )
    assertEquals(3, host.dispatches.single().gesture.strokeCount)
    completeLast(100L)
    assertTrue(sender.frames.isEmpty())
  }

  @Test
  @Config(sdk = [25])
  fun `streamed gestures are refused before API 26`() {
    controller.startStream(RequestGestureStart("start", "g", 1.0, 2.0, null), requester = null)
    assertEquals(1, host.forgets)
    assertTrue(host.dispatches.isEmpty())
    val frame = sender.frames.single()
    assertEquals("swipe_result", frame.getValue("type").jsonPrimitive.content)
    assertEquals(
      "Streaming gestures require Android 8.0 (API 26)",
      frame.getValue("error").jsonPrimitive.content,
    )
  }
}
