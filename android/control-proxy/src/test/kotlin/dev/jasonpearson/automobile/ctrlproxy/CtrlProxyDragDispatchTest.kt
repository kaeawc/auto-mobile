package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.PathMeasure
import android.graphics.RectF
import android.os.Handler
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import java.time.Duration
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
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
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowAccessibilityService
import org.robolectric.shadows.ShadowSystemClock
import org.robolectric.util.ReflectionHelpers

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30], shadows = [DragAccessibilityServiceShadow::class])
class CtrlProxyDragDispatchTest {
  private lateinit var fixture: CtrlProxyGestureServiceFixture
  private lateinit var perf: PerfProvider
  private val frames = mutableListOf<String>()
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
    ReflectionHelpers.setField(fixture.service, "perfProvider", perf)
    fixture.service.dragResultReporter = { id, outcome ->
      frames.add(
        dragResultFrame(
          id,
          outcome.completed,
          outcome.error,
          outcome.totalTimeMs,
          outcome.gestureTimeMs,
          null,
        ),
      )
    }
  }

  @After fun tearDown() = fixture.close()

  @Test
  fun `default drag dispatches one stroke per phase and reports only final completion`() {
    drag()
    repeat(2) { index ->
      assertTrue(frames.isEmpty())
      shadow.complete()
      if (index == 0) fixture.advanceDragWait()
    }
    assertTrue(frames.isEmpty())
    assertEquals(3, shadow.attempts.size)
    assertChain(listOf(true, true, false))
    val press = shadow.attempts.first().gesture.getStroke(0)
    val pressPath = PathMeasure(press.path, false)
    assertEquals(600L, press.duration)
    assertEquals(0f, pressPath.length, 0f)
    val bounds = RectF()
    press.path.computeBounds(bounds, false)
    assertEquals(RectF(10f, 20f, 10f, 20f), bounds)
    shadow.attempts[1].gesture.getStroke(0).path.computeBounds(bounds, false)
    assertEquals(RectF(10f, 20f, 100f, 200f), bounds)
    shadow.complete()
    val result = Json.parseToJsonElement(frames.single()).jsonObject
    assertEquals("drag_result", result.getValue("type").jsonPrimitive.content)
    assertTrue(result.getValue("success").jsonPrimitive.boolean)
    assertTrue(result.containsKey("gestureTimeMs"))
    assertTrue(result.getValue("totalTimeMs").jsonPrimitive.content.toLong() >= 0L)
    assertTrue(
      result.getValue("totalTimeMs").jsonPrimitive.content.toLong() >=
        result.getValue("gestureTimeMs").jsonPrimitive.content.toLong(),
    )
    val root = requireNotNull(perf.flush("drag")).jsonArray.single().jsonObject
    assertEquals("performDrag", root.getValue("name").jsonPrimitive.content)
    assertEquals(
      listOf("buildPath", "dispatchGesture"),
      root.getValue("children").jsonArray.map {
        it.jsonObject.getValue("name").jsonPrimitive.content
      },
    )
  }

  @Test
  fun `instant press completion waits before travel and then succeeds`() {
    drag()
    shadow.complete(0L)
    assertTrue(frames.isEmpty())
    assertEquals(1, shadow.attempts.size)
    val timer = fixture.service.dragDeadline as FakeGestureDeadline
    assertEquals(600L, timer.tasks.last().delayMs)
    ShadowSystemClock.advanceBy(Duration.ofMillis(600L))
    timer.expire()
    assertEquals(2, shadow.attempts.size)
    repeat(2) { shadow.complete() }
    assertChain(listOf(true, true, false))
    val result = Json.parseToJsonElement(frames.single()).jsonObject
    assertTrue(result.getValue("success").jsonPrimitive.boolean)
    assertTrue(timer.tasks.all { it.cancelled })
  }

  @Test
  fun `no hold and zero press variants finish with one lifted pointer`() {
    for ((press, hold) in listOf(500L to 0L, 0L to 100L, 0L to 0L)) {
      shadow.attempts.clear()
      frames.clear()
      drag(press, hold)
      val count = 1 + (if (press > 0) 1 else 0) + (if (hold > 0) 1 else 0)
      repeat(count - 1) { index ->
        shadow.complete()
        if (index == 0 && press > 0) fixture.advanceDragWait()
      }
      assertChain(List(count) { it < count - 1 })
      assertTrue(frames.isEmpty())
      shadow.complete()
      assertTrue(
        Json.parseToJsonElement(frames.single()).jsonObject["success"]!!.jsonPrimitive.boolean,
      )
    }
  }

  @Test
  fun `mid chain cancellation dispatches terminating continuation and failed drag result`() {
    drag()
    shadow.complete()
    fixture.advanceDragWait()
    shadow.cancel()
    assertReleaseThenFailure()
  }

  @Test
  fun `mid chain rejected dispatch sends terminating continuation and failed drag result`() {
    drag()
    shadow.failureOnAttempt = 2
    shadow.complete()
    fixture.advanceDragWait()
    assertReleaseThenFailure(rejected = true)
  }

  @Test
  fun `mid chain dispatch exception sends terminating continuation and failed drag result`() {
    drag()
    shadow.failureOnAttempt = 2
    shadow.throwOnFailure = true
    shadow.complete()
    fixture.advanceDragWait()
    assertReleaseThenFailure(rejected = true)
  }

  @Test
  fun `mid chain timeout sends terminating continuation and failed drag result`() {
    drag()
    shadow.complete()
    fixture.advanceDragWait()
    (fixture.service.dragDeadline as FakeGestureDeadline).expire()
    assertReleaseThenFailure()
  }

  @Test
  fun `stale frame context rejects before injecting a pointer`() {
    fixture.actions.requestDrag(
      "stale",
      10.0,
      20.0,
      100.0,
      200.0,
      500L,
      1_000L,
      100L,
      fixture.freshFrameContext() + ":stale",
      7,
    )
    assertTrue(shadow.attempts.isEmpty())
  }

  @Test
  @Config(sdk = [25])
  fun `pre API 26 keeps a single legacy stroke`() {
    fixture.actions.requestDrag("legacy", 10.0, 20.0, 100.0, 200.0, 500L, 1_000L, 100L)
    val description = shadow.attempts.single().gesture
    assertEquals(1, description.strokeCount)
    assertEquals(1_600L, description.getStroke(0).duration)
    shadow.complete()
    assertTrue(
      Json.parseToJsonElement(frames.single()).jsonObject["success"]!!.jsonPrimitive.boolean,
    )
  }

  private fun drag(press: Long = 600L, hold: Long = 100L) {
    fixture.actions.requestDrag(
      "drag",
      10.0,
      20.0,
      100.0,
      200.0,
      press,
      300L,
      hold,
      fixture.freshFrameContext(),
      7,
    )
  }

  private fun assertChain(continuations: List<Boolean>, rejected: Boolean = false) {
    assertEquals(continuations.size, shadow.attempts.size)
    for ((index, attempt) in shadow.attempts.withIndex()) {
      assertEquals(7, attempt.gesture.displayId)
      assertEquals(1, attempt.gesture.strokeCount)
      val stroke = attempt.gesture.getStroke(0)
      assertEquals(0L, stroke.startTime)
      assertEquals(continuations[index], stroke.willContinue())
      val parentId = ReflectionHelpers.callInstanceMethod<Int>(stroke, "getContinuedStrokeId")
      if (index == 0) assertEquals(-1, parentId)
      else {
        val parentIndex = if (rejected && index == 2) 0 else index - 1
        val previous = shadow.attempts[parentIndex].gesture.getStroke(0)
        assertEquals(ReflectionHelpers.callInstanceMethod<Int>(previous, "getId"), parentId)
      }
    }
  }

  private fun assertReleaseThenFailure(rejected: Boolean = false) {
    assertEquals(3, shadow.attempts.size)
    assertChain(listOf(true, true, false), rejected)
    assertTrue(frames.isEmpty())
    shadow.complete()
    val result = Json.parseToJsonElement(frames.single()).jsonObject
    assertFalse(result.getValue("success").jsonPrimitive.boolean)
    assertTrue(result.getValue("error").jsonPrimitive.content.isNotEmpty())
    assertFalse(result.containsKey("gestureTimeMs"))
  }
}

/** Record attempted dispatches too, so refusal/exception cleanup is visible without a service. */
@Implements(AccessibilityService::class)
class DragAccessibilityServiceShadow : ShadowAccessibilityService() {
  data class Attempt(
    val gesture: GestureDescription,
    val callback: AccessibilityService.GestureResultCallback,
  )

  val attempts = mutableListOf<Attempt>()
  var failureOnAttempt: Int? = null
  var throwOnFailure = false

  @Implementation
  override fun dispatchGesture(
    gesture: GestureDescription,
    callback: AccessibilityService.GestureResultCallback?,
    handler: Handler?,
  ): Boolean {
    attempts.add(Attempt(gesture, requireNotNull(callback)))
    if (attempts.size == failureOnAttempt) {
      if (throwOnFailure) throw IllegalStateException("Injected dispatch exception")
      return false
    }
    return super.dispatchGesture(gesture, callback, handler)
  }

  fun complete(elapsedMs: Long = attempts.last().gesture.getStroke(0).duration) {
    ShadowSystemClock.advanceBy(Duration.ofMillis(elapsedMs))
    attempts.last().let { it.callback.onCompleted(it.gesture) }
  }

  fun cancel() = attempts.last().let { it.callback.onCancelled(it.gesture) }
}
