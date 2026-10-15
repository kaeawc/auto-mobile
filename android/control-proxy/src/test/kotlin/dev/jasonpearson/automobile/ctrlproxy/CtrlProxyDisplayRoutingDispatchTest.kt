package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.RectF
import android.view.Display
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.RequestDrag
import dev.jasonpearson.automobile.protocol.RequestGestureStart
import dev.jasonpearson.automobile.protocol.RequestPinch
import dev.jasonpearson.automobile.protocol.RequestSwipe
import dev.jasonpearson.automobile.protocol.RequestTapCoordinates
import dev.jasonpearson.automobile.protocol.RequestTwoFingerSwipe
import dev.jasonpearson.automobile.protocol.WebSocketRequest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog
import org.robolectric.util.ReflectionHelpers

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class CtrlProxyDisplayRoutingDispatchTest {
  private lateinit var fixture: CtrlProxyGestureServiceFixture

  @Before
  fun setUp() {
    fixture = CtrlProxyGestureServiceFixture()
  }

  @After
  fun tearDown() {
    fixture.close()
  }

  @Test
  fun `double tap wire request dispatches two fixed gap strokes together`() = runTest {
    val json = Json { ignoreUnknownKeys = true }
    val request =
      json.decodeFromString<WebSocketRequest>(
        """{"type":"request_tap_coordinates","requestId":"double","x":100,"y":100,"duration":50,"doubleTap":true}""",
      )
    CtrlProxyMessageHandler(fixture.actions).handleMessage(request)
    val dispatch = fixture.shadow.gesturesDispatched.single().description()
    assertEquals(2, dispatch.strokeCount)
    assertEquals(0L, dispatch.getStroke(0).startTime)
    assertEquals(50L, dispatch.getStroke(0).duration)
    assertEquals(150L, dispatch.getStroke(1).startTime)
    assertEquals(50L, dispatch.getStroke(1).duration)
    fixture.cancelLastStroke()
  }

  @Test
  fun `tap dispatches to explicit displays and defaults when absent`() = runTest {
    assertAtomicRouting(strokeCount = 1, duration = 10L) { displayId ->
      fixture.actions.requestTapCoordinates(
        RequestTapCoordinates(
          requestId = "tap",
          x = 100.0,
          y = 100.0,
          duration = 10L,
          frameContext = null,
          displayId = displayId,
        ),
      )
    }
  }

  @Test
  fun `completed tap refreshes the requested display including absent display`() = runTest {
    val optionsSeen = mutableListOf<HierarchySnapshotOptions>()
    // The first read starts the wait; every later read skips the initial wait and satisfies
    // quiescence, without reaching the real delay or the max-wait warning path.
    var reads = 0
    val time =
      object : TimeProvider {
        override fun currentTimeMillis(): Long = if (reads++ == 0) 1_000L else 1_250L
      }
    ReflectionHelpers.setField(
      fixture.service,
      "hierarchyDebouncer",
      HierarchyDebouncer(
        scope = ReflectionHelpers.getField<CoroutineScope>(fixture.service, "serviceScope"),
        timeProvider = time,
        extractHierarchy = { _, snapshotOptions ->
          optionsSeen.add(snapshotOptions)
          null
        },
      ),
    )
    for (displayId in listOf(2, null)) {
      reads = 0
      fixture.actions.requestTapCoordinates(
        RequestTapCoordinates(
          requestId = "tap",
          x = 100.0,
          y = 100.0,
          duration = 10L,
          frameContext = null,
          displayId = displayId,
        ),
      )
      fixture.completeLastStroke()
      assertEquals(displayId, optionsSeen.last().displayId)
    }
    assertEquals(2, optionsSeen.size)
  }

  @Test
  fun `long press dispatches to explicit displays and defaults when absent`() = runTest {
    assertAtomicRouting(strokeCount = 1, duration = 1000L) { displayId ->
      fixture.actions.requestTapCoordinates(
        RequestTapCoordinates(
          requestId = "long-press",
          x = 100.0,
          y = 100.0,
          duration = 1000L,
          frameContext = null,
          displayId = displayId,
        ),
      )
    }
  }

  @Test
  fun `swipe dispatches to explicit displays and defaults when absent`() = runTest {
    assertAtomicRouting(strokeCount = 1) { displayId ->
      fixture.actions.requestSwipe(
        RequestSwipe(
          requestId = "swipe",
          x1 = 100.0,
          y1 = 100.0,
          x2 = 200.0,
          y2 = 200.0,
          duration = 50L,
          frameContext = null,
          displayId = displayId,
        ),
      )
    }
  }

  @Test
  fun `two finger swipe dispatches to explicit displays and defaults when absent`() = runTest {
    assertAtomicRouting(strokeCount = 2) { displayId ->
      fixture.actions.requestTwoFingerSwipe(
        RequestTwoFingerSwipe(
          requestId = "two-finger",
          x1 = 100.0,
          y1 = 100.0,
          x2 = 200.0,
          y2 = 200.0,
          duration = 50L,
          offset = 20,
          displayId = displayId,
        ),
      )
    }
  }

  @Test
  fun `drag dispatches to explicit displays and defaults when absent`() = runTest {
    assertChainedRouting(segmentCount = 3) { displayId ->
      fixture.actions.requestDrag(
        RequestDrag(
          requestId = "drag",
          x1 = 100.0,
          y1 = 100.0,
          x2 = 200.0,
          y2 = 200.0,
          pressDurationMs = 10L,
          dragDurationMs = 50L,
          holdDurationMs = 10L,
          frameContext = null,
          displayId = displayId,
        ),
      )
    }
  }

  @Test
  fun `pinch dispatches to explicit displays and defaults when absent`() = runTest {
    assertAtomicRouting(strokeCount = 2) { displayId ->
      fixture.actions.requestPinch(
        RequestPinch(
          requestId = "pinch",
          centerX = 100.0,
          centerY = 100.0,
          distanceStart = 20.0,
          distanceEnd = 40.0,
          rotationDegrees = 30f,
          duration = 50L,
          displayId = displayId,
        ),
      )
    }
  }

  @Test
  fun `stream retains non default display through press move and lift`() = runTest {
    assertStreamingRouting(2)
  }

  @Test
  fun `stream retains explicit default display through press move and lift`() = runTest {
    assertStreamingRouting(Display.DEFAULT_DISPLAY)
  }

  @Test
  fun `stream defaults display when absent through press move and lift`() = runTest {
    assertStreamingRouting(null)
  }

  @Test
  @Config(sdk = [29])
  fun `API 29 rejects secondary display but accepts zero and absent display`() = runTest {
    fixture.actions.requestSwipe(
      RequestSwipe(
        requestId = "unsupported",
        x1 = 100.0,
        y1 = 100.0,
        x2 = 200.0,
        y2 = 200.0,
        duration = 50L,
        frameContext = null,
        displayId = 2,
      ),
    )
    assertTrue(fixture.shadow.gesturesDispatched.isEmpty())
    assertTrue(
      ShadowLog.getLogs().any {
        it.msg == "Error performing swipe" &&
          it.throwable is IllegalArgumentException &&
          it.throwable.message == "Gesture display routing requires Android 11 (API 30)"
      },
    )
    for (displayId in listOf(Display.DEFAULT_DISPLAY, null)) {
      val before = fixture.shadow.gesturesDispatched.size
      fixture.actions.requestSwipe(
        RequestSwipe(
          requestId = "supported",
          x1 = 100.0,
          y1 = 100.0,
          x2 = 200.0,
          y2 = 200.0,
          duration = 50L,
          frameContext = null,
          displayId = displayId,
        ),
      )
      assertEquals(before + 1, fixture.shadow.gesturesDispatched.size)
      // API 29 has no getDisplayId. A successfully built and dispatched stroke proves the fallback.
      assertEquals(1, fixture.shadow.gesturesDispatched.last().description().strokeCount)
      fixture.cancelLastStroke()
    }
  }

  private suspend fun assertAtomicRouting(
    strokeCount: Int,
    duration: Long? = null,
    request: suspend (Int?) -> Unit,
  ) {
    for (displayId in listOf(2, Display.DEFAULT_DISPLAY, null)) {
      val before = fixture.shadow.gesturesDispatched.size
      request(displayId)
      assertEquals(before + 1, fixture.shadow.gesturesDispatched.size)
      val description = fixture.shadow.gesturesDispatched.last().description()
      assertEquals(displayId ?: Display.DEFAULT_DISPLAY, description.displayId)
      assertEquals(strokeCount, description.strokeCount)
      duration?.let { assertEquals(it, description.getStroke(0).duration) }
      fixture.cancelLastStroke()
    }
  }

  private suspend fun assertChainedRouting(segmentCount: Int, request: suspend (Int?) -> Unit) {
    for (displayId in listOf(2, Display.DEFAULT_DISPLAY, null)) {
      val before = fixture.shadow.gesturesDispatched.size
      request(displayId)
      repeat(segmentCount) { index ->
        assertEquals(before + index + 1, fixture.shadow.gesturesDispatched.size)
        val description = fixture.shadow.gesturesDispatched.last().description()
        assertEquals(displayId ?: Display.DEFAULT_DISPLAY, description.displayId)
        assertEquals(1, description.strokeCount)
        assertEquals(index < segmentCount - 1, description.getStroke(0).willContinue())
        fixture.completeLastStroke()
        if (index == 0) fixture.advanceDragWait()
      }
      assertEquals(before + segmentCount, fixture.shadow.gesturesDispatched.size)
    }
  }

  private suspend fun assertStreamingRouting(displayId: Int?) {
    val actions = fixture.actions
    actions.requestGestureStart(
      RequestGestureStart(
        requestId = "start",
        gestureId = "stream",
        x = 100.0,
        y = 100.0,
        displayId = displayId,
      ),
    )
    assertEquals(1, fixture.shadow.gesturesDispatched.size)
    actions.requestGestureMove("move", "stream", 150.0, 150.0)
    assertEquals(1, fixture.shadow.gesturesDispatched.size)
    fixture.completeLastStroke()
    assertEquals(2, fixture.shadow.gesturesDispatched.size)
    actions.requestGestureEnd("end", "stream", 200.0, 200.0, false)
    assertEquals(2, fixture.shadow.gesturesDispatched.size)
    fixture.completeLastStroke()
    assertEquals(3, fixture.shadow.gesturesDispatched.size)

    val descriptions = fixture.shadow.gesturesDispatched.map { it.description() }
    descriptions.forEach {
      assertEquals(displayId ?: Display.DEFAULT_DISPLAY, it.displayId)
      assertEquals(1, it.strokeCount)
    }
    val strokes = descriptions.map { it.getStroke(0) }
    assertTrue(strokes[0].willContinue())
    assertTrue(strokes[1].willContinue())
    assertFalse(strokes[2].willContinue())
    strokes.zipWithNext().forEach { (previous, next) ->
      assertEquals(
        ReflectionHelpers.getField<Int>(previous, "mId"),
        ReflectionHelpers.getField<Int>(next, "mContinuedStrokeId"),
      )
    }
    val bounds = RectF()
    strokes[1].path.computeBounds(bounds, true)
    assertEquals(RectF(100f, 100f, 150f, 150f), bounds)
    strokes[2].path.computeBounds(bounds, true)
    assertEquals(RectF(150f, 150f, 200f, 200f), bounds)
    fixture.completeLastStroke()
    assertEquals(3, fixture.shadow.gesturesDispatched.size)
    assertEquals(
      listOf(
        CtrlProxyGestureServiceFixture.Ack("start", true, null),
        CtrlProxyGestureServiceFixture.Ack("move", true, null),
        CtrlProxyGestureServiceFixture.Ack("end", true, null),
      ),
      fixture.acks,
    )
  }
}
