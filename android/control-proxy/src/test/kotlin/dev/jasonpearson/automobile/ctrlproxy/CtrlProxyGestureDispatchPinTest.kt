package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Path
import android.graphics.PathMeasure
import android.graphics.RectF
import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.RequestPinch
import dev.jasonpearson.automobile.protocol.RequestSwipe
import dev.jasonpearson.automobile.protocol.RequestTapCoordinates
import dev.jasonpearson.automobile.protocol.RequestTwoFingerSwipe
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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

/**
 * Pins the stroke shapes, timings and terminal outcomes of the one-shot gestures (tap, long press,
 * double tap, swipe, multi-finger swipe, pinch) through the real service entry points, so moving
 * the gesture code out of [CtrlProxy] cannot change what reaches `dispatchGesture`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30], shadows = [DragAccessibilityServiceShadow::class])
class CtrlProxyGestureDispatchPinTest {
  private lateinit var fixture: CtrlProxyGestureServiceFixture
  private lateinit var perf: PerfProvider
  private val shadow: DragAccessibilityServiceShadow
    get() = fixture.shadow as DragAccessibilityServiceShadow

  @Before
  fun setUp() {
    fixture = CtrlProxyGestureServiceFixture()
    perf =
      PerfProvider.createForTesting(
        object : TimeProvider {
          override fun currentTimeMillis() = 0L
        },
      )
    fixture.usePerfProvider(perf)
    ShadowLog.clear()
  }

  @After fun tearDown() = fixture.close()

  @Test
  fun `swipe is one straight stroke of the requested duration`() = runTest {
    swipe()
    val gesture = shadow.attempts.single().gesture
    assertEquals(1, gesture.strokeCount)
    val stroke = gesture.getStroke(0)
    assertEquals(0L, stroke.startTime)
    assertEquals(250L, stroke.duration)
    assertFalse(stroke.willContinue())
    assertEquals(RectF(100f, 120f, 200f, 320f), bounds(stroke.path))
  }

  @Test
  fun `tap and long press are one stationary stroke of the requested duration`() = runTest {
    for (duration in listOf(10L, 1_000L)) {
      shadow.attempts.clear()
      tap(duration)
      val gesture = shadow.attempts.single().gesture
      assertEquals(1, gesture.strokeCount)
      val stroke = gesture.getStroke(0)
      assertEquals(0L, stroke.startTime)
      assertEquals(duration, stroke.duration)
      assertEquals(0f, PathMeasure(stroke.path, false).length, 0f)
      assertEquals(RectF(40f, 60f, 40f, 60f), bounds(stroke.path))
      shadow.cancel()
    }
  }

  @Test
  fun `double tap places the second press a fixed 100ms after the first release`() = runTest {
    fixture.actions.requestDoubleTapCoordinates("double", 40.0, 60.0, null, null)
    val gesture = shadow.attempts.single().gesture
    assertEquals(2, gesture.strokeCount)
    assertEquals(0L, gesture.getStroke(0).startTime)
    assertEquals(50L, gesture.getStroke(0).duration)
    assertEquals(150L, gesture.getStroke(1).startTime)
    assertEquals(50L, gesture.getStroke(1).duration)
  }

  @Test
  fun `multi finger swipe dispatches one parallel stroke per finger`() = runTest {
    multiFinger(fingerCount = 3, x2 = 300.0, y2 = 400.0)
    val gesture = shadow.attempts.single().gesture
    val expected =
      computeMultiFingerStrokes(MultiFingerStrokeGeometry(100.0, 200.0, 300.0, 400.0, 20, 3))
    assertEquals(3, gesture.strokeCount)
    expected.forEachIndexed { index, finger ->
      val stroke = gesture.getStroke(index)
      assertEquals(0L, stroke.startTime)
      assertEquals(150L, stroke.duration)
      assertEquals(
        rect(finger.startX, finger.startY, finger.endX, finger.endY),
        bounds(stroke.path),
      )
    }
  }

  @Test
  fun `stationary multi finger stroke is a bare press like a tap`() = runTest {
    multiFinger(fingerCount = 2, x2 = 100.0, y2 = 200.0)
    val gesture = shadow.attempts.single().gesture
    assertEquals(2, gesture.strokeCount)
    repeat(2) { assertEquals(0f, PathMeasure(gesture.getStroke(it).path, false).length, 0f) }
  }

  @Test
  fun `pinch dispatches two simultaneous finger strokes between the pinch points`() = runTest {
    pinch("pinch")
    val gesture = shadow.attempts.single().gesture
    val points = computePinchPoints(300.0, 400.0, 100.0, 300.0, 0f)
    assertEquals(2, gesture.strokeCount)
    val first = gesture.getStroke(0)
    val second = gesture.getStroke(1)
    listOf(first, second).forEach {
      assertEquals(0L, it.startTime)
      assertEquals(400L, it.duration)
    }
    assertEquals(
      rect(points.startX1, points.startY1, points.endX1, points.endY1),
      bounds(first.path),
    )
    assertEquals(
      rect(points.startX2, points.startY2, points.endX2, points.endY2),
      bounds(second.path),
    )
  }

  @Test
  fun `cancelled swipe closes the perf block with build and dispatch phases`() = runTest {
    swipe()
    shadow.cancel()
    val root = requireNotNull(perf.flush(null)).jsonArray.single().jsonObject
    assertEquals("performSwipe", root.getValue("name").jsonPrimitive.content)
    assertEquals(
      listOf("buildPath", "dispatchGesture"),
      root.getValue("children").jsonArray.map {
        it.jsonObject.getValue("name").jsonPrimitive.content
      },
    )
    assertLogged(Log.WARN, "Swipe failed after", "Gesture was cancelled")
  }

  @Test
  fun `rejected pinch dispatch reports a failed dispatch`() = runTest {
    shadow.failureOnAttempt = 1
    pinch("rejected")
    assertLogged(Log.ERROR, "Failed to dispatch performPinch gesture (requestId=rejected)")
    assertLogged(Log.WARN, "Pinch failed after", "Failed to dispatch gesture")
  }

  @Test
  fun `throwing tap dispatch reports the exception`() = runTest {
    shadow.failureOnAttempt = 1
    shadow.throwOnFailure = true
    tap(10L)
    assertLogged(Log.ERROR, "Error dispatching performTapCoordinates gesture (requestId=tap)")
    assertLogged(Log.WARN, "Tap failed after", "Injected dispatch exception")
  }

  @Test
  fun `stale swipe frame context fails without injecting a pointer`() = runTest {
    fixture.actions.requestSwipe(
      RequestSwipe(
        requestId = "stale",
        x1 = 100.0,
        y1 = 120.0,
        x2 = 200.0,
        y2 = 320.0,
        duration = 250L,
        frameContext = fixture.freshFrameContext() + ":stale",
        displayId = null,
      ),
    )
    assertTrue(shadow.attempts.isEmpty())
  }

  @Test
  fun `cancelled multi finger swipe reports a failed two finger swipe`() = runTest {
    multiFinger(fingerCount = 2, x2 = 300.0, y2 = 400.0)
    shadow.cancel()
    assertLogged(Log.WARN, "Two-finger swipe failed after", "Gesture was cancelled")
  }

  private suspend fun swipe() {
    fixture.actions.requestSwipe(
      RequestSwipe(
        requestId = "swipe",
        x1 = 100.0,
        y1 = 120.0,
        x2 = 200.0,
        y2 = 320.0,
        duration = 250L,
        frameContext = fixture.freshFrameContext(),
        displayId = null,
      ),
    )
  }

  private suspend fun tap(duration: Long) {
    fixture.actions.requestTapCoordinates(
      RequestTapCoordinates(
        requestId = "tap",
        x = 40.0,
        y = 60.0,
        duration = duration,
        frameContext = null,
        displayId = null,
      ),
    )
  }

  private suspend fun pinch(requestId: String) {
    fixture.actions.requestPinch(
      RequestPinch(
        requestId = requestId,
        centerX = 300.0,
        centerY = 400.0,
        distanceStart = 100.0,
        distanceEnd = 300.0,
        rotationDegrees = 0f,
        duration = 400L,
        displayId = null,
      ),
    )
  }

  private suspend fun multiFinger(fingerCount: Int, x2: Double, y2: Double) {
    fixture.actions.requestTwoFingerSwipe(
      RequestTwoFingerSwipe(
        requestId = "multi",
        x1 = 100.0,
        y1 = 200.0,
        x2 = x2,
        y2 = y2,
        duration = 150L,
        offset = 20,
        displayId = null,
        fingerCount = fingerCount,
      ),
    )
  }

  private fun rect(x1: Float, y1: Float, x2: Float, y2: Float) =
    RectF(minOf(x1, x2), minOf(y1, y2), maxOf(x1, x2), maxOf(y1, y2))

  private fun bounds(path: Path): RectF = RectF().also { path.computeBounds(it, true) }

  private fun assertLogged(level: Int, prefix: String, contains: String = "") {
    val logs = ShadowLog.getLogsForTag("CtrlProxy")
    assertTrue(
      "expected a level-$level log starting '$prefix' containing '$contains'; got " +
        logs.map { it.msg },
      logs.any { it.type == level && it.msg.startsWith(prefix) && contains in it.msg },
    )
  }
}
